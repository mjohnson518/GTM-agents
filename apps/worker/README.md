# @gtm-agents/worker

The deployable Worker, and the template that `gtm init` copies when you start a new deployment.

## Contents

| File | Purpose |
|---|---|
| `wrangler.jsonc` | Bindings for D1, KV, R2, Vectorize, Workers AI, the two Durable Objects, two queues and static assets. Every resource name and id is a `${...}` placeholder that `gtm setup` fills in. Includes staging and production environments. |
| `src/index.ts` | About 30 lines: imports your config and calls `createWorker`. |
| `gtm.config.ts` | Everything about the company and the deployment: company, agent name, sending addresses and postal footer, adapters, model ids per role, autonomy defaults, sequences, modules. |
| `brain/` | The GTM brain: short, typed, operator-approved lists that prompts read. |
| `templates/` | Operator-written email templates with frontmatter. Cold copy is assembled from these, never generated. |

Selling a different product means changing `gtm.config.ts`, `brain/` and `templates/`. It never means changing code.

## Status

This app is a scaffold. The template files arrive with the runtime skeleton.
