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

Available today:

- **`gtm init <dir> [--name <worker-name>] [--local <checkout>]`** copies the worker template into a new directory. It sets the Worker and bucket names, points migrations at the installed core package, and writes `package.json`, `tsconfig.json` and `.gitignore`. Until the packages are published, `--local` installs them from a checkout of this repository.
- **`gtm doctor [--config <dir>] [--env <name>] [--remote]`** reports PASS, WARN, FAIL or INFO for each check and exits non-zero on any FAIL. Offline it reads `wrangler.jsonc`, `gtm.config.ts`, adapter manifests and `.dev.vars`. `--remote` also reads the deployed secrets and the halt flag and kill switch through Wrangler.
- **`gtm brain validate [dir] [--templates <dir>] [--domain <domain>] [--write-lock]`** checks every brain component and template, and writes `brain.lock.json` when everything passes.

`setup`, `migrate`, `brain upload`, `brain diff`, `flags` and `deploy` print a short message and exit with code 2; see [docs/ROADMAP.md](../../docs/ROADMAP.md).

Node 24 runs the CLI's TypeScript directly; there is no build step.
