# Replies

This page is for deployers turning on reply handling, and for contributors changing how replies are triaged, drafted or sent. It covers what happens to a reply from the moment it is recorded until it is answered: semantic triage and each intent's side effects, the meeting qualifier, what drafts are written from, approving and sending from the mailbox, the reply-owed reminders, mailbox draft mirroring, the operator commands, and the flags and jobs involved. Connecting a mailbox and the deterministic classification that runs first are in [INBOX.md](INBOX.md). The code lives in `packages/core/src/replies/` (`@gtm-agents/core/replies`), and the one definition of a positive reply in `packages/core/src/metrics/` (`@gtm-agents/core/metrics`).

In this version no reply is ever sent without a person's approval.

## What happens to a reply

```
inbox intake records the message (classification, body in blob storage)       docs/INBOX.md
  -> triage (every 15 minutes): the triage model reads the sender's own text   replies:triage_enabled
  -> routing: each intent's side effects, claimed once
  -> meeting qualifier (interested, question): book, ask or pass
  -> drafting: the writer model, the quality gate, a pending draft              replies:drafting_enabled
  -> approval request in the operator chat, bound to the draft's digest
       |                                       |
       v                                       v
  mirrored into the mailbox's drafts           approved in chat
  (replies:mirror_enabled); the operator       -> freshness checks -> send lock
  edits and sends there; reconciliation        -> the send function, path "reply", through
  records what happened                           the warm mailbox on the thread (replies:send_enabled)
       \                                       /
        +-> answered: responded, autonomy evidence, ledger credit already done
  meanwhile: reminders at 15 minutes, 2 hours, 4 hours, then each morning      replies:reminders_enabled
```

Every step is behind its own flag, all off by default, so you can turn them on one at a time: triage first, then reminders, then drafting, then mirroring or sending.

## Triage

The triage job reads human mail that has no intent yet: classification `reply`, `new_inquiry` or `unclassified`, status new or notified, under 14 days old, oldest first.

