# @gtm-agents/core

This page is for deployers wiring `src/index.ts` and contributors changing the runtime: it says what the package owns, the rules for code in it, and where each part is exported. `@gtm-agents/core` is the runtime of a GTM-agents deployment. Every decision the system makes is made here. Every call to a third party goes through an adapter in `@gtm-agents/adapters`, behind a port that this package defines.

## What it owns

- `createWorker(config, options)`: the Worker's `fetch`, `scheduled` and `queue` handlers, and `email()` when Email Routing is wired, built from your `gtm.config.ts` and the adapters and jobs `src/index.ts` passes in.
- The job registry. Scheduled work is declared as data (name, schedule, flag, ceilings, run), and the cron handler loops over it.
- The safety spine:
  - the taint model and action gate;
  - sanitize and fence for untrusted text;
  - approval digests;
  - the effects ledger (exactly-once side effects);
  - rate limits, budgets and the cost ledger;
  - the halt flag and the cold outreach kill switch;
  - the suppression list.
- The pipeline stages: sourcing, enrichment, scoring, signals, outreach and the quality gate, sending, sequences, the inbox, replies, convert and lifecycle.
- Experiments, earned autonomy, self-improvement, the scorecard, and the single definition of every metric.
- The operator chat (the hub agent and its tools) and the server side of the operator dashboard.
- The brain loader and the template engine.
- The data layer and the D1 migrations.
- The port interfaces that every adapter implements.

## Rules for code in this package

- No vendor SDK imports. Lint enforces this.
- Gates fail closed: a send gate, approval check, kill switch or budget read that errors blocks the action. Bookkeeping fails open: an audit row, memory write or cost record that errors is logged and dropped.
- No company-specific literals. Names, addresses, prices and product facts come from `gtm.config.ts`, the brain or the database.

## Subpath exports

| Import | What it holds | Guide |
|---|---|---|
| `@gtm-agents/core` | `createWorker`, `kvFlagReader`, `defineConfig` and the `Env` type | [ARCHITECTURE.md](../../docs/ARCHITECTURE.md) |
| `/config` | The configuration schema, `defineConfig`, the required bindings and core secrets. Safe to import from Node | [DEPLOYING.md](../../docs/DEPLOYING.md#6-configuration-reference) |
| `/jobs`, `/flags` | The job registry, the cron parser and the scheduled loop; the flag registry | [ARCHITECTURE.md](../../docs/ARCHITECTURE.md#scheduling-the-job-registry) |
| `/ports`, `/adapters` | The port interfaces and the adapter manifest schema; `createAdapterContext` | [INTERFACES.md](../../docs/INTERFACES.md) |
| `/brain`, `/templates`, `/brain/schema/*` | Brain parsing, validation, the lock file, slice assembly and the runtime loader; template validation and rendering; the published JSON Schemas | [BRAIN-SCHEMA.md](../../docs/BRAIN-SCHEMA.md) |
| `/security`, `/runtime`, `/events`, `/budget`, `/http` | The taint model, action gate, tool registry, fence, URL and egress checks, delegation taint, approval digests, halt and rate limits; the tool dispatcher, job runner, cron health check and run-row retention (`createRetentionJob`); the effects ledger, event spine and audit writer; the cost ledger and budget gate; bearer auth | [SECURITY-MODEL.md](../../docs/SECURITY-MODEL.md) |
| `/testing` | `runSecurityContract`, which every adapter and module runs over its own tools | [SECURITY-MODEL.md](../../docs/SECURITY-MODEL.md#the-security-contract) |
| `/data`, `/migrations/*` | The enums, account keys, forward-only warmth, deal transitions and erasure; the migration files | [DATA-MODEL.md](../../docs/DATA-MODEL.md) |
| `/agents`, `/tools`, `/operator` | The hub agent's tool loop and chat sessions; `web_fetch`, `contacts_search` and `drafts_create`; the operator webhook, chat consumer, commands and approvals | [OPERATOR.md](../../docs/OPERATOR.md) |
| `/sourcing`, `/enrichment`, `/scoring` | The discovery cycle (`createSourcingJobs`); the email waterfall, verification and evidence; the title classifier, prescore, fit score and intent score | [SOURCING.md](../../docs/SOURCING.md) |
| `/signals` | Signal sources, carry, angles and their jobs (`createSignalJobs`) | [SIGNALS.md](../../docs/SIGNALS.md) |
| `/quality`, `/outreach` | The content lint, quality gate and model reviewer; allocation, composing, the daily cold batch, readiness, manifests and release (`createOutreachJobs`) | [OUTREACH.md](../../docs/OUTREACH.md) |
| `/sending` | The send function (`createOutreachSender`), the kill switch, suppression, unsubscribe, delivery webhooks, send windows, the deferred queue, caps, the circuit breaker, the warm-up ramp, the bounce monitor and liveness (`createDeliveryJobs`) | [SENDING.md](../../docs/SENDING.md) |
| `/sequences` | The follow-up sweep, threading, release and resume (`createSequenceJobs`) | [SEQUENCES.md](../../docs/SEQUENCES.md) |
| `/inbox` | Intake, structural classification, the poll, sweep and watch jobs (`createInboxJobs`), the push route and the `email()` entry point | [INBOX.md](../../docs/INBOX.md) |
| `/replies` | Triage, routing, the meeting qualifier, drafting, approved sends through the warm mailbox, reminders and mirroring (`createReplyJobs`) | [REPLIES.md](../../docs/REPLIES.md) |
| `/metrics`, `/reports` | The one definition of every metric; the scorecard, digests and conversion report (`createReportJobs`) | [MEASUREMENT.md](../../docs/MEASUREMENT.md) |
| `/experiments` | Allocation, assignment, experiments, subject and send-time tests, the copy-change gate and the self-review (`createExperimentJobs`) | [EXPERIMENTS.md](../../docs/EXPERIMENTS.md) |
| `/convert` | Calendar sync, attribution, booking effects, prep and handoff briefs, meeting follow-ups (`createConvertJobs`) | [CONVERT.md](../../docs/CONVERT.md) |
| `/lifecycle`, `/product-bridge`, `/billing` | The lifecycle state machine, deal mirror, checks, MRR and follow-ups (`createLifecycle`, `createLifecycleFollowups`); the product bridge (webhook, identity, feedback, the nightly pull); the billing webhook through the BillingProvider port | [LIFECYCLE.md](../../docs/LIFECYCLE.md) |
| `/autonomy`, `/autonomy/runtime` | Levels, action classes, the auto-send rules and the outbound writer registry, with no Worker bindings; the level store, evidence, promotion, demotion and their jobs (`createAutonomyJobs`) | [AUTONOMY.md](../../docs/AUTONOMY.md) |
| `/learning` | Every self-improvement loop, its proposals and commands (`createLearningJobs`, `learningDashboard`) | [LEARNING.md](../../docs/LEARNING.md) |
| `/gateway`, `/gateway/protocol`, `/durable-objects` | The dashboard's `/ws` route and Access check, its request dispatcher and the protocol shared with `apps/admin`; the `OperatorGateway` and `FollowupAgent` classes a Worker must export | [DASHBOARD.md](../../docs/DASHBOARD.md) |

Modules with test doubles export them from a `/testing` subpath of their own (`/sending/testing`, `/outreach/testing`, `/sequences/testing`, `/inbox/testing`, `/replies/testing`, `/convert/testing`, `/billing/testing`, `/agents/testing`), for contract and integration tests that must not touch a provider.
