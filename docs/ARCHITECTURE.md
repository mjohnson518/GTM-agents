# Architecture

This page is for anyone deciding whether to adopt GTM-agents, deployers who want the whole picture before they start, and contributors finding where a change belongs. GTM-agents runs the whole revenue loop for one product with one human operator, as a single Cloudflare Worker. This page describes how a deployment works; [ROADMAP.md](ROADMAP.md) says what exists today, and [BLUEPRINT.md](BLUEPRINT.md) is the full design, including parts not built yet.

## What a deployment does

```
research -> identify -> source -> enrich -> score -> outreach -> follow-up -> reply -> convert -> lifecycle
                                              |           |           |
                                              +---- quality gate -----+
            product feedback -> themes -> spec -> sandbox build -> pull request (a person merges)
                         experiments, ledger, holdout -> learnings (a person approves) -> next batch
```

It finds the right accounts and people, finds a dated reason to write to them, sends plain-text email, learns which copy works, answers replies, books meetings, and follows customers through sign-up and payment. Every consequential step is gated and measured. Each class of action is either approved by a person or has earned autonomy from evidence.

## Shape

```
   Operator dashboard (WebSocket RPC)            Operator chat (webhook -> CHAT_QUEUE)
                  |                                            |
   OperatorGateway (Durable Object)                            |
                  \                                            /
                   +------------ hub agent (strategist) ------+
                                          |
                  Tool dispatcher (taint-classified, rate-limited, budgeted)
                                          |
         D1 (truth)    KV (flags, caches)    R2 (payloads, archives)    Queues
                                          |
              Scheduled jobs (job registry, fault-tolerant runner, halt-aware)
                                          |
   Webhooks in: mailbox push, email provider events, product events, billing, search monitors,
                the code host (ship module)
```

The autonomous loop does not depend on the agent. Most scheduled work is deterministic code with narrow, schema-bound model calls. The hub agent handles operator conversation, research and ad-hoc work. That split keeps cost predictable and behavior testable.

## Packages

| Package | Owns |
|---|---|
| `packages/core` | The runtime. `createWorker(config)`, the job registry, pipeline stages, lifecycle, the safety spine, experiments and the scorecard, the brain loader and template engine, the data layer and D1 migrations, and the port interfaces |
| `packages/adapters` | Vendor integrations, one folder per adapter, each behind a port, published as subpaths (`@gtm-agents/adapters/email-resend`) |
| `packages/sdk` | What a host application installs: the product event emitter, signature helpers and typed events. It has no Cloudflare dependency |
| `packages/cli` | The `gtm` command: `init`, `setup`, `doctor`, `migrate`, `brain`, `flags`, `deploy` |
| `packages/modules` | Optional features behind flags. The ship module is built; `link-intake`, `classifier-tier` and `code-mode` are specified in [BLUEPRINT.md](BLUEPRINT.md) and not built |
| `apps/worker` | The deployable Worker and the template `gtm init` copies |
| `apps/admin` | The operator dashboard (Lit and Vite), served at `/admin` |

## Ports and adapters

Core never imports a vendor SDK. Every third party (email providers, mailboxes, data providers, model providers, calendars, billing, the operator channel) sits behind a port defined in core and implemented by an adapter. Adapters translate requests and responses; core makes every decision. That is why suppression, send windows, caps, budgets, retries and the kill switch each have exactly one implementation. [INTERFACES.md](INTERFACES.md) is the contract.

## Bindings

`apps/worker/wrangler.jsonc` declares these bindings. Every resource id and name is a `${...}` placeholder until `gtm setup` fills it in, except the Worker and bucket names, which start as the defaults `gtm-agent` and `gtm-agent-bucket` because Wrangler validates their format.

