# Autonomy: earned levels, evidence, promotion and demotion

This page is for deployers deciding how much the agent may do on its own, and for contributors changing how levels are read, earned or taken back. It covers the levels and action classes, the permanently human-only actions, how decisions are recorded as evidence, the weekly promotion review and its rules, immediate demotion after harm, the outbound writer registry and its evals, automatic replies, and the commands, flags, jobs and limits involved. The code lives in `packages/core/src/autonomy/`: `@gtm-agents/core/autonomy` holds the parts that need no Worker binding (levels, the writer registry and scorers, the auto-send rules), and `@gtm-agents/core/autonomy/runtime` holds the rest.

Every action class starts at "draft and ask". A class earns more only from evidence, the system only ever proposes it, and only a person applies it. Harm takes it back at once, with no person needed.

## Levels and action classes

| Level | Meaning |
|---|---|
| 0 | Observe only |
| 1 | Draft and ask (the default) |
| 2 | Act and notify: it acts, and you are told after |
| 3 | Act and report in a digest |

Every action the system could take on its own belongs to one action class (`EARNABLE_ACTION_CLASSES` in `levels.ts`): `cold_batch` (which also covers the cold sequence's follow-up steps), `reply_send`, `reply_demo_link`, `reply_question`, `ship_spec`, `ship_notification`, `post_meeting_followup`, `rebook`, `retrospective_actuation`, `brain_edit`, `lifecycle_activation`, `feedback`, `reengage`, `at_risk`, `renewal` and `other`.

The code that owns an action reads its class's level when it acts. These classes act on their level today:

| Class | At level 2 or 3 |
|---|---|
| `cold_batch` | The cold batch and its follow-up steps send drafts that pass the quality gate and the model reviewer without a release code ([OUTREACH.md](OUTREACH.md), [SEQUENCES.md](SEQUENCES.md)) |
| `reply_send` | A reply to someone who wants a call, carrying your booking link, goes out at once when every auto-send rule passes, and you are told after |
| `reply_demo_link` | A reply carrying one approved asset to someone who asked to see the product goes out at once when every auto-send rule passes, and you are told after |
| `lifecycle_activation`, `feedback`, `reengage`, `at_risk` | The lifecycle follow-up of that class goes out from its approved template when the sweep drafts it, and you are told after ([LIFECYCLE.md](LIFECYCLE.md)). The upgrade and win-back offers never do: they belong to `offers` |
| `brain_edit`, `retrospective_actuation` | A learning loop's own proposal of that class applies without you, only for changes that never reach a prospect on their own ([LEARNING.md](LEARNING.md)) |
| `ship_spec`, `ship_notification` | With the optional ship module: a low-risk spec is approved without you (at most 2 a run), and an "it is live" note that passes the quality gate goes out ([SHIP.md](SHIP.md)). Merging stays with a person |

Every other class drafts for approval at every level. Level 3 behaves like level 2 for now: every automatic action is still announced as it happens, and the digest-only mode is not built.

The weekly review proposes a promotion only for the first three (`AUTOMATIC_PATHS` in `promotion.ts`), which have an outcome or auto-send rule set to judge them by. The others collect evidence, shown in `autonomy-status`, and change level only when you set it with `autonomy-set`.

## Permanently human-only actions

Five classes always need a person, whatever the evidence: `merge_code`, `pricing_billing_auth`, `offers`, `proof_of_value_send` and `data_deletion` (`PERMANENT_HUMAN` in `levels.ts`). They are capped at level 1 everywhere:

- when a level is read (`effectiveLevel`), whatever the flag, the config or the database holds;
- when a level is set: `autonomy-set` refuses them above 1 at both steps, and so does `gtm flags set`;
- in the database: a CHECK constraint on `autonomy_level_changes` and `autonomy_proposals` refuses them above 1, and a test keeps that list equal to the constant;
- in the review, which never proposes them.

`PERMANENT_HUMAN` is a constant. Nothing reads a flag or a config value to loosen it, and the agent has no tool that touches levels.

## Where a level lives

A class acts at the **lower** of two values:

1. its `autonomy:<class>` flag in KV. When the flag is unset, the starting level in `gtm.config.ts` (`autonomy.defaults`) applies, else 1;
2. the latest row for the class in `autonomy_level_changes`, which records every change: the operator's confirmed `autonomy-set` (source `operator`) and every automatic demotion (source `demotion`).

So a recorded change can only lower what the flag says. A class with no recorded change acts at its flag or its starting level, which only someone with access to the deployment's flag store or `gtm.config.ts` can set: that is a deployment decision, not an earned level. Once a class has a recorded change, raising it past that change needs a confirmed operator change; a demotion holds even when the flag store cannot be written; and a value written straight to the flag store (`gtm flags set`) cannot lift a class above its latest recorded change. Use `autonomy-set` from the operator chat to change levels.

Every read fails closed, toward level 1: a flag that cannot be read or holds anything but one digit from 0 to 3, a change record that cannot be read (which also counts as a standing demotion), and an unknown class name all read as 1 at most. The cold batch, the follow-up sweep and automatic replies all read their level through this one reader (`readAutonomyLevel` in `store.ts`).

A **standing demotion** (the latest recorded change is a demotion), or level 0, also stops the cold batch's `cold_batch:auto_approve` switch: after harm, nothing in that class goes out on its own until a person records a level again with `autonomy-set`, even `autonomy-set cold_batch 1` to keep the switch.

## Evidence

Every decision about an action writes one row in `autonomy_events`, through one module (`evidence.ts`):

| Outcome | Means |
|---|---|
| `approved_unchanged` | A person approved it as the system wrote it |
| `approved_edited` | A person approved it after changing it |
| `rejected` | A person turned it down |
| `auto_sent` | It went out on its own, under an earned level or the auto-approve switch |
| `incident` | Harm after an automatic action, or a delivery rate its automatic sends pushed over a limit |

Who writes what:

- **The cold batch:** `approved_unchanged` when you release a batch (a whole batch is one decision, written once), `auto_sent` when a batch goes out on its own.
- **The follow-up sweep:** the same, under `cold_batch`: `sequence-release` is one decision, and each automatic sweep that sends is one `auto_sent`.
- **Replies:** `approved_unchanged` or `approved_edited` when an approved reply is sent, from chat or from the mailbox ([REPLIES.md](REPLIES.md)); `rejected` when one is turned down or left unsent for 7 days; `auto_sent` when one went out automatically.
- **Meeting drafts** (the recap, the rebook and the post-demo follow-ups, [CONVERT.md](CONVERT.md)): `approved_unchanged` when approved in chat, `rejected` when rejected there. Chat approval cannot change the text, and these drafts are sent from your mail client, so edits made there are not seen.
- **Lifecycle follow-ups** ([LIFECYCLE.md](LIFECYCLE.md)): under the class its rule names (`lifecycle_activation`, `feedback`, `reengage` or `at_risk`), `approved_unchanged` or `approved_edited` on `fu-approve`, `rejected` on `fu-reject`, and `auto_sent` when the sweep sends at an earned level. The upgrade and win-back offers record nothing, under any class.
- **Incidents:** below.

Writing evidence is bookkeeping: it never throws, and a lost row never changes what was sent.

## Promotion: the weekly review (proposals only)

Experiments make proposals of their own beside these (a template weight, a subject winner, a larger holdout), through the copy-change gate and the weekly rule-based self-review; they too are applied only by a person, and only if the setting still holds the value the proposal was made against ([EXPERIMENTS.md](EXPERIMENTS.md)).

With `autonomy_review:enabled` on, the `autonomy_review` job (Mondays at 06:00 UTC) checks each class with an automatic path against these rules and proposes the step it qualifies for. It changes nothing.

- **Level 1 to 2:** at least 30 decisions in 60 days (a batch is one decision, so the cold batch needs 4), at least 90% approved as written, at most 5% rejected, and no incident in 30 days.
- **Level 2 to 3:** at least 60 automatic sends in 60 days, with no incident and no rejection in 60 days.
- **The outcome gate for the cold batch,** for either step: first touches sent 10 to 40 days ago (matured) against a baseline sent 40 to 130 days ago, at least 200 sends in each, a hard bounce rate under 2% in the recent window, and a positive reply rate at or above the baseline's. Every figure comes from `packages/core/src/metrics/` ([MEASUREMENT.md](MEASUREMENT.md)): `firstTouchOutcomes`, `hardBounceRate` and `replyRate`. Data that cannot be read blocks the proposal.
- **Eval coverage:** a class can be proposed only when every writer of its text is in the writer registry with an eval (below).
- A permanently human-only class, a class at level 0 (observe only was a person's choice) and a class outside `AUTOMATIC_PATHS` are never proposed.
- The same proposal (class, from, to) is made at most once every 14 days.

Each proposal goes to the operator chat with its evidence, the command that applies it, `autonomy-confirm-<id>-<code>`, valid for 14 days, and the command that dismisses it, `autonomy-dismiss-<id>`. A proposal the chat could not deliver is withdrawn and made again the next week. Confirming applies it only when, at that moment:

1. the proposal is open and unexpired and the code matches (the code confirms intent; the operator allowlist is the control);
2. the class's level reads cleanly and still equals the level the proposal was made against, and no change has been recorded for the class since (a demotion in between refuses it);
3. for a raise, no incident was recorded for the class since the proposal (checked inside the write itself);
4. the change row is written with a compare-and-set on the class's latest change, so two confirmations can never both apply.

**Dismissing a proposal.** An open proposal can be dropped instead of left to expire: send `autonomy-dismiss-<id>`, optionally followed by a reason, in the operator chat, or reject it in the dashboard's Proposals view, which calls the same function (`dismissProposal` in `proposals.ts`). Dismissing needs no code, because it can only leave the system as strict as it was: it writes no level, no change row and no flag. The proposal is recorded as `refused`, with the operator in `decided_by` and `dismissed` and the reason in `detail`, and an audit row `autonomy.proposal_dismissed` records the proposal, the class, both levels and the operator (never the reason's text). Only an open, unexpired proposal can be dismissed, and a dismissed one can never be confirmed afterwards. The weekly review counts a dismissed proposal like any other, so it proposes the same change again no sooner than 14 days after it first did.

## Demotion: immediate, automatic, always on

Three kinds of harm after an automatic send are incidents: a **hard bounce** (the provider webhook, or a delivery report in the inbox), a **complaint** (the provider webhook), and an **unsubscribe** (the unsubscribe link, a provider's unsubscribe event, an unsubscribe reply, or a triaged opt-out). A polite decline is never one: it is not an opt-out, so it never reaches this path.

An incident counts against every class that sent to the contact automatically in the 14 days before it, read from the send ledger and the drafts those sends came from (drafts approved as `auto:...`). The cold batch is a volume class: per contact, only a complaint counts against it. Its bounces and opt-outs count through a rate check instead: while the cold batch sends on its own, outreach over the last 14 days with at least 50 sends and a hard bounce rate of 2% or more, or an unsubscribe rate of 1% or more, is an incident. Both rates come from `packages/core/src/metrics/` (`hardBounceRate`, and `unsubscribeRate`, opt-outs after outreach over outreach sends). A level that cannot be read is treated as sending on its own, because demoting is the safe direction.

An incident, in one database batch, so all of it lands or none of it does:

1. writes an `incident` row (it blocks promotion: 30 days for a first step, 60 for the second);
2. records a demotion to level 1 (never above the latest recorded level), unless a demotion already stands;
3. returns the class's automatically approved drafts that have not gone out to review, so nothing queued under the old level is sent (the send function checks the approval again before every send);
4. claims the incident, so the same harm counts once however often it is reported.

The hook is in `optOutAddress` (`packages/core/src/sending/opt-out.ts`), the one routine behind every hard bounce, complaint and opt-out, so the provider webhook, the inbox, the unsubscribe page and reply triage all demote through it.

**A demotion that cannot be written is not lost.** The write is retried; the `autonomy_watch` job finds every hard bounce, complaint and opt-out of the last 14 days again from the suppression list each hour and records whatever is missing; it tells you when it could not; and while the database cannot be read, every level read caps at 1.

**Why demotion has no flag.** Every new capability ships behind a flag that defaults off, but demotion only ever tightens. A demotion that waited for a switch would let a class keep acting on its own after the harm that should have stopped it. Everything starts at level 1, so until a person raises a class or turns on auto-approve there is nothing to demote.

After a demotion the operator is told within the hour, and the class's flag is written down to the demoted level so `gtm flags list` shows it. To raise the class again, send `autonomy-set <class> <level>` and confirm it.

## The outbound writer registry and evals

`OUTBOUND_WRITERS` in `packages/core/src/autonomy/writers.ts` lists every module that writes text a prospect reads, the class it is sent under, and the eval that scores it:

| Writer | Module | Class | Eval |
|---|---|---|---|
| `cold-intro` | `outreach/compose.ts` (templates) | `cold_batch` | `tests/evals/writers.eval.ts` |
| `follow-up-steps` | `sequences/compose.ts` (templates) | `cold_batch` | `tests/evals/writers.eval.ts` |
| `reply-drafter` | `replies/draft.ts` (the writer model) | `reply_send`, `reply_demo_link`, `reply_question` | `tests/evals/writers.eval.ts` |
| `meeting-recap` | `convert/drafts.ts` (fixed text) | `post_meeting_followup` | `tests/evals/writers.eval.ts` |
| `meeting-rebook` | `convert/drafts.ts` (fixed text) | `rebook` | `tests/evals/writers.eval.ts` |
| `post-demo-follow-ups` | `convert/drafts.ts` (fixed text) | `post_meeting_followup` | `tests/evals/writers.eval.ts` |
| `operator-agent-drafts` | `tools/drafts-create.ts` (the chat agent) | `other` | none yet |

Each eval runs the writer's real code for invented contacts and scores the result with the deterministic scorers in `scorers.ts`: no em or en dash, the content lint passes, no figure absent from what the writer was given, and length bounds. The reply drafter is a model writer, so a fake model stands in for it, and the eval also checks its prompt contract (approved material only in the system prompt, the sender's text fenced in the user turn). Every suite also proves the scorers catch a bad output. `tests/evals/reply-auto-send.eval.ts` scores the auto-send decision over realistic replies and injected instructions.

The evals run with `npm run eval`, in the pre-commit hook and in CI, never in the Worker, so a deployed build has passed them. The registry is static code: nothing the agent can call writes it. A live tier calls a real model for the reply drafter: it runs only with `GTM_EVAL_LIVE=1`, `ANTHROPIC_API_KEY` and `GTM_EVAL_MODEL` set, and never in CI.

To add a writer, list it in `OUTBOUND_WRITERS`, add its suite to `tests/evals/writers.eval.ts` (the eval fails when a listed writer has no suite), and point `evalFile` at that file. A class with no listed writer, or a writer without an eval, is never proposed.

## Automatic replies

A reply goes out without a person only when **both** `inbound:auto_send_tier` is on **and** its class is at level 2 or above, and `replies:send_enabled` and `quality:model_review_enabled` are on too. That is stricter than either the flag or the level alone: the flag is your switch for the whole tier, and the level is what a class earned. Then every rule below must pass (`decideReplyAutoSend` in `auto-send-rules.ts`, one pure function that fails closed on any missing input):

1. the tier is on, as above, and the draft's class is `reply_send` or `reply_demo_link`;
2. outreach is not halted or paused (either one unreadable counts as paused);
3. it is a reply, or a new inquiry from someone you emailed;
4. a contact is matched;
5. no proposed time: none from triage, none from the meeting qualifier, and no day, date or clock time in the sender's own words, subject included; and the sender's whole text was read (not a stored preview, not cut at the reading limit);
6. no request to see the product, unless the class is `reply_demo_link`;
7. the message's headers were recorded, the sender is authenticated (below), any Reply-To is the sender, and the draft goes to the sender, who is the contact;
8. the intent: `reply_send` needs interested at 0.8 or more, a booking URL in `gtm.config.ts` and scheduling words in the sender's own text; `reply_demo_link` needs a request to see the product, interested or a question, at 0.8 or more;
9. no risk pattern (pricing, legal, contract, compliance, cancel, unsubscribe, a competitor, from the generic words and the brain's competitor names, which must be in the slice) in the sender's subject and text or in the draft, and no injection pattern and no link in what the sender wrote;
10. fact grounding: the brain's facts are available, the draft (subject and body) states no figure they do not hold, makes no plan or offer and no customer or reference claim, and does not promise to check and come back;
11. no link except the exact booking URL or an approved asset URL (bare hosts count);
12. a `reply_send` draft carries the booking link, and a `reply_demo_link` draft exactly one approved asset;
13. the content lint does not block;
14. the full quality gate: the deterministic gate and the model reviewer together say pass.

**Sender authentication.** A forged From must never make the system mail the real contact, so rule 7 needs proof the sender is who the From says. The proof is the `Authentication-Results` header the receiving mailbox wrote on the message (inbox intake keeps the first one, which the receiving server prepends). It is untrusted text and is read strictly (`sender-auth.ts`):

- its authserv-id must be one trusted for the mailbox the message came through (`TRUSTED_AUTHSERV_IDS`: `mx.google.com` for `inbox-gmail`). A mailbox with no trusted id, such as Cloudflare Email Routing, never authenticates, so its mail always goes to a person;
- it must show a DKIM pass whose signing domain (`header.d`, else the domain of the address in `header.i`) is the sender's domain, a parent of it or a subdomain of it, or an SPF pass whose `smtp.mailfrom` address has such a domain. Sibling domains never align, so no shared suffix can make two registrants look like one. A DMARC result other than pass or none refuses;
- it is kept only whole and only as plain printable ASCII, and never normalized, so no Unicode space or full-width character can turn into a delimiter; a missing header, a quoted string, an unbalanced comment, a malformed result or property, a property given twice, or a value too long to keep whole is refused as ambiguous.

Mail recorded before this header was kept has none, so it always goes to a person. The check relies on the receiving server stamping every message it accepts: if mail reaches the mailbox without that stamp (imported or fetched from elsewhere), the first Authentication-Results could be one the sender wrote. Do not route such mail into a mailbox whose replies are sent automatically. An SPF pass alone is accepted, so a sender domain whose SPF record includes a shared sending platform can be passed by that platform's other customers; publishing DMARC closes most of that gap.

Questions, objections, declines, anyone proposing a time, and anyone asking to see the product without the earned demo-link class always go to a person. `reply_question` drafts are never sent automatically in this version.

When every rule passes, the draft is approved for the code, bound to its digest (`approved_by` `auto:autonomy:<class>:L<level>`, with that digest recorded as what was approved), and sent through the same reply send path as an approved reply: the send lock, the freshness checks and the send function with every gate it runs ([REPLIES.md](REPLIES.md)). A send records `auto_sent` evidence and tells you after, with the full text. Anything else returns the draft to review and you get the usual approval request. A send whose outcome is unclear is never retried and never offered for approval again; you are told to check the mailbox.

Inbound text never decides alone. It can only fail rules (a risk word, a time, an injection pattern, a link). What it could influence, triage's reading of the intent, is one rule among fourteen, next to your switches, the earned level, fact grounding, the link rules and the quality gate.

## Operator commands

Commands never reach the model, and only an allowlisted operator reaches them (the chat consumer checks the allowlist and `operator:agent_enabled` first).

| Command | What it does |
|---|---|
| `autonomy-status` | Every class: its level and why, its evidence over 60 days, whether it can be proposed, and open proposals with their commands |
| `autonomy-set <class> <0-3>` | Step one: shows the class, its level, its evidence and a confirm command valid for 30 minutes. Nothing changes yet |
| `autonomy-confirm-<id>-<code>` | Step two: applies that change, or a proposal from the weekly review, only if nothing changed since |
| `autonomy-dismiss-<id> [reason]` | Drops an open proposal so it can never be confirmed. No level changes. The dashboard's Reject does the same |

These commands are the only way a level is raised from the chat. No tool, job, model output or inbound text can set one. Lowering a class to 1 or below also returns its automatically approved, unsent drafts to review.

## Flags

| Flag | Default | What it does |
|---|---|---|
| `autonomy:<class>` | 1 | A class's level, 0 to 3; the lower of this and the latest recorded change applies. Permanently human-only classes read as 1 at most |
| `autonomy_review:enabled` | off | The weekly promotion review. It only proposes |
| `inbound:auto_send_tier` | off | Automatic replies, together with an earned level, `replies:send_enabled` and `quality:model_review_enabled` |

The review's flag is not named `autonomy:<something>`, because every `autonomy:<name>` key is a class's level. Demotion has no flag.

## Jobs

| Job | Schedule (UTC) | Flag | Ceilings |
|---|---|---|---|
| `autonomy_review` | Mondays 06:00 | `autonomy_review:enabled` | 20 rows, 1 minute |
| `autonomy_watch` | Every hour at :15 | none | 200 suppression entries, 2 minutes |

Neither calls a model. `autonomy_watch` records incidents the opt-out path could not, runs the cold batch's rate check, writes a demoted class's flag down to the demoted level where the flag is higher (never up), tells you about every new demotion once, and expires stale proposals.

## Wiring

```ts
// apps/worker/src/index.ts
import { createAutonomyJobs } from "@gtm-agents/core/autonomy/runtime";

const autonomy = createAutonomyJobs<Env>({ operator });

export default createWorker(config, {
  jobs: [...sourcing, ...outreach, ...delivery, ...replies, ...autonomy],
  // ...
});
```

`operator` is the same per-environment factory the rest of the Worker uses. Automatic replies need nothing more: the reply triage job offers each new draft to the auto-send tier while `inbound:auto_send_tier` is on. Give the `judge` role a model and a price in `gtm.config.ts`, since the full quality gate needs the model reviewer. The tables come from migration `0023_autonomy.sql` (run `npx gtm migrate`); until it is applied, every level reads as 1 and the cold batch's auto-approve switch stays off.

## Limits

- **Level 3 is announced like level 2.** Every automatic action still sends its own notice; the digest-only mode is not built.
- **The review proposes only three classes** (`cold_batch`, `reply_send`, `reply_demo_link`). The lifecycle, learning and ship classes act on their level too, but only you raise them, with `autonomy-set`.
- **The cold batch's rate check reads all outreach** in its window, not only the batches that went out on their own. The window restarts only when the operator raises the class: it then starts at that raise, so sends judged before it do not demote the class straight back. A lowering, or a level set again at the same value, does not restart it.
- **A level set before any recorded change** (`gtm flags set`, or `autonomy.defaults`) applies without the two-step command. Use `autonomy-set` so every change is recorded.
- **Automatic approval is read again before every handover:** the cold batch and the follow-up sweep check it once more after storing automatically approved drafts, and an automatic reply after its approval, so a demotion that lands mid-run sends nothing.
- **Meeting drafts are sent from your mail client,** so edits made there are not seen, and their evidence counts an approval as unchanged.
- **Complaints in a reply's wording** ("this is spam") count only as the opt-out triage reads them, not as complaints.
- **Notices lag up to an hour.** A demotion applies the moment the harm is recorded; the operator notice comes from the hourly watch.
