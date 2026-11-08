# Inbox

This page is for deployers connecting a mailbox to GTM-agents, and for contributors extending inbox intake. It covers how replies are detected, how each inbound message is classified without a model, and what the system does with it. Semantic triage and reply drafting, which read the rows described here, are covered in [REPLIES.md](REPLIES.md).

Cold mail goes out from the isolated sending subdomain with `Reply-To` set to the real mailbox ([SENDING.md](SENDING.md)), so every reply lands in one inbox. Intake watches that inbox, records every inbound message once, and stops or holds follow-ups the moment someone answers.

## How mail is detected

| Path | When it runs | Typical delay |
|---|---|---|
| Push (Gmail through Cloud Pub/Sub) | Gmail notifies `POST /api/webhooks/mail` when the inbox changes | Under a minute |
| Poll (`inbox_poll`) | Every minute | One to two minutes |
| Sweep (`inbox_sweep`) | Every 15 minutes, over the last 3 days | A safety net for anything the other paths missed |
| Email Routing (`email()` entry point) | When Cloudflare Email Routing delivers a message to the Worker | Seconds |

- **The push is only a wake-up.** The notification's own history id is the mailbox state after the new message, so listing from it would skip the message. The webhook never reads the body; it runs one bounded poll from the stored cursor.
- **Every folder counts.** The Gmail adapter lists mail under any label except sent, drafts, trash and chats, so a reply filtered to spam, archived on a phone before the poll, or caught by a skip-inbox filter is still detected. (Push notifications cover the inbox; the poll catches the rest.)
- **The poll** lists mail added since its cursor, a position in the mailbox's history, kept in KV. The cursor moves only after every listed message was recorded or skipped, so a database failure means the next poll lists the same messages again. When there is no cursor, or Gmail no longer accepts it (history positions last about a week), the poll lists the last day instead and starts a new cursor. A quiet inbox costs one Gmail call per minute and no database query for mail.
- **The sweep** lists the last 3 days without a cursor, tells the adapter which ids are already recorded before anything is fetched, and records the rest. It also fetches again the bodies of recent rows whose body could not be stored.
- **While the system is halted** the job runner holds the poll, sweep and watch renewal, and the push webhook does not poll. Mail is not lost: when the halt lifts, the poll resumes from its cursor, or lists the last day if the cursor expired, and the sweep covers 3 days. After a halt longer than that, widen a one-off sweep (`createInboxJobs({ options: { sweepLimit } })`) or check the mailbox by hand.
- **Dedup.** `(provider, provider_message_id)` is unique, so a message seen by the push, the poll and the sweep is recorded once.

## Connecting Gmail

The `inbox-gmail` adapter reads the inbox, mirrors reply drafts and sends replies through the Gmail API with OAuth. It needs a Google Cloud project with the Gmail API and the Cloud Pub/Sub API enabled.

1. **Create an OAuth client.** In the Google Cloud console, configure the OAuth consent screen (Internal, for a Google Workspace mailbox) and create an OAuth client ID. Keep the client ID and secret.
2. **Grant a refresh token** for the mailbox with the scope `https://www.googleapis.com/auth/gmail.modify`, which covers reading, drafts, sending and push registration. Ask for offline access and consent (`access_type=offline`, `prompt=consent`) so Google returns a refresh token, for example with the OAuth 2.0 Playground set to use your own client. An External app left in testing status issues refresh tokens that expire after 7 days; publish it, or use an Internal app.
3. **Store the secrets:**

   ```bash
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put GMAIL_REFRESH_TOKEN
   ```

4. **Set up push** (optional, but it brings detection under a minute):
   - create a Pub/Sub topic, for example `projects/acme-gtm/topics/gmail-push`;
   - grant `gmail-api-push@system.gserviceaccount.com` the Pub/Sub Publisher role on it;
   - generate a long random value and store it with `npx wrangler secret put MAIL_PUSH_SECRET`;
   - create a push subscription on the topic whose endpoint is `https://agent.acme.example/api/webhooks/mail?token=<MAIL_PUSH_SECRET>`, with your deployment's host;
   - name the topic in `gtm.config.ts` (`adapters["inbox-gmail"].options.pubsubTopic`) or with `npx wrangler secret put GMAIL_PUBSUB_TOPIC`.

   The daily `inbox_watch_renewal` job registers the watch and renews it before Gmail's 7-day expiry. Without a topic, the adapter offers no push and the job reports "push not configured"; the poll still detects mail within a couple of minutes.