- **What the model sees.** The body is read once from blob storage, quoted history is stripped ("On ... wrote:", forwarded and original-message headers, `>` lines), and the rest is capped at 4,000 characters. It is sanitized (injection patterns redacted) and fenced as untrusted data in the user turn. The system prompt holds only fixed instructions and your company's name and product description from `gtm.config.ts`.
- **What it returns.** One intent with a confidence from 0 to 1, validated with zod, plus quotes the qualifier uses: the sender's most telling sentence, where they describe a problem, a timing reason, a proposed time. Each quote is kept only if it appears word for word in the sender's text, so the model cannot put words in their mouth.
- **When it fails.** No model configured, no price, the budget refusing, an error or an answer that does not parse: the message stays untriaged with no side effects. Each message gets at most one model attempt per UTC day; an attempt that never reached a model is released and retried on the next run.
- **What it costs.** The `triage` role, priced in `models.pricing`. Every call is checked against the budget first (the job's daily cap, the global limits, the run ceiling) and recorded in the cost ledger.

The result is stored on the row: the intent in `inbound_emails.intent`, the rest as JSON in `inbound_emails.triage`.

## The intents and what each does

| Intent | Means | What happens |
|---|---|---|
| `interested` | Wants a demo, a call, pricing or a next step | At 0.7 or more: the open deal moves one stage (never past `demo_scheduled`), an earlier decline hold is cleared. Qualifier, then a draft |
| `question` | Asks a factual question | As interested. A question at 0.8 or more answered with approved facts is filed under `reply_question` |
| `objection` | Raises a concern that could be answered | At 0.7 or more the deal moves one stage. Filed in the objection library for curation. One answer per contact: a second objection gets no draft |
| `warm` | Open, but sets no next step | A short draft that leaves the door open |
| `referral` | Brings in a colleague | At 0.7 or more: up to 3 colleagues from the message's To and Cc headers, at the sender's account, are added as warming contacts, never cold. Suppressed and erased addresses are skipped. A draft to the sender |
| `not_a_fit` | Declines | At 0.8 or more: the deal closes lost (`no_need`), and with no opt-out wording the account is held for 90 days (`contacts.declined_at`, read by cold selection). A short decline (40 words or fewer, no question) is archived without a draft; a longer one gets a brief thank-you draft |
| `opt_out` | Asks to stop | At 0.8 or more: the sender is opted out (`optOutAddress`: suppressed, warmth `opted_out`, sequences stopped, queued sends cancelled), the deal closes lost, the message is archived. No draft |
| `auto_reply`, `spam`, `noise` | Machines, junk, bare acknowledgements | At 0.8 or more: archived. No draft |
| `unclear` | Cannot tell | Left to you. No draft |

For every human reply from a known contact (not opt-outs, automatic replies, spam or noise), routing also moves warmth forward (positive intents to `engaged`, warm and objection to `warming`; never backwards), credits the send ledger, and stops the contact's and account's sequences again (intake already stops them; stopping twice changes nothing).

**The send ledger.** A reply is credited to the contact's latest first touch sent in the 60 days before it. `replied_at` is the reply's own `received_at`, never the time the job ran, and out-of-order replies keep the earliest. `reply_after_step` is the highest step actually sent between the first touch and the reply. `positive_reply_at` is set from the reply's timestamp when the reply is positive.

**A positive reply** has one definition, in `metrics/positive-reply.ts`, used by every report and experiment: a triage intent of interested, question or referral, or a non-cancelled, attributed meeting first seen after the send. Opt-outs, unsubscribes, automatic replies, spam and noise never count as replies; "not a fit" is a reply but never positive. Calendar sync and attribution are a later milestone, so for now only the intent half applies.

**Failures.** Every side effect is claimed in the effects ledger under the message, so a re-run never repeats one. Each is bookkeeping, logged and dropped on failure, except the opt-out: it is a compliance control, so when it fails routing is marked unfinished and the next run retries it (for 3 days) without repeating the effects that held.

## The meeting qualifier

For an interested reply or a question from a known contact, four checks, each a pass or a gap:

| Check | Passes when |
|---|---|
| Problem | Triage found a verbatim quote of them describing a problem or need |
| Role | The contact's title in your CRM matches a persona in the brain (`personas` component). Never what the email says |
| Timing | A verbatim reason or timeline, a meeting request, or a proposed time |
| Fit | The account's fit score is at least 5, or the account is unscored |

No gaps books. A proposed time always books, and forces the draft to confirm that time, say a calendar invite will follow and include no link. A meeting request with at most one gap books. Three or more gaps pass (no booking language). Anything else asks one question about the first gap. The decision is saved in `reply_qualifications`. Booking itself (calendars, invites) is a later milestone; a booked draft offers `sending.bookingUrl` when you set one.

## What drafts are written from

The writer (model role `writer`) sees, in the system prompt, only what you approved:

- the brain's `replies` slice: `facts`, `objections`, `competitors`, `voice` and `stack` ([BRAIN-SCHEMA.md](BRAIN-SCHEMA.md)). The `commercial` component is never served to reply drafting, so no price reaches it;
- active reply assets (`reply_assets`: a demo, a sample, a walkthrough, each with an https URL) and `sending.bookingUrl`, as the only links it may use;
- fixed rules: plain text, no em or en dashes, 20 to 120 words, sign off with `agent.name`, never state a price, discount, offer, customer name or figure the approved material does not contain.

In the user turn it gets this message's instructions (the qualifier's rule, the asset rule, and up to two approved objection answers that fit), the contact's first name from your CRM, and the message itself, fenced as untrusted data. Approved objection answers come from the brain's `objections` component and from rows in the `objections` table whose `approved_digest` matches `objectionAnswerDigest` of their current pattern and response. Someone asking to see the product gets your demo asset instead of a call offer.

The model writes only the body. The subject is "Re: <their subject>" and the recipient is the contact's stored address. Then the deterministic quality gate and the content lint run ([OUTREACH.md](OUTREACH.md) lists the codes), with links allowed only to the assets and the booking URL and claims checked against the approved facts and answers, plus one more block: a link in a reply to someone who proposed a time. A block means no draft is saved and you get a notice; holds are listed in the approval notice for you to weigh.

A saved draft is kind `reply`, status `pending_approval`, linked from `inbound_emails.draft_id`, with its autonomy class in `drafts.action_class`:

| Class | When |
|---|---|
| `reply_demo_link` | They asked to see the product and the draft carries exactly one approved asset link, and no other link except the booking URL |
| `reply_question` | A question triaged at 0.8 or more, with approved facts available |
| `reply_send` | Everything else |

No draft is written for unknown senders, for your own addresses (your company domain, the sending domain, the reply-to, support and sender addresses), or for the intents above that get none. A writer that fails is tried again once a day while the message is under 14 days old; turning drafting on later drafts recent owed messages too.

## Approving and sending

