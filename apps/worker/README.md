# @gtm-agents/worker

The deployable Worker, and the template that `gtm init` copies when you start a new deployment. This page is for deployers reading what their new deployment contains, and for contributors changing the template; [docs/QUICKSTART.md](../../docs/QUICKSTART.md) takes a new copy to a running staging deployment.

## Contents

| File | Purpose |
|---|---|
| `wrangler.jsonc` | Bindings for D1, KV, R2, Vectorize, Workers AI, the two Durable Objects, three queues (events, chat and the optional jobs queue, with dead-letter queues for events and jobs), one per-minute cron trigger and static assets. Every resource id and name is a `${...}` placeholder that `gtm setup` fills in, except the Worker and bucket names, which start as the defaults `gtm-agent` and `gtm-agent-bucket` because Wrangler validates their format. Includes staging and production environments. |
| `src/index.ts` | Wires your config into the runtime: builds the adapters, registers every job (sourcing, signals, outreach, experiments, delivery, inbox, replies, follow-ups, reports, convert, lifecycle, autonomy, learning, retention), names the queues, and calls `createWorker`. Each job does nothing until its flag is on. |
| `gtm.config.ts` | Everything about the company and the deployment: company, agent name, sending addresses and postal footer, adapters, model ids per role, autonomy defaults and the operator allowlist; optionally sequences, modules and the dashboard's `admin` section. |
| `.dev.vars.example` | The core secret names, for a local `.dev.vars` (gitignored) used by `wrangler dev`. |
| `brain/` | The GTM brain: short, typed, operator-approved lists that prompts read. |
| `templates/` | Operator-written email templates with frontmatter. Cold copy is assembled from these, never generated. |

Selling a different product means changing `gtm.config.ts`, `brain/` and `templates/`. It never means changing code.

## Status

The template bundles with `npx wrangler deploy --dry-run` straight from placeholders. It registers every job and core adapter in this release (the ship module is wired separately, in [examples/ship](../../examples/ship/)), each off until its flag is turned on; [docs/DEPLOYING.md](../../docs/DEPLOYING.md) takes it from here to a running deployment.
