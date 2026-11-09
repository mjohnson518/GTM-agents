# Sending email

This page is for deployers turning on outbound email: it covers the sending domain and its DNS, the email provider and its webhook, the secrets, the footer and one-click unsubscribe, send windows, caps, the deferred queue, the warm-up ramp, the bounce monitor and kill switch, and the flags and jobs that control all of it. Contributors writing another provider adapter should read [INTERFACES.md](INTERFACES.md#emailprovider) for the port; the reasoning behind the halt, the kill switch, suppression and the effects ledger is in [SECURITY-MODEL.md](SECURITY-MODEL.md).

Nothing here sends anything until you turn it on. Every switch below defaults to off.

## How a send works

Everything that sends email through the provider (the cold batch, sequence follow-ups, the deferred queue) calls one send function, `createOutreachSender`. It runs every check itself, so no caller can skip one, and returns one outcome per message:

```
items -> delivery:enabled?            off or unreadable: held, nothing sent
      -> provider, signing key, base URL configured?   missing: held
      -> already sent under this idempotency key?      reported as a duplicate
      -> 1. system halt / cold kill switch             deferred
      -> 2. suppression (fails closed)                 refused
      -> 3. content lint                               a block is refused, a warning goes on
      -> 4. verification policy                        cold needs a deliverable address
      -> 5. approved digest, when the item carries one refused on any mismatch
      -> 6. recipient-local send window                deferred to the next opening
      -> 7. per-domain and per-account caps            deferred
      -> 8. circuit breaker                            deferred while open
      -> chunk to the provider's batch limit
      -> per message: claim the idempotency key, add the footer and headers, tag it, send
      -> per sent message: ledger row, outreach log, draft marked sent, warmth cold -> contacted,
         campaign row (a cold first touch also schedules its follow-up from `sequences.cold`), funnel event,
         domain send count (each write caught; a failure never undoes a send)
      -> per uncertain message: the claim stays and the contact's last_contacted_at is set (warmth is
         unchanged), so it is never picked for a second first touch
```

A refusal reads `[SEND BLOCKED:<reason>] ...`. A deferred message goes to the deferred queue and is replayed later through the same function, so every check runs again.

| Outcome | Meaning |
|---|---|
| `sent` | The provider accepted it. Carries the provider's message id and the send ledger id |
| `deferred` | It waits, with a reason (`halted`, `cold_paused`, `outside_window`, `domain_cap`, `account_cap`, `circuit_open`, `provider_unavailable`) and the next attempt time |
| `blocked` | It will not be sent: `suppressed`, `unparseable`, `undeliverable`, `content_lint`, `approval_mismatch` or `invalid` |
| `duplicate` | A message with the same idempotency key was already sent |
| `failed` | Retryable: nothing was sent, and it can go once the cause is fixed (`[SEND BLOCKED:disabled]` while delivery is off, `[SEND BLOCKED:not_configured]` while a secret is missing, or a state that could not be read). Not retryable: the provider rejected it, or it is unclear whether the provider accepted it; unclear cases are never retried automatically, because a retry could send twice |

## 1. The sending domain and DNS

Cold mail goes from an isolated subdomain (`sending.domain`, for example `outreach.acme.example`), never your primary domain, so a deliverability problem cannot hurt the mail your team sends every day. `gtm.config.ts` refuses a `sending.from` address that is not on that subdomain. `sending.replyTo` is your real mailbox, so every reply lands in one inbox.

At your DNS host, for the sending subdomain:

- **SPF:** the TXT record your provider gives you, authorizing it to send for the subdomain.
- **DKIM:** the CNAME or TXT records your provider gives you, so receivers can verify the signature.
- **DMARC:** a TXT record at `_dmarc.<subdomain>`. Start with `p=none` and a reporting address, and move to `p=quarantine` once reports look clean.

Verify the domain in the provider's dashboard before turning anything on. Warm the domain up slowly: the ramp below does that for you.

## 2. The provider, its secrets and its webhook

The `email-resend` adapter sends through Resend's batch API (up to 100 messages a request) and verifies Resend's signed webhooks. Set the secrets with Wrangler, from `apps/worker` (or your copy of it), or in `.dev.vars` for local development:

```bash
npx wrangler secret put RESEND_API_KEY            # an API key with sending access
npx wrangler secret put RESEND_WEBHOOK_SECRET     # the webhook's signing secret (starts with whsec_)
npx wrangler secret put UNSUBSCRIBE_SIGNING_KEY   # at least 32 characters, for example: openssl rand -hex 32
```

Set `AGENT_BASE_URL` to your deployment's public https origin (a `vars` entry in `wrangler.jsonc`, for example `https://agent.acme.example`). Unsubscribe links are built from it.

| Secret or var | Used for | When it is unset |
|---|---|---|
| `RESEND_API_KEY` | Sending | Every message is refused by the provider (`failed`, not retried) |
| `RESEND_WEBHOOK_SECRET` | Verifying delivery webhooks | The webhook answers 503 |
| `UNSUBSCRIBE_SIGNING_KEY` | Signing and checking unsubscribe links | Nothing is sent (`[SEND BLOCKED:not_configured]`), and `/u/` answers 503 |
| `AGENT_BASE_URL` | Building unsubscribe links | Nothing is sent (`[SEND BLOCKED:not_configured]`) |

Adapter options (`adapters["email-resend"].options` in `gtm.config.ts`, none of them secret): `usdPerEmail` (your plan's price per email, for the cost ledger; defaults to 0.0004) and `apiBaseUrl`.

In the Resend dashboard, add a webhook endpoint at `https://<your deployment>/api/webhooks/email` for these events: `email.delivered`, `email.bounced`, `email.complained`, `email.failed` and, if offered, `email.suppressed`. Copy its signing secret into `RESEND_WEBHOOK_SECRET`. Opens and clicks are ignored: mail is plain text with no tracking.

The webhook verifies the signature (an HMAC over the message id, timestamp and body, within a 5-minute window, compared in constant time) before it reads the body or touches the database. A bad or stale signature answers 401. Each event is processed once, however often it is delivered.

| Event | What happens |
|---|---|
| Delivered | The send ledger's `delivered_at`, the recipient domain's delivered count, the campaign row |
| Hard bounce (or a bounce with no type) | The address is suppressed (`bounce`) and marked `undeliverable` on the contact and in the verification cache, and its sequences stop. Warmth is left alone, because a bad address is not an opt-out; the ledger's `bounced_at`, the domain's hard bounce count, the outreach log; a page (at most five a day) |
| Soft bounce | A funnel event only |
| Complaint | The address is suppressed (`complaint`) even when no send matches, the contact opts out; the ledger's `complained_at`, the domain's complaint count; a page |
| Failed | Logged |

If the suppression cannot be written, the webhook answers 500 so the provider delivers the event again.

## 3. Wire the worker

Give `createWorker` the email provider, register the delivery jobs, and build the send function wherever you send (the cold batch does this for you):

```ts
// apps/worker/src/index.ts
import { createWorker, type Env } from "@gtm-agents/core";
import { createAdapterContext } from "@gtm-agents/core/adapters";
import { createDeliveryJobs } from "@gtm-agents/core/sending";
import { createAdapter as resend } from "@gtm-agents/adapters/email-resend";
import { createAdapter as telegram } from "@gtm-agents/adapters/operator-telegram";
import config from "../gtm.config.ts";

const email = (env: Env) => resend(createAdapterContext({ name: "email-resend", env: { ...env }, config }));
const operator = (env: Env) => telegram(createAdapterContext({ name: "operator-telegram", env: { ...env }, config }));

export default createWorker(config, {
  email,
  operator,
  jobs: [...createDeliveryJobs({ email, operator })],
});
```

```ts
import { createOutreachSender, senderDepsFromEnv } from "@gtm-agents/core/sending";

const send = createOutreachSender(senderDepsFromEnv(env, { config, provider: email(env), operator: operator(env) }));
const outcomes = await send(items);   // one OutreachItem per message; see packages/core/src/sending/types.ts
```

Each item carries an idempotency key that is stable for that message (the cold batch uses `<date>:<contact>`). The send function claims it in the effects ledger right before sending, so the same message never goes out twice, whoever retries.

## The message

- **Plain text only.** No HTML part, no tracking pixel, no rewritten links. Replies are the metric.
- **The footer** is appended by the send function, never by a caller: your `sending.postalAddress`, and a line saying the reader can reply "unsubscribe" or open their unsubscribe link.
- **Headers:** `List-Unsubscribe` with the one-click link and a `mailto:` to your reply-to mailbox, `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), and `In-Reply-To` and `References` when a follow-up threads under an earlier message.
- **Tags** carry the send, contact, campaign, draft, template, experiment and variant ids, so delivery events match their send.

## Unsubscribe

Every message links to `https://<AGENT_BASE_URL>/u/<token>`. The token names the recipient's address and is signed with `UNSUBSCRIBE_SIGNING_KEY`, so it cannot be forged or pointed at someone else. It never expires.

- **GET** shows a confirmation page with one button. It never acts and never touches the database, because mail security scanners and link previews open links on their own.
- **POST** (the button, or a mail client's one-click unsubscribe) opts the address out: it is suppressed (`opt_out`), every contact under that mailbox moves to warmth `opted_out`, their sequences stop, queued deferred sends to them are cancelled, and you get one notice in the operator channel. Repeating it changes nothing.

Rotating the signing key invalidates links already sent; people can still reply "unsubscribe".

## Send windows and time zones

Cold and sequence mail goes out only inside `sending.windowDays` and `sending.windowHours` (by default Monday to Thursday, 08:00 to 15:00), in the recipient's own time zone. Lifecycle mail uses the same hours Monday to Friday. Replies are not windowed.

The recipient's zone is the contact's `timezone` when it is a valid IANA name. Otherwise it is read from the free-text `location`: a named country first (with regional rules for the United States, Canada and Australia), then well-known cities, then the default, `America/New_York`. Pass `options: { defaultTimezone }` to the sender to change the default. A message outside the window is deferred to the next opening.

## Caps

Both are counted from the send ledger, inside the send function, for every caller:

| Cap | Flag | Default | Overflow |
|---|---|---|---|
| Messages per UTC day through the provider (the sending domain's volume) | `delivery:domain_daily_cap` | 500 | Deferred to midnight UTC |
| Cold and sequence messages per recipient account in any 7 days | `delivery:account_weekly_cap` | 3 | Deferred until the oldest send leaves the window |

A cap that cannot be read allows nothing.

## The deferred queue

Deferred messages wait in `deferred_sends`, one queued row per contact, campaign, subject, path and sequence step. The `delivery_replay` job picks up due rows four times each weekday (00:00, 08:00, 13:00 and 20:00 UTC, which catches mornings in Asia and the Pacific, Europe, the US East coast, and the US West coast's day). For each row it:

1. claims it atomically, so two runs never take the same row;
2. cancels it if the contact is gone, opted out, no longer cold (for cold mail), or has replied since it was queued;
3. sends it through the same send function, so every check runs again;
4. marks it sent or cancelled, or puts it back with backoff (1 hour, then 2, 4 and 8). After the fifth attempt it fails, and you are paged once for that run.

## The warm-up ramp

A new sending domain earns reputation gradually, so daily cold volume follows fixed levels: 25, 50, 100, 250 and 500. The level is `outreach:ramp_level` (an index from 0); an unreadable or malformed value is level 0. The cold batch sizes itself with `readColdVolume`: the ramp level, lowered by `cold_batch:daily_limit` if you set one and by the per-domain daily cap, never above 1,500.

With `outreach:ramp_auto` on, the `delivery_ramp` job moves the level one step at a time, on evidence from the send ledger:

- **up** only when all hold: at least 7 days since the last change, sends in that time, delivered events present, the best day delivered at least 70% of the current level, hard bounces under 2% and complaints under 0.1%;
- **down** when complaints reach 0.3% of delivered mail (with at least 20 delivered), or once for each warning-level pause;
- otherwise, and while a critical pause stands, it holds.

With it off, the level changes only when you set it.

## The bounce monitor and the kill switch

The `delivery_bounce_monitor` job runs every morning. It reads hard bounces over sends for cold and sequence mail in two windows, 7 days and 1 day: under 20 sends is low volume and says nothing; under 2% is healthy; 2% to 5% warns (you are paged); 5% or more is critical.

- **Critical pauses cold outreach.** A spike only in the 1-day window, with the 7-day window still healthy, looks like one bad batch and gives a **warning** pause. Anything the 7-day window confirms gives a **critical** pause, and so does a second spike within 14 days of the monitor lifting a warning pause.
- **A warning pause lifts itself** once it is at least 3 days old and the last 3 days were clean, with one ramp step down. You are told when it lifts.
- **A critical pause is lifted only by a person.** You are reminded once a day while it stands. To lift it, from the operator path or with Wrangler:

```bash
npx wrangler kv key delete --binding KV --remote "outreach:cold-pause:critical"
npx wrangler kv key delete --binding KV --remote "outreach:cold-pause"
```

The monitor adds a critical pause only when none stands, and never overwrites, lowers or lifts one. A pause stops cold and sequence mail; replies and lifecycle mail keep flowing. The system halt (`system:halt`) stops everything. Both fail closed: state that cannot be read counts as halted or paused.

## The circuit breaker

Three consecutive provider failures in one UTC day open the breaker for the rest of that day: sends are deferred to midnight UTC, and you are paged once. A batch the provider accepts resets the count. A message the provider rejects as invalid does not count against it.

## Liveness

With `cold_batch:enabled` on, the `delivery_liveness` job checks each weekday evening and pages you when no mail went out in 3 days, or when today is a window day with eligible contacts and nothing went out. The page lists what may be holding mail back: the halt, a pause, a switch that is off, the breaker, drafts waiting for approval, the deferred queue and the ramp level.

## Flags

Set a flag with `npx gtm flags set <key> <value>` (checked against the flag registry); `npx gtm flags unset <key>` returns it to the default. `gtm doctor` lists them all.

| Flag | Default | What it does |
|---|---|---|
| `delivery:enabled` | off | The master switch: off, the send function sends nothing (`[SEND BLOCKED:disabled]`). Also gates the deferred replay and the bounce monitor |
| `delivery:domain_daily_cap` | 500 | Messages per UTC day through the provider |
| `delivery:account_weekly_cap` | 3 | Cold and sequence messages per account in any 7 days |
| `outreach:ramp_level` | 0 (25 a day) | The warm-up level index |
| `outreach:ramp_auto` | off | Let the ramp job move the level |
| `cold_batch:daily_limit` | unset | An operator limit that can only lower the ramp level |
| `cold_batch:enabled` | off | The cold batch's master switch; also turns on the liveness check |

The jobs also keep state in KV, shown by `gtm doctor`: `outreach:ramp_changed_at`, `delivery:breaker:<day>` and `delivery:last_auto_resume`.

To start sending: verify the domain, set the secrets and `AGENT_BASE_URL`, register the webhook, then turn on `delivery:enabled`. Leave `outreach:ramp_auto` off until a week of delivered mail has come in.

## Jobs

| Job | Schedule (UTC) | Flag | Ceilings |
|---|---|---|---|
| `delivery_replay` | 00:00, 08:00, 13:00, 20:00, Monday to Friday | `delivery:enabled` | 200 rows, 4 minutes |
| `delivery_bounce_monitor` | 09:00 every day | `delivery:enabled` | 1 minute |
| `delivery_ramp` | 09:30, Monday to Friday | `outreach:ramp_auto` | 30 seconds |
| `delivery_liveness` | 21:00, Monday to Friday | `cold_batch:enabled` | 30 seconds |

None of them calls a model. Pass `options` to `createDeliveryJobs` to change a schedule or the replay's row ceiling. Pages go through the operator channel ([OPERATOR.md](OPERATOR.md)), each claimed once per day (or per replay run) in the effects ledger.

## Limits

- Resend's batch endpoint accepts or refuses a batch whole and takes one idempotency key per request, so the adapter keys each request by a hash of its messages' keys. The effects ledger is the exact guard against sending twice.
- Time zones inferred from a free-text location are approximate: one representative zone per country or region. Store `timezone` on the contact when you know it.
- A message whose acceptance is unclear (a time-out, an unknown provider error) is reported as `failed` and never retried automatically. Check the provider's dashboard before sending it again by hand.
