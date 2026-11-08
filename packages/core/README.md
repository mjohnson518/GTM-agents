# @gtm-agents/core

The runtime of a GTM-agents deployment. Every decision the system makes is made here. Every call to a third party goes through an adapter in `@gtm-agents/adapters`, behind a port that this package defines.

## What it owns

- `createWorker(config)`: the Worker's `fetch`, `scheduled` and `queue` handlers, built from your `gtm.config.ts`.
- The job registry. Scheduled work is declared as data (name, schedule, flag, ceilings, run), and the cron handler loops over it.
- The safety spine:
  - the taint model and action gate;
  - sanitize and fence for untrusted text;
  - approval digests;
  - the effects ledger (exactly-once side effects);
  - rate limits, budgets and the cost ledger;
  - the halt flag and the outreach kill switch;
  - the suppression list.
- The pipeline stages: sourcing, enrichment, scoring, outreach and the quality gate, sending, sequences, replies, convert and lifecycle.
- Experiments, the scorecard, and the single definition of every metric.
- The brain loader and the template engine.
- The data layer and the D1 migrations.
- The port interfaces that every adapter implements.

## Rules for code in this package

- No vendor SDK imports. Lint enforces this.
- Gates fail closed: a send gate, approval check, kill switch or budget read that errors blocks the action. Bookkeeping fails open: an audit row, memory write or cost record that errors is logged and dropped.
- No company-specific literals. Names, addresses, prices and product facts come from `gtm.config.ts`, the brain or the database.

## Status

The runtime skeleton exists:
- `createWorker`, with the HTTP surface and the scheduled and queue handlers;
- the configuration schema, the job registry and its cron parser;
- the port interfaces and the adapter manifest schema;
- the flag registry and autonomy levels;
- the brain (parse, validate, lock, slice assembly, runtime loader) and templates (validate, render);
- the baseline migration;
- the safety spine, with migrations 0002 to 0005:
  - `@gtm-agents/core/security`: the taint model and action gate, the tool registry, sanitize and fence, URL and egress checks, delegation taint, approval digests, the system halt and rate limits;
  - `@gtm-agents/core/runtime`: the tool dispatcher with its rate-limit and budget checks, the fault-tolerant job runner and the cron health check;
  - `@gtm-agents/core/events`: the effects ledger;
  - `@gtm-agents/core/budget`: the cost ledger and the budget gate;
  - `@gtm-agents/core/sending`: the cold outreach kill switch, the suppression list and the send gates;
- the security contract for adapters and modules (`@gtm-agents/core/testing`);
- the data model: migrations 0006 to 0013 (CRM, pipeline, outreach, experiments, discovery, events, agent operations, ship loop), and `@gtm-agents/core/data` with the enums, account keys, forward-only warmth, deal transitions and erasure ([docs/DATA-MODEL.md](../../docs/DATA-MODEL.md));
- the first agent: `@gtm-agents/core/agents` (the hub agent's tool loop and sessions), `/tools` (`web_fetch`, `contacts_search`, `drafts_create`), `/operator` (the webhook, the chat consumer, commands and approvals), `/http` (bearer auth), and migration 0014 for chat sessions ([docs/OPERATOR.md](../../docs/OPERATOR.md));
- sourcing and enrichment: `@gtm-agents/core/sourcing` (the discovery cycle and `createSourcingJobs`), `/enrichment` (the email waterfall, verification and evidence) and `/scoring` (the title classifier, prescore and fit) ([docs/SOURCING.md](../../docs/SOURCING.md));
- outreach: `@gtm-agents/core/quality` (the content lint and the quality gate), `/outreach` (allocation, composing, the daily cold batch, readiness, manifests and release, `createOutreachJobs`), and migration 0016 for approval manifests ([docs/OUTREACH.md](../../docs/OUTREACH.md));
- delivery, in `@gtm-agents/core/sending`: the provider boundary (`createOutreachSender`), unsubscribe, delivery webhooks, send windows and the deferred queue, caps, the circuit breaker, the ramp, the bounce monitor and liveness (`createDeliveryJobs`), and migration 0015 ([docs/SENDING.md](../../docs/SENDING.md));
- `@gtm-agents/core/adapters`: `createAdapterContext`, which builds the context an adapter runs with.

The pipeline stages are not in this package yet; [docs/ROADMAP.md](../../docs/ROADMAP.md) lists what is planned, and [docs/SECURITY-MODEL.md](../../docs/SECURITY-MODEL.md) describes the security model.
