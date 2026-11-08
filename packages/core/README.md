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
- the baseline migration.

The safety spine and the pipeline stages are not in this package yet; [docs/ROADMAP.md](../../docs/ROADMAP.md) lists what is planned.
