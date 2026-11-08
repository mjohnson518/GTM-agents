# @gtm-agents/cli

The `gtm` command, for setting up and operating a deployment.

| Command | What it does |
|---|---|
| `gtm init <dir>` | Creates a new deployment from the worker template: `wrangler.jsonc` with placeholders, `src/index.ts`, `gtm.config.ts`, `brain/` and `templates/` |
| `gtm setup` | Creates the Cloudflare resources through Wrangler, fills in the placeholders, and generates cron triggers from the job registry |
| `gtm doctor` | Checks bindings, required secrets, adapter manifests, webhook registration, the email footer and unsubscribe secret, the kill switch, and every flag with its state |
| `gtm migrate [--dry-run]` | Applies D1 migrations after checking their order and idempotency |
| `gtm brain validate \| upload \| diff` | Validates the brain against its schema and byte budgets, uploads it with a lock file, and shows what changed |
| `gtm flags list \| get \| set` | Reads and writes feature flags. Every flag defaults to off |
| `gtm deploy` | Runs the checks, then deploys the Worker |

## Status

This package is a scaffold. `init`, `doctor` and `brain validate` come first.