Each draft arrives in the operator chat as an approval request showing the whole draft, bound to its digest ([OPERATOR.md](OPERATOR.md)), after a short notice with the sender's address, the intent, the qualifier's decision, the class and the quality verdict. The notice never carries the inbound text. Approval requests go to `options.chatId` of the reply jobs, or the first chat in `operator.allowedChatIds`.

Approving marks the draft approved and sends nothing. With `replies:send_enabled` on, the `replies_send` job (every 5 minutes) or `/reply_send <draft id>` sends approved replies. Before sending, each must pass, failing closed:

1. the draft is still approved and its content hashes to the approved digest (an edit after approval sends it back to review);
2. a send lock claimed in the effects ledger, so two runs or commands never send it twice;
3. freshness: the text is what you were shown; no mailbox draft exists for it (mirrored, or one you started on the thread); no newer human message arrived on the thread or from the sender; nothing was sent on the thread after theirs; and the mailbox thread could be read. Any read error holds it for the next run.

Then it goes through the send function, path `reply`, which runs the halt, suppression, the content lint, verification and the approved-digest check itself ([SENDING.md](SENDING.md)):

- **Through the warm mailbox, on the thread.** With a mailbox connected, a reply goes out only through it, from your real mailbox, threaded on the conversation, and never through the cold email provider. Cold and sequence mail never goes through the mailbox. A reply needs an inbound message from that contact on that thread and its approved draft, or it is refused; it is never downgraded to cold mail.
- **No visible footer.** A reply to someone who wrote in reads like a normal reply: it carries the `List-Unsubscribe` and threading headers but no postal footer. Cold, sequence and lifecycle mail keep the full footer.
- **Not counted against the sending domain.** Mailbox replies are outside the provider's daily cap, the per-account cap and its circuit breaker. They are never written to the deferred queue: a reply held by the halt waits for its next send attempt.
- **Never twice.** An answer from the mailbox that leaves it unclear whether the reply went out keeps the lock, and the reply is not retried; check the mailbox's sent folder.

After a send the message is marked responded and the decision recorded in `autonomy_events`: `approved_unchanged` when the approved text is what the writer produced, `approved_edited` otherwise. A draft rejected in chat records `rejected`. A refusal is reported once per approval with what to do; a reply that is merely held is reported at most once a day.

## Reminders

With `replies:reminders_enabled` on, the `replies_reminders` job (every 5 minutes, no model calls) reminds you about every reply that is owed: still new, notified or with a draft waiting, received in the last 14 days, and either triaged as interested, question, referral, warm, objection or unclear, or from a known contact and not triaged yet (so a failed triage never hides one).

- Reminders escalate at 15 minutes, 2 hours and 4 hours. Each fires once per message, and a message first seen late gets only its highest due tier.
- From 12 hours old, one reminder each morning instead, from the UTC hour in `options.morningHourUtc` (default 13).
- Each reminder is claimed before it is sent and released if the notification fails, so it is retried on the next run rather than lost.
- Reminders list the sender's address, the intent, how long it has waited, the draft, the message id, and at most an 80-character sanitized preview (links removed, injection patterns redacted).
- **Quiet threads.** A warm thread you answered at least 5 days ago, with nothing from them since and no meeting booked, is surfaced once. Nothing is ever sent to them automatically.

Reminders stop when the reply is answered (sent from chat or the mailbox), or when you mark it with `/reply_done` or `/reply_ignore`.

## Mailbox draft mirroring

With `replies:mirror_enabled` on and a mailbox that can create drafts, the `replies_mirror` job (every 15 minutes) puts every reply draft waiting for approval into your mailbox as a real draft on its thread, so you can edit and send it from your mail client. Only the newest message on a thread gets one, only under 14 days old, never for a suppressed recipient. A mailbox adapter that only receives mail, such as Cloudflare Email Routing, cannot read threads, draft or send: when it says so (an optional `capabilities` object, `{ threads, drafts, send }`), mirroring and sending skip cleanly. With Email Routing alone, you can also leave `inbox` out of the reply jobs' wiring.

Once a mailbox draft exists, approving in chat refuses to send it: send it from the mailbox. Each run then reconciles:

| What it finds | What happens |
|---|---|
| A message sent on the thread after theirs | Answered: the draft is marked sent, an outbound touch is logged, and the evidence is `approved_unchanged` when the sent text matches the draft once quoted history and the signature are stripped, `approved_edited` otherwise |
| Nothing sent, and the mailbox draft is gone | You are told once; the reply stays owed (a scheduled send also removes the draft) |
| Nothing sent after 7 days | The message is marked ignored, the draft rejected, with `rejected` evidence |

