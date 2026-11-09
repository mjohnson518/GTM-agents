# Architecture

GTM-agents runs the whole revenue loop for one product with one human operator, as a single Cloudflare Worker. This document describes the system as designed. [ROADMAP.md](ROADMAP.md) says which parts exist today.

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
          Admin dashboard (WebSocket RPC)          Operator chat (webhook -> queue)
                         \                           /
                          +----- OperatorGateway ---+
                                       |
                            Strategist (hub agent)
                     delegates to: Executor | Ops | Sender | Coder
                                       |
                Tool layer (grouped, taint-classified, rate-limited, budgeted)
                                       |
      D1 (truth)    KV (flags, caches)    R2 (payloads, archives)    Vectorize (memory)    Queues
                                       |
            Scheduled jobs (job registry, fault-tolerant runner, halt-aware)
                                       |
   Webhooks in: mailbox push, email provider events, product events, billing, git host, search monitors
```

The autonomous loop does not depend on the agents. Most scheduled work is deterministic code with narrow, schema-bound model calls. The agents handle operator conversation, research and ad-hoc work. That split keeps cost predictable and behavior testable.

## Packages

| Package | Owns |
|---|---|
| `packages/core` | The runtime. `createWorker(config)`, the job registry, pipeline stages, lifecycle, the safety spine, experiments and the scorecard, the brain loader and template engine, the data layer and D1 migrations, and the port interfaces |
| `packages/adapters` | Vendor integrations, one folder per adapter, each behind a port, published as subpaths (`@gtm-agents/adapters/email-resend`) |
| `packages/sdk` | What a host application installs: the product event emitter, signature helpers and typed events. It has no Cloudflare dependency |
| `packages/cli` | The `gtm` command: `init`, `setup`, `doctor`, `migrate`, `brain`, `flags`, `deploy` |
| `packages/modules` | Optional features behind flags: `ship`, `link-intake`, `classifier-tier`, `code-mode` |
| `apps/worker` | The deployable Worker and the template `gtm init` copies |
| `apps/admin` | The operator dashboard (Lit and Vite), served at `/admin` |

## Ports and adapters

Core never imports a vendor SDK. Every third party (email providers, mailboxes, data providers, model providers, calendars, billing, the operator channel) sits behind a port defined in core and implemented by an adapter. Adapters translate requests and responses; core makes every decision. That is why suppression, send windows, caps, budgets, retries and the kill switch each have exactly one implementation. [INTERFACES.md](INTERFACES.md) is the contract.

## Bindings

`apps/worker/wrangler.jsonc` declares these bindings. Every resource id and name is a `${...}` placeholder until `gtm setup` fills it in, except the Worker and bucket names, which start as the defaults `gtm-agent` and `gtm-agent-bucket` because Wrangler validates their format.

| Binding | Cloudflare product | Used for |
|---|---|---|
| `DB` | D1 | The system of record: contacts, accounts, drafts, the send ledger, events, runs, costs, suppression |
| `KV` | Workers KV | Feature flags, the halt flag and kill switch, caches, counters, rate-limit windows, the approved brain files and their lock |
| `BUCKET` | R2 | Raw event payloads, research briefs, run journals, redacted archives |
| `MEMORY` | Vectorize | Long-term memory. Dimensions match the configured embedding model |
| `AI` | Workers AI | Embeddings and small hosted classifiers |
| `GATEWAY` | Durable Object `OperatorGateway` | WebSocket RPC for the dashboard, and serialized operator chat |
| `FOLLOWUP_AGENT` | Durable Object `FollowupAgent` | Per-contact lifecycle timers |
| `EVENTS_QUEUE` | Queue (`gtm-events` by default) | Event spine dispatch |
| `CHAT_QUEUE` | Queue (`gtm-chat` by default) | Long chat turns, moved off the webhook path |
| `ASSETS` | Static assets | The admin dashboard |

Optional modules add their own bindings, for example a container and a Workflow for `ship`.

## Storage roles

- **The database is the truth.** Agents query state; they do not remember it. [DATA-MODEL.md](DATA-MODEL.md) describes the tables.
- KV, R2 and the vector index are caches or archives that can be rebuilt from D1.
- **The account key** is the lowercased registrable domain without `www.`, and everything account-level joins on it. Personal mail domains and shared hosts are never accounts.
- **Fields that only some deployments need** (a buyer's budget band, an account's stage, a niche attribute) go in the `attributes` JSON column of contacts and accounts, never in new columns.

## The event spine

Every external event (product events, billing, git host, deploys, search monitors) takes the same path:

1. **Record.** The raw payload is written to R2 first. Then an event row is inserted, keyed by the provider's event id. A redelivered webhook is a no-op insert and is never dispatched twice.
2. **Dispatch** to `EVENTS_QUEUE`, or inline when no queue is bound.
3. **Route** under a lease. A lease is stale after 10 minutes. After 5 failed attempts the event is parked and audited.
4. **Sweep.** Every 5 minutes, unrouted events older than 5 minutes are picked up again.

Each event carries a taint level. Free text from outside, such as product feedback, is full taint. Side effects of routing are claimed in the effects ledger, so redelivery never repeats them.

## Durable Objects, and why

- **`OperatorGateway`** is a single instance holding the dashboard's WebSocket connections through the hibernation API. An idle dashboard costs nothing; the runtime answers pings without waking the object. RPC is default-deny: only `connect` and `health` work before the session presents a valid token. Origin and token checks happen on connect.
- **`FollowupAgent`** is one instance per contact. A lifecycle transition (signed up, activated, at a plan limit, stalled, churned) reschedules that contact's timers with Durable Object alarms. A follow-up fires at the right moment for that one person, with no cron job scanning every contact.

## Scheduling: the job registry

Scheduled work is data:

```ts
defineJob({
  name: "followup_sweep",
  schedule: "0 14 * * MON-FRI",
  flag: "followup:enabled",
  ceilings: { maxRows: 500, maxSpendCents: 50, maxDurationMs: 60_000 },
  critical: true,
  run: async (ctx) => { /* ... */ },
});
```

- The Worker has one cron trigger, `* * * * *`. Each minute the scheduled handler asks the registry which jobs are due at that minute (UTC, from each job's own schedule) and runs them concurrently, at most four at a time, longest ceiling first, each under its own ceiling. It is a loop, not a switch statement, and changing a schedule never touches `wrangler.jsonc`. A minute with nothing due touches no binding. A job whose ceiling would not fit in the invocation's remaining wall time is not started: it gets a failed run row and the normal failure page, rather than being cut off. A job whose previous run is still going is skipped.
- Schedules use named days. On Cloudflare, numeric day-of-week `1` is Sunday, so `MON-FRI` is the only unambiguous form. The registry rejects numeric days.
- Every job runs inside a fault-tolerant runner:
  - It writes a run row (running, then completed, failed or skipped), including for jobs it holds because the system is halted, the job's flag is off or its budget is spent.
  - It enforces the job's duration ceiling, and checks the budget before a job that declares `maxSpendCents`.
  - It pages the operator at most once per job per UTC day, and escalates configuration errors and repeated failures at most once a day.
  - One job's failure never stops the next.
- A cron health check runs twice a day. It confirms that every critical job completed after its last expected time, and it reruns, at most once, the jobs that are safe to rerun.
- [SECURITY-MODEL.md](SECURITY-MODEL.md#scheduled-jobs) has the details.
- Model calls never run in a per-minute job.

## Agents and model roles

Core asks the model gateway for a **role**, never a model id. `gtm.config.ts` maps roles to models.

| Role | Used for |
|---|---|
| `strategist` | The hub agent the operator talks to. It plans, delegates and reviews |
| `worker` | Delegated research and operations work |
| `writer` | Non-cold drafts: replies, follow-ups, objection answers |
| `judge` | The quality reviewer for outbound text |
| `triage` | Classifying inbound replies |
| `classifier` | Cheap yes/no and typed extraction |
| `coder` | The sandboxed coding agent in the `ship` module |
| `embedding` | Memory and similarity |

**Deterministic by default.**
- No model writes a cold first touch. Cold copy is assembled from operator-written templates and copy lines by substitution.
- Models triage, draft replies, judge and plan.
- Every message that may leave without a person reading it passes a deterministic gate first, then a model reviewer. If the reviewer is unavailable, the message is held: a reviewer outage stops automatic sends instead of waving them through.

**Delegation.** A delegation is a real model call with a curated tool subset, a round limit and a budget check. A worker starts at its parent's taint level and can only raise it on return. Workers never receive delegation tools.

## The safety spine

These controls are built in from the start. Each is covered by the security contract tests that every adapter and module also runs.

| Control | What it guarantees |
|---|---|
| Taint model | Every tool declares the taint its output carries (`none < metadata < structured < full`) and the taint level at which it is refused. Once a session has read untrusted text, tools that send, write or spend are refused. Gates never loosen as taint rises. An unknown tool is treated as fully tainted |
| Sanitize and fence | Untrusted text is redacted for injection patterns, keeping the surrounding bytes, and wrapped in a fence derived from the content, so it cannot close its own block. It goes into the user turn, never into a system prompt |
| Approval digests | An approval binds to a hash of exactly what was shown. Editing an approved draft sends it back to review |
| Effects ledger | `claimEffect(eventId, effect)` returns true exactly once. Every side effect outside the database is claimed first |
| Budgets and rate limits | Rate limits and the budget gate run before a paid call: global daily and monthly limits, per-job caps (always enforced), a per-run ceiling and a per-turn chat ceiling. Every call writes a row to the cost ledger |
| Halt flag and kill switch | The halt flag stops every job and every send. The kill switch stops cold outreach. Both fail closed: if their state cannot be read, the system treats itself as halted or paused |
| Suppression | Opt-outs, bounces, complaints and erasures. It is checked inside every send path, fails closed, and has no remove tool |
| Earned autonomy | Each action class starts at "draft and ask". Promotion is proposed from measured outcomes and applied by a person. Merging code, pricing, billing and auth changes, offers and discounts, proof-of-value sends and data deletion are permanently human |

[SECURITY-MODEL.md](SECURITY-MODEL.md) covers the taint model, the tool dispatcher, the fence, egress checks, delegation and approvals in detail.

The rule behind all of them: **gates fail closed, bookkeeping fails open.** A gate whose input cannot be read blocks. An audit row, memory write or cost record that fails is logged and dropped, and never blocks a send.

## The send path

Every send passes these checks inside the send function itself, so no caller can skip them:

1. The halt flag, and the kill switch for cold mail (both defer).
2. Suppression (fails closed).
3. Content lint.
4. The verification policy for the path.
5. The approval digest, when the send relies on an approval.
6. The recipient-local send window (outside it, the item waits in the deferred queue).
7. Per-domain daily and per-account weekly caps.
8. The provider circuit breaker.

Then the path:
- chunks to the provider's batch limit;
- appends the plain-text postal footer to cold and sequence mail (a reply to someone who wrote in carries the headers but no visible footer);
- adds `List-Unsubscribe` and threading headers;
- tags the message for webhook correlation;
- records the send in the ledger.

The same send function serves two providers. Cold first touches and sequence follow-ups go through the email provider; approved replies go through the warm mailbox (an InboxProvider), on the thread the person wrote on. A reply is refused rather than sent through the cold provider when the mailbox is configured, and cold mail never goes through the mailbox. Halt, suppression, lint, verification, the approval digest and the effects-ledger claim apply on both.

[SENDING.md](SENDING.md) covers the provider, the footer and unsubscribe, windows, the ramp and the bounce monitor; [OUTREACH.md](OUTREACH.md) covers the quality gate and the daily cold batch; [SEQUENCES.md](SEQUENCES.md) covers follow-ups.

## Replies and follow-ups

Inbound mail arrives two ways: a mailbox the Worker polls every minute and is woken by push (Gmail), or Cloudflare Email Routing delivering to the Worker's `email()` entry point. Intake records each message once, classifies it structurally without a model (bounce, auto reply, out of office, unsubscribe, reply, new inquiry) and applies the deterministic consequences at once: a reply stops every sequence at the account, an unsubscribe suppresses the sender, an out-of-office reply holds the next step, a delivery report for an address we sent to suppresses it. Model triage, routing, the meeting qualifier and drafting run afterwards in their own jobs, and every reply draft waits for a person's approval. The follow-up sweep sends sequence steps threaded under the first email, re-checking for replies from anyone at the account right before each send. [INBOX.md](INBOX.md), [REPLIES.md](REPLIES.md) and [SEQUENCES.md](SEQUENCES.md) cover each part.

Email is plain text, with no tracking pixels or click tracking, so replies are the metric. Cold mail goes from an isolated subdomain through the email provider. Replies and lifecycle mail go from the real mailbox. `Reply-To` on cold mail points at that mailbox, so every reply lands in one inbox.

## HTTP surface

| Route | Authentication |
|---|---|
| `GET /health` | None |
| `GET /api/v1/runs/:id` | Bearer token |
| `POST /api/webhooks/operator` | Operator channel secret, plus the chat allowlist |
| `POST /api/webhooks/mail` | Mailbox push shared secret, compared in constant time |
| `POST /api/webhooks/email` | Email provider signature |
| `POST /api/webhooks/product` | HMAC (see [EVENT-CONTRACT.md](EVENT-CONTRACT.md)) |
| `POST /api/webhooks/billing` | Billing provider signature |
| `POST /api/webhooks/git`, `/api/webhooks/deploy` | HMAC |
| `POST /api/webhooks/search/:id` | Per-monitor HMAC |
| `GET, POST /u/:token` | Signed unsubscribe token. GET only confirms; POST opts out, because link scanners prefetch |
| `GET /b/:token` | Signed booking token |
| `/admin/*` | Static assets; put them behind your access layer |
| `/ws` | Token in the `connect` call |

Every webhook verifies its signature before returning 200, and returns 503 when its secret is not configured. Besides `fetch`, `scheduled` and `queue`, the Worker exports `email()` for mail that Cloudflare Email Routing delivers. Request bodies are limited to 100 KB, whether or not the request carries a `Content-Length` header.

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
  - the operator chat allowlist.
- **`brain/`:** short, typed, operator-approved lists that prompts read, such as personas, ICP, message pillars, objections, voice and facts. See [BRAIN-SCHEMA.md](BRAIN-SCHEMA.md).
- **`templates/`:** operator-written email templates with frontmatter.

Secrets come from `wrangler secret put`, never from files. Behavior that could surprise someone sits behind a flag in KV that defaults to off. `gtm doctor` lists every flag and its state.

## One deployment, one company

A deployment serves exactly one company and one product. A second product means a second deployment, with its own database, brain, sending domain and budget. [DECISIONS.md](DECISIONS.md) (ADR-001) explains the trade.