| Binding | Cloudflare product | Used for |
|---|---|---|
| `DB` | D1 | The system of record: contacts, accounts, drafts, the send ledger, events, runs, costs, suppression, and long-term memory text |
| `KV` | Workers KV | Feature flags, the halt flag and kill switch, caches, counters, rate-limit windows, the approved brain files and their lock |
| `BUCKET` | R2 | Inbound mail bodies and the raw payloads of product and billing events |
| `MEMORY` | Vectorize | Reserved for vector memory. The template binds it so later capabilities need no new resource; nothing reads or writes it yet |
| `AI` | Workers AI | Reserved for embeddings and small hosted classifiers. Bound in the template; nothing calls it yet |
| `GATEWAY` | Durable Object `OperatorGateway` | The dashboard's WebSocket connections and requests, including its chat view |
| `FOLLOWUP_AGENT` | Durable Object `FollowupAgent` | Declared so the binding set validates; it answers 501 to every request ([below](#durable-objects-and-why)) |
| `EVENTS_QUEUE` | Queue (`gtm setup` names it `<worker>-events`, with a `-dlq` dead-letter queue) | Event spine dispatch |
| `CHAT_QUEUE` | Queue (`<worker>-chat`) | Operator chat turns, moved off the webhook path and run one at a time |
| `JOBS_QUEUE` | Queue (`<worker>-jobs`, with a `-dlq` dead-letter queue; optional) | One message per due job, so each runs in its own invocation |
| `ASSETS` | Static assets | The operator dashboard at `/admin` |

`src/index.ts` lists each environment's queue names (`agent.chatQueue`, `createLifecycle`'s `eventsQueue`, `scheduler.jobsQueue` and `scheduler.deadLetterQueue`; unset, they default to `gtm-chat`, `gtm-events`, `gtm-jobs` and `gtm-jobs-dlq`). A batch that arrives on a queue it does not list is still handled by its message kind, with a warning in the logs. Optional modules add their own bindings, for example a container and a Workflow for the ship module.

## Storage roles

- **The database is the truth.** Agents query state; they do not remember it. [DATA-MODEL.md](DATA-MODEL.md) describes the tables.
- KV and the vector index are caches that can be rebuilt from D1. R2 is the archive of what D1 points to, such as inbound email bodies: D1 says which messages exist, R2 holds their text, and a missing body reads as missing rather than empty. Back it up if you need the text.
- **The account key** is the lowercased registrable domain without `www.`, and everything account-level joins on it. Personal mail domains and shared hosts are never accounts.
- **Fields that only some deployments need** (a buyer's budget band, an account's stage, a niche attribute) go in the `attributes` JSON column of contacts and accounts, never in new columns.

## The event spine

Every product and billing event takes the same path:

1. **Record.** The raw payload is written to R2 first. Then an event row is inserted, keyed by the provider's event id. A redelivered webhook is a no-op insert and is never dispatched twice.
2. **Dispatch** to `EVENTS_QUEUE`, or inline when no queue is bound.
3. **Route** under a lease. A lease is stale after 10 minutes. After 5 failed attempts the event is parked and audited.
4. **Sweep.** Every 5 minutes, unrouted events older than 5 minutes are picked up again.

Each event carries a taint level. Free text from outside, such as product feedback, is full taint. Side effects of routing are claimed in the effects ledger, so redelivery never repeats them. Other inbound webhooks (search monitor hits, the ship module's code host events) verify their signature and claim each delivery in the effects ledger or a unique row, without the spine.

Product events arrive at `POST /api/webhooks/product` (HMAC, [EVENT-CONTRACT.md](EVENT-CONTRACT.md)), through the product bridge, and billing events at `POST /api/webhooks/billing` (verified by the billing adapter). Routing them moves the contact through the lifecycle states, which one module writes with compare-and-set, and mirrors the deal one stage at a time, never backwards. A nightly signed pull from the product repairs anything a push missed. [LIFECYCLE.md](LIFECYCLE.md) covers it, and the host SDK (`@gtm-agents/sdk`) is what a host application installs.

## Durable Objects, and why

- **`OperatorGateway`** is a single instance holding the dashboard's WebSocket connections through the hibernation API. An idle dashboard costs nothing; the runtime answers pings without waking the object. The Worker checks the Origin, the Cloudflare Access token and the allowlist before it hands an upgrade to the object, and the object reads identity only from what the Worker verified, never from a frame. RPC is default-deny: only `connect` and `health` work before `connect` succeeds.
- **`FollowupAgent`** is declared so a deployment's binding set validates and deploys, and answers 501 to every request. Lifecycle follow-ups use the database as their timer instead: each kind is due a fixed delay after the contact entered their current state, and the `lifecycle_followups` job finds what is due with one bounded query, so a transition reschedules every timer by itself and no alarm can fire after an erasure ([LIFECYCLE.md](LIFECYCLE.md)).

## Scheduling: the job registry

Scheduled work is data:

```ts
defineJob({
  name: "sequence_sweep",
  schedule: "30 8,12,16,20 * * MON-FRI",
  flag: "sequences:enabled",
  ceilings: { maxDurationMs: 240_000, maxRows: 200, maxSpendCents: 25 },
  critical: true,
  rerunnable: true,
  run: async (ctx) => { /* ... */ },
});
```

- The Worker has one cron trigger, `* * * * *`. Each minute the scheduled handler asks the registry which jobs are due at that minute (UTC, from each job's own schedule) and runs them concurrently, at most four at a time, longest ceiling first, each under its own ceiling. It is a loop, not a switch statement, and changing a schedule never touches `wrangler.jsonc`. A minute with nothing due touches no binding. A job whose ceiling would not fit in the invocation's remaining wall time is not started: it gets a failed run row and the normal failure page, rather than being cut off. A job whose previous run is still going is skipped.
- With `JOBS_QUEUE` bound and `scheduler:queue_enabled` on, the handler sends each due job to the queue instead. The consumer runs one job per invocation, claimed per (job, minute) in the effects ledger, so a redelivered message or a duplicate trigger is a no-op. Dead-lettered fires get a failed run row and one page a day. The retention job prunes those claims after 30 days.
- A ceiling is not a hard stop. At its ceiling a job's AbortSignal fires and its run is recorded as failed, but JavaScript cannot cancel a promise, so a body that ignores the signal keeps running. The scheduler keeps that job's slot taken until it settles, the invocation's wall budget runs out, or no job is left waiting to start, so a stuck job costs the minute one slot instead of running beside the jobs after it. Long work should check `ctx.signal` between steps.
- A daily retention job (`run_retention`, behind `ops:retention_enabled`) deletes old run rows, always keeping the newest row of each job and status, which cron health and the follow-up intake gate read.
- Schedules use named days. On Cloudflare, numeric day-of-week `1` is Sunday, so `MON-FRI` is the only unambiguous form. The registry rejects numeric days.
- Every job runs inside a fault-tolerant runner:
  - It writes a run row (running, then completed, failed or skipped), including for jobs it holds because the system is halted, the job's flag is off or its budget is spent.
  - It enforces the job's duration ceiling, and checks the budget before a job that declares `maxSpendCents`.
  - It pages the operator at most once per job per UTC day, and escalates configuration errors and repeated failures at most once a day.
  - One job's failure never stops the next.
- A cron health check runs on the schedule `src/index.ts` gives it (`cronHealth.schedule`; the template runs it twice a day). It confirms that every critical job completed after its last expected time, and it reruns, at most once, the jobs that are safe to rerun.
- [SECURITY-MODEL.md](SECURITY-MODEL.md#scheduled-jobs) has the details.
- Model calls never run in a per-minute job.

## Agents and model roles

Core asks the model gateway for a **role**, never a model id. `gtm.config.ts` maps roles to models.

| Role | Used for |
|---|---|
| `strategist` | The hub agent the operator talks to, the daily retrospective, evolution candidates and ship module specs |
| `worker` | The research scenarios of the weekly benchmark; reserved for delegated worker agents |
| `writer` | Reply drafts, and the outreach scenarios of the weekly benchmark |
| `judge` | The quality reviewer for outbound text, the agent review and benchmark scoring |
| `triage` | Classifying inbound replies, and triaging product feedback in the ship module |
| `classifier` | Cheap yes/no and typed decisions: the optional account fit score and lifecycle follow-up checks |
| `coder` | The sandboxed coding agent in the ship module |
| `embedding` | Theme matching in the ship module |

**Deterministic by default.**
- No model writes a cold first touch. Cold copy is assembled from operator-written templates and copy lines by substitution.
- Models triage, draft replies, judge and plan.
- Every message that may leave without a person reading it passes a deterministic gate first, then a model reviewer. If the reviewer is unavailable, the message is held: a reviewer outage stops automatic sends instead of waving them through.

**The hub agent's tools.** The hub agent runs a bounded tool loop (at most 8 model rounds a turn by default) with three tools: `web_fetch`, `contacts_search` and `drafts_create` ([OPERATOR.md](OPERATOR.md)).

**Delegation.** The tool classes already declare delegation tools, and the dispatcher carries taint across a delegation: a worker starts at its parent's taint level, and the parent can only rise when it returns ([SECURITY-MODEL.md](SECURITY-MODEL.md#delegation)). No worker agents ship yet, so the hub agent does its own work.

## The safety spine

These controls are built into core, and the suites in `tests/security/` cover each of them. Every adapter and module also runs the security contract over its own tools.

| Control | What it guarantees |
|---|---|
| Taint model | Every tool declares the taint its output carries (`none < metadata < structured < full`) and the taint level at which it is refused. Once a session has read untrusted text, tools that send, write or spend are refused. Gates never loosen as taint rises. An unknown tool is treated as fully tainted |
| Sanitize and fence | Untrusted text is redacted for injection patterns, keeping the surrounding bytes, and wrapped in a fence derived from the content, so it cannot close its own block. It goes into the user turn, never into a system prompt |
| Approval digests | An approval binds to a hash of exactly what was shown. Editing an approved draft sends it back to review |
| Effects ledger | `claimEffect(db, eventId, effect)` returns true exactly once. Every side effect outside the database is claimed first |
| Budgets and rate limits | Rate limits and the budget gate run before a paid call: global daily and monthly limits, per-job caps (always enforced), a per-run ceiling and a per-turn chat ceiling. Every call writes a row to the cost ledger |
| Halt flag and kill switch | The halt flag (`system:halt`) stops every job and every send. The kill switch (`outreach:cold-pause` and `outreach:cold-pause:critical`) stops cold first touches and follow-ups. Both fail closed: if their state cannot be read, the system treats itself as halted or paused |
| Suppression | Opt-outs, bounces, complaints and erasures. It is checked inside the send function on every send path, fails closed, and has no remove tool |
| Earned autonomy | Each action class starts at "draft and ask". Promotion is proposed from measured outcomes and applied by a person. Merging code, pricing, billing and auth changes, offers and discounts, proof-of-value sends and data deletion are permanently human |

[SECURITY-MODEL.md](SECURITY-MODEL.md) covers the taint model, the tool dispatcher, the fence, egress checks, delegation and approvals in detail.

The rule behind all of them: **gates fail closed, bookkeeping fails open.** A gate whose input cannot be read blocks. An audit row, memory write or cost record that fails is logged and dropped, and never blocks a send.

## The send path

A send takes one of four send paths: `cold`, `sequence`, `reply` or `lifecycle`. Every send passes these checks inside the send function itself, so no caller can skip them. Before any of them, `delivery:enabled` must be on and the configuration a compliant message needs must be present (a provider, the unsubscribe signing key and a public https base URL); otherwise the item comes back as a retryable failure. Then, in order:

1. The halt flag, and the kill switch for cold and sequence mail (both defer).
2. Suppression (fails closed).
3. Content lint.
4. The verification policy for the path.
5. The approval digest, when the send relies on an approval.
6. The recipient-local send window (outside it, the item waits in the deferred queue).
7. Per-domain daily and per-account weekly caps.
8. The provider circuit breaker.

Then the send function:
- chunks to the provider's batch limit;
- claims each message's idempotency key in the effects ledger;
- appends the plain-text postal footer to cold, sequence and lifecycle mail (a reply to someone who wrote in carries the headers but no visible footer);
- adds `List-Unsubscribe` and threading headers;
- tags the message for webhook correlation;
- records the send in the ledger.

The same send function serves two providers. Cold first touches, sequence follow-ups and lifecycle mail go through the email provider; when a warm mailbox (an InboxProvider) is configured, every approved reply goes through it instead, on the thread the person wrote on, and nothing else does. Halt, suppression, lint, verification, the approval digest and the effects-ledger claim apply on both; the per-domain cap and the circuit breaker belong to the email provider.

[SENDING.md](SENDING.md) covers the provider, the footer and unsubscribe, windows, the ramp and the bounce monitor; [OUTREACH.md](OUTREACH.md) covers the quality gate and the daily cold batch; [SEQUENCES.md](SEQUENCES.md) covers follow-ups.

## Replies and follow-ups

Inbound mail arrives two ways: a mailbox the Worker polls every minute and is woken by push (Gmail), or Cloudflare Email Routing delivering to the Worker's `email()` entry point. Intake records each message once, classifies it structurally without a model (bounce, auto reply, out of office, unsubscribe, reply, new inquiry) and applies the deterministic consequences at once: a reply stops every sequence at the account, an unsubscribe suppresses the sender, an out-of-office reply holds the next step, a delivery report for an address we sent to suppresses it. Model triage, routing, the meeting qualifier and drafting run afterwards in their own jobs, and every reply draft waits for a person's approval. The follow-up sweep sends sequence steps threaded under the first email, re-checking for replies from anyone at the account right before each send. [INBOX.md](INBOX.md), [REPLIES.md](REPLIES.md) and [SEQUENCES.md](SEQUENCES.md) cover each part.

## Autonomy

Every action class has a level, from 0 (observe) to 3, read by one reader that fails closed to 1; the permanently human-only classes never go above 1. Every decision point records evidence (approved unchanged, edited, rejected, sent automatically, incident). A weekly review proposes promotions from that evidence and the outcome metrics, and only an operator's confirmed command applies one; an hourly watch demotes a class immediately after an incident on an automatic send. An automatic reply needs its class at level 2 or above, `inbound:auto_send_tier`, `replies:send_enabled` and the model reviewer on, every auto-send rule and the quality gate. `@gtm-agents/core/autonomy` holds the parts that need no Worker bindings (classes, rules, the writer registry); `/autonomy/runtime` holds the jobs and stores. [AUTONOMY.md](AUTONOMY.md) covers it.

## Meetings

Calendar sync reads the operator's calendar every 15 minutes, read-only, asking only for times, attendees and the organizer. A booking needs an outside attendee who accepted, or an invite the operator organized, and it is attributed to a contact by address, or by the one contact at that company contacted recently; there is no click tracking. A booked meeting stops every sequence at the company, moves the contact to hot and the deal to demo scheduled, writes a static prep brief and reminds the operator before the meeting. Recaps, rebooks and post-meeting steps are drafts a person approves. [CONVERT.md](CONVERT.md) covers it.

Email is plain text, with no tracking pixels or click tracking, so replies are the metric. Cold, follow-up and lifecycle mail go from an isolated sending subdomain through the email provider. Approved replies go from the real mailbox. `Reply-To` on provider mail points at that mailbox, so every reply lands in one inbox.

## HTTP surface

| Route | Authentication |
|---|---|
| `GET /health` | None |
| Any other `/api/*` route | Bearer token (`GATEWAY_TOKEN`). Core adds none of its own; a deployment adds them with `routes` in `src/index.ts` |
| `POST /api/webhooks/operator` | Operator channel secret, plus the chat allowlist |
| `POST /api/webhooks/mail` | Mailbox push shared secret, compared in constant time |
| `POST /api/webhooks/email` | Email provider signature |
| `POST /api/webhooks/product` | HMAC (see [EVENT-CONTRACT.md](EVENT-CONTRACT.md)) |
| `POST /api/webhooks/billing` | Billing provider signature |
| `POST /api/webhooks/search/:key` | The monitor's own secret (the template registers this route) |
| `POST /api/webhooks/code` | Code host signature (the ship module, when wired) |
| `GET, POST /u/:token` | Signed unsubscribe token. GET only confirms; POST opts out, because link scanners prefetch |
| `/admin/*` | Static assets; put them behind Cloudflare Access ([DASHBOARD.md](DASHBOARD.md)) |
| `/ws` | Cloudflare Access, verified in the Worker, plus the operator allowlist and `admin:enabled` ([DASHBOARD.md](DASHBOARD.md)) |

Every `/api/webhooks/*` route skips the bearer token and verifies its own signature before it touches the database, and returns 503 when its secret is not configured. Besides `fetch`, `scheduled` and `queue`, the Worker exports `email()` for mail that Cloudflare Email Routing delivers, when `inboundEmail` is wired in `src/index.ts`. Request bodies are limited to 100 KB, whether or not the request carries a `Content-Length` header.

## Configuration, brain and templates

Everything specific to one company lives in three places, so selling a different product never needs a code change:

- **`gtm.config.ts`:**
  - company and agent name;
  - sending addresses, reply-to, support address and postal footer;
  - enabled adapters and their options;
  - model ids per role;
  - autonomy defaults;
  - sequences;
  - modules;
  - the operator chat allowlist;
  - the `admin` section for the dashboard (Cloudflare Access and the allowed emails).
- **`brain/`:** short, typed, operator-approved lists that prompts read, such as personas, ICP, message pillars, objections, voice and facts. See [BRAIN-SCHEMA.md](BRAIN-SCHEMA.md).
- **`templates/`:** operator-written email templates with frontmatter.

Secrets come from `wrangler secret put`, never from files. Behavior that could surprise someone sits behind a flag in KV that defaults to off; the flag registry is `packages/core/src/flags/registry.ts`. `gtm doctor` lists every flag and its default, and `gtm flags list` shows each deployed value.

## One deployment, one company

A deployment serves exactly one company and one product. A second product means a second deployment, with its own database, brain, sending domain and budget. [DECISIONS.md](DECISIONS.md) (ADR-001) explains the trade.