5. **Tell the adapter its own address** (`adapters["inbox-gmail"].options.address`), so mail from it counts as ours. Messages Gmail labels SENT or DRAFT always do.
6. **Wire it** in `apps/worker/src/index.ts` (below) and turn on `inbox:enabled`.

Adapter options (`adapters["inbox-gmail"].options`): `address`, `pubsubTopic`, `userId` (default `me`), `scanLimit` (message ids a window listing reads, 1 to 500, default 200) and `apiBaseUrl`.

## Connecting Cloudflare Email Routing

The `email-cloudflare` adapter receives mail sent to an address on your domain and turns each raw message into an inbound message. It only receives: it cannot list, read threads, draft or send, so pair it with a mailbox adapter if you want reply drafts in a mail client.

1. Enable Email Routing on the domain in the Cloudflare dashboard, which adds its MX records.
2. Create a routing rule for the address you want watched, for example `replies@acme.example`, with the action **Send to a Worker** and your deployment's Worker.
3. To make replies to cold mail arrive here, set `sending.replyTo` to that address.
4. Optionally add a verified destination address and pass it as `forwardTo`: every message is forwarded there first, so a person still receives it. A redelivered message is forwarded once; a forward that fails makes the handler throw after recording, so a redelivery retries it.
5. Wire it (below) and turn on `inbox:enabled`.

With `inbox:enabled` off, routed mail is not recorded: it is forwarded when `forwardTo` is set, and otherwise rejected so the sender learns it was not delivered. A message that cannot be parsed or recorded makes the handler throw, so the failure shows in Email Routing's activity log, and a message intake skips as unparseable is rejected unless it was forwarded. Mail arriving this way is recorded even while the system is halted, because recording only ever stops or holds mail.

Adapter options (`adapters["email-cloudflare"].options`): `ownAddresses` (addresses whose mail counts as the deployment's own) and `maxBytes` (default 25 MiB, Email Routing's own limit).

## Wiring the Worker

```ts
// apps/worker/src/index.ts (excerpt)
import { createWorker, type Env } from "@gtm-agents/core";
import { createAdapterContext } from "@gtm-agents/core/adapters";
import { createInboxJobs } from "@gtm-agents/core/inbox";
import { createAdapter as createGmailInbox } from "@gtm-agents/adapters/inbox-gmail";
import { createAdapter as createRoutedMail } from "@gtm-agents/adapters/email-cloudflare";
import config from "../gtm.config.ts";

const context = (env: Env, name: string) => createAdapterContext({ name, env: { ...env }, config });
const inbox = (env: Env) => createGmailInbox(context(env, "inbox-gmail"));

export default createWorker(config, {
  inbox,
  inboundEmail: {
    parser: (env) => createRoutedMail(context(env, "email-cloudflare")),
    forwardTo: "avery@acme.example",
  },
  jobs: [...createInboxJobs<Env>({ inbox, operator })],
  operator,
  // ...the other factories and jobs
});
```

Pass only the parts you use: `inbox` for a mailbox with push and polling, `inboundEmail` for Email Routing, or both. `createInboxJobs` without `inbox` still registers the poll, which then only retries pending rows.

## What is recorded

Every inbound message becomes one `inbound_emails` row:

- the sender's normalized address and display name, the subject, a 280-character preview and the body's blob key (the body itself is in blob storage, see `packages/core/src/inbox/body.ts`);
- the structural classification, with `intent` NULL until triage runs and `status` `new`;
- the matched contact (by exact address hash, then by mailbox hash, so `jane+news@` matches `jane@`) and the account key (the contact's, else the sender's registrable domain; NULL for personal mailboxes);
- the message's own Message-ID and its threading and triage headers, for threading a reply under it;
- the sender's address hashes, and for a delivery report the hashes of every failed recipient, so erasure and retries can find them;
- `processed_at`, set when the rules below have run.