A thread read returns the mailbox's drafts as well as its sent mail. A message the adapter marks as sent counts as sent; one it does not mark counts only once the mailbox draft is known to be gone. When the mailbox can tell neither, nothing is concluded from it: the reply stays owed until you mark it, and a reply closed after 7 days records no evidence.

## Operator commands

Commands never reach the model.

| Command | What it does |
|---|---|
| `/replies` | Replies waiting on you, oldest first, with message and draft ids |
| `/reply_done <id>` | Mark a reply answered by hand (you replied from your mail client, or the mailbox cannot be mirrored or send). Its pending draft is rejected, with no evidence |
| `/reply_ignore <id>` | Mark a message as needing no answer |
| `/reply_send <draft id>` | Send an approved reply now, with every check above. Needs `replies:send_enabled` |
| `/reply_draft <id>` | Show a message's pending draft again as an approval request in this chat |

An `<id>` is a message id from `/replies`, or a unique prefix of at least 6 characters. Approve and Reject are the buttons on each approval request.

## Flags

Set a flag with `npx gtm flags set <key> <value>`; `npx gtm flags unset <key>` turns it off. A flag that cannot be read counts as off. `gtm doctor` lists them all.

| Flag | Default | What it does |
|---|---|---|
| `replies:triage_enabled` | off | Triage and routing |
| `replies:drafting_enabled` | off | Drafting and approval requests (inside the triage job) |
| `replies:send_enabled` | off | Sending approved replies from the mailbox: the send job and `/reply_send`. Delivery also needs `delivery:enabled` |
| `replies:mirror_enabled` | off | Mailbox draft mirroring and reconciliation |
| `replies:reminders_enabled` | off | The reply-owed reminders and quiet threads |

`inbound:auto_send_tier` is reserved for automatic replies, a later milestone; nothing here reads it.

## Jobs

| Job | Schedule (UTC) | Flag | Ceilings |
|---|---|---|---|
| `replies_triage` | Every 15 minutes | `replies:triage_enabled` | 10 messages, $1.00 a day of model spend, 5 minutes |
| `replies_mirror` | Every 15 minutes | `replies:mirror_enabled` | 20 rows, 2 minutes |
| `replies_send` | Every 5 minutes | `replies:send_enabled` | 10 drafts, 2 minutes |
| `replies_reminders` | Every 5 minutes | `replies:reminders_enabled` | 50 rows, 1 minute |

Only `replies_triage` calls models, and a schedule for it that runs more often than every 15 minutes is refused.

## Wiring

```ts
// apps/worker/src/index.ts
import { createReplyJobs } from "@gtm-agents/core/replies";

const replies = createReplyJobs<Env>({ model, inbox, operator });

export default createWorker(config, {
  jobs: [...sourcing, ...outreach, ...delivery, ...replies],
  // ...
});
```

`model`, `inbox` and `operator` are the same per-environment factories the rest of the Worker uses ([INBOX.md](INBOX.md) shows the mailbox adapters). In `gtm.config.ts`, give the `triage` and `writer` roles a model and price each one; a role without a model or a price is unavailable, and nothing is triaged or drafted. `createReplyJobs` takes `options` to change a schedule, the triage job's rows and spend cap, the chat notices go to, the morning hour, or how long a reply is chased.

## Limits

- **Erasure stops at the mailbox.** Erasing a person removes their rows and stored bodies here, but a reply draft already mirrored into your mailbox, and the mail itself, live in that mailbox: delete them there as well.
- **No automatic replies yet.** Every reply waits for a person. The auto-send rules, and the `inbound:auto_send_tier` flag, are a later milestone.
- **No booking.** The qualifier decides book, ask or pass; drafts offer your booking URL, but calendars and invites are a later milestone, so a proposed time is confirmed in words and the invite is yours to send.
- **No curation screen for objections.** Filed objections wait in the `objections` table with an empty response; approving an answer means writing its response and setting `approved_digest` to `objectionAnswerDigest` of its pattern and response.
- **Referrals need a mailbox that can read threads**, because colleagues come only from the message's headers. With Email Routing alone, referrals add nobody.
- **Telling drafts from sends** needs an adapter that marks them (above). Without that, mirroring cannot record evidence for replies sent from the mailbox.
- **Triage reads one message at a time,** not the whole thread, so a short "yes" to an earlier question can read as unclear.