Skipped, never recorded: mail the mailbox sent (sent copies, drafts, its own address), anything from the cold sender, the reply-to mailbox or the sending domain, and a message whose id or sender address does not parse.

**Own mail.** Mail from the company's own domain or the support address (`sending.supportAddress`) is recorded with no contact and no account, with status `ignored` and the `[own_mail]` note, so nothing drafts to it or treats it as a prospect, and no rule acts on it (a delivery report excepted, which is judged by its failed recipient).

**Bodies.** If blob storage cannot take the body, the row is still recorded with `body_key` NULL and the `[body_not_stored]` note: detection matters more than the archive. A body is always stored when storage works, even an empty one, so `body_key` NULL means "not stored", never "no text". The sweep fetches the body again from providers that can, and marks `[body_unrecoverable]` when the mailbox no longer has the message.

## Structural classification

Deterministic: patterns and headers only, no model, so it runs in the per-minute poll and gives the same answer every time. The first rule that matches wins:

1. **bounce**: a mail system sender (mailer-daemon, postmaster), a `multipart/report` delivery status, an `X-Failed-Recipients` header, or an anchored bounce subject ("Undeliverable", "Delivery Status Notification") from an automated sender or with a delivery report.
2. **out_of_office** for a person's responder: an anchored out-of-office or automatic-reply subject, `Auto-Submitted: auto-replied`, `X-Autoreply` or `X-Autorespond`, or `Precedence: auto_reply`. **auto_reply** for machine mail: any other `Auto-Submitted` value, a no-reply or notifications sender, a service subject (DMARC and TLS reports), or bulk and list mail (`Precedence: bulk`, `list`, `junk`, or a `List-Id`) that is not answering our mail.
3. **unsubscribe**: the sender's own words, with quoted history and signature removed, are only an opt-out ("unsubscribe", "stop", "remove me", "take me off your list"). A subject that is only "unsubscribe" (what a mail client's `List-Unsubscribe` mailto sends) is checked right after the bounce rule, so it counts even from an automated sender.
4. **reply**: a reply prefix (Re, Aw, Sv, Antw and the like), or the message answers mail: `In-Reply-To` or `References` names one of our sends (its Message-ID or the provider's id) or an id on our own domains, or it references a message already recorded, or its thread already holds one. Sharing a thread never turns bulk mail into a reply, since a mailbox can thread a newsletter with its last issue.
5. **new_inquiry**: anything else.

Subjects are anchored, so "Re: moving away from spreadsheets" is a reply, not an out-of-office. Separately, a billing-failure notice (a failed charge, a declined card, a suspended account) from an automated or billing sender is flagged for the operator whatever its classification.

## What each classification does

| Classification | Action |
|---|---|
| `reply`, `new_inquiry`, unclassified | From a known contact or anyone at a known account: that contact's and that account's sequences stop now, with status `replied` |
| `unsubscribe` | The sender is opted out (`optOutAddress`, reason `opt_out`, source `inbound_unsubscribe`): suppressed, warmth `opted_out`, sequences stopped, queued sends cancelled. The account's other sequences stop as for a reply, and the operator gets a notice |
| `bounce` | The failed recipients (up to 5) are read from `X-Failed-Recipients` (believed only on a real report: a mail system sender or a `multipart/report`), the report's `Final-Recipient` with `Action: failed` or a 5.x.x status, or the returned message's headers. Only a permanent failure for an address we actually sent to is acted on: suppressed with reason `bounce` (source `inbound_bounce`), marked undeliverable, sequences stopped, and not opted out. A report that names no parseable recipient is recorded and skipped (`[bounce:unparsed]`); an address we never sent to is left alone (`[bounce:not_ours]`) |
| `out_of_office` | From a known contact: their sequences wait until the day after the return date in their own words (named months, ISO dates, unambiguous numeric dates, at most 60 days ahead), or 7 days with no usable date. No warmth change |
| `auto_reply` | Nothing |
| Billing failure | Priority `high`, the `[billing_alert]` note and a page |

Each action is bookkeeping, caught and logged, except two compliance writes: an unsubscribe's opt-out and a matched bounce's suppression. If either fails, `processed_at` stays NULL, the operator is told once, the unsubscriber's own sequences stop anyway, and the minute poll retries the row (the pending pass, with no age limit, acting on exactly the recipients the first attempt found) until it lands. Every action is idempotent, so retries are safe.

## Untrusted text

Bodies, subjects, display names and delivery reports come from outside and are full taint. Intake never puts them in a prompt, and none of their content can choose an action: the rules act only on the sender's own address, the matched contact and account, or a bounced address the send ledger shows we mailed. A forged delivery report can at most suppress an address we sent to, which only ever sends less, and never opts anyone out. Header values are unfolded onto one line and capped, so nothing in them can start another header.

## Flags, jobs, secrets and routes

| Flag | Default | Effect |
|---|---|---|
| `inbox:enabled` | `false` | Master switch. Off, or unreadable: the jobs do not run, the push webhook verifies its secret then only acknowledges, and Email Routing mail is forwarded or rejected without being recorded. Nothing is recorded, classified or acted on |
| `inbox:cursor:<provider>` | unset | State: the poll's cursor and when it was written. Rebuildable; unset, the poll lists the last day |
| `inbox:push_last` | unset | State: when the last push-triggered poll started, so a burst of pushes runs one poll |

| Job | Schedule (UTC) | Ceilings | Notes |
|---|---|---|---|
| `inbox_poll` | every minute | 50 s, 50 rows | Pending rows, then up to 2 listings of 20. No model call. The job runner writes a run row per run, about 1,440 rows a day in `execution_runs`, so plan run-row retention with that in mind |
| `inbox_sweep` | every 15 minutes | 120 s, 30 rows | Last 3 days, unknown ids only, plus up to 5 body repairs. Critical: the cron health check watches it |
| `inbox_watch_renewal` | 06:20 daily | 30 s, 1 row | Renews Gmail push. Critical |

Change schedules and limits with `createInboxJobs({ options: { pollLimit, pollPages, pendingLimit, sweepLimit, repairLimit, pollSchedule, sweepSchedule, watchSchedule } })`.

| Secret | Used by |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The Google OAuth client, shared by the Google adapters |
| `GMAIL_REFRESH_TOKEN` | `inbox-gmail`, granted `gmail.modify` |
| `GMAIL_PUBSUB_TOPIC` | Optional: the push topic, instead of the adapter option |
| `MAIL_PUSH_SECRET` | The push webhook's shared secret |

| Route | Authentication |
|---|---|
| `POST /api/webhooks/mail` | `MAIL_PUSH_SECRET` as the `token` query parameter or an `x-push-token` header, compared in constant time before anything else. 503 while the secret is unset or no mailbox is configured, 401 on a missing or wrong token |
| `email()` | Cloudflare Email Routing invokes it directly; there is no HTTP route |

## Erasure

Erasing a person (`eraseContact`, `eraseByHash`) deletes their inbound mail: mail they sent (found by address, address hash or contact, so an erasure by hash alone finds it too), mail whose subject, preview or headers name one of their addresses, and delivery reports about them, found by the failed recipients' hashes. Pass the blob binding (`{ bucket: env.BUCKET }`): each body is deleted before its row, and erasure refuses to run without the bucket when bodies exist rather than leave them behind. If storage fails, the erasure throws and can simply run again. See [DATA-MODEL.md](DATA-MODEL.md#erasure).

## Limits

- Use one intake path per message: if routed mail is also forwarded into the polled mailbox, a message from the same sender with the same Message-ID is recorded once, under whichever path saw it first.
- Erasure finds a person's inbound mail by sender, by their address in the subject, preview or headers, and by a delivery report naming them. A colleague's message that mentions them only deeper in its body keeps that body until it is deleted with its own sender.
- A poll lists at most 40 new messages a minute by default; more waiting are listed by the next polls, and the sweep backs them up.
- A window listing reads at most `scanLimit` message ids (newest first); older mail in a busy window is left to later sweeps while it is under 3 days old.
- Bodies are kept up to 100,000 characters; delivery reports up to 32,000.
- Email Routing messages over `maxBytes` are refused.
