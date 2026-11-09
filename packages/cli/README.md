# @gtm-agents/cli

The `gtm` command, for setting up and operating a deployment. This page is for deployers looking up a command's options and for contributors changing the CLI; [docs/DEPLOYING.md](../../docs/DEPLOYING.md) walks through a first deployment in order.

| Command | What it does |
|---|---|
| `gtm init <dir>` | Creates a new deployment from the worker template |
| `gtm setup` | Creates the Cloudflare resources, reusing any that exist, fills their ids into `wrangler.jsonc`, and lists the missing secrets |
| `gtm migrate` | Checks the migration order, then applies the D1 migrations |
| `gtm brain validate \| upload \| diff` | Validates the brain and templates, uploads them to KV with their locks, and shows what differs from KV |
| `gtm flags list \| get \| set \| unset` | Reads and writes feature flags in KV, checked against the flag registry |
| `gtm doctor` | Checks bindings, the cron trigger, configuration, adapters, secrets, webhooks, the kill switch and flags |
| `gtm deploy` | Runs doctor and the migrations, warns on a brain diff, then deploys |

Every command that talks to Cloudflare runs the deployment's installed Wrangler (`npx --no-install wrangler ...`) in the deployment's directory, with your Wrangler login, and takes `--config <dir>` (default: the current directory) and `--env staging|production` (default: production, the top level of `wrangler.jsonc`). Commands that write to production (`migrate`, `brain upload`, `flags set|unset`, `deploy`) ask first and take `--yes` to skip the question; without a terminal, `--yes` is required. Staging writes without asking. Wrangler itself runs without a terminal, so its own prompts auto-confirm. Exit codes: 0 success, 1 a check or a Wrangler call failed, 2 a usage error. The CLI runs on macOS and Linux; on Windows, use WSL.

## Commands

**`gtm init <dir> [--name <worker-name>] [--local <checkout>]`** copies the worker template into a new directory. It sets the Worker and bucket names, points migrations at the installed core package, and writes `package.json`, `tsconfig.json` and `.gitignore`. Until the packages are published, `--local` installs them from a checkout of this repository.

**`gtm setup [--env] [--yes] [--reuse-existing] [--base-url <https-origin>] [--vector-dimensions <n>] [--vector-metric <metric>]`**
- Reads `wrangler.jsonc` and plans a resource for every binding that still holds a `${...}` placeholder, plus the R2 bucket and any queue that does not exist yet: the D1 database, KV namespace, R2 bucket, Vectorize index and queues, named after the Worker and the binding (`my-agent-db`, `my-agent-kv`, `my-agent-memory`, `my-agent-events`, `my-agent-events-dlq`, `my-agent-chat`).
- Looks each name up first (`d1 list`, `kv namespace list`, `r2 bucket info`, `vectorize list`, `queues info`). If a lookup fails, it creates nothing. A resource `wrangler.jsonc` already names is reused; one that exists under a derived name the file does not hold yet is adopted only with `--reuse-existing`, since it may belong to another deployment with the same Worker name. An existing Vectorize index with other dimensions or metric is refused.
- Prints the plan and asks before acting; `--yes` skips the question, and without a terminal it is required.
- Creates with `--update-config=false`, so Wrangler never edits the file itself, then replaces only the placeholder strings in `wrangler.jsonc`, keeping comments and formatting. It does not write if the file changed while it ran.
- `--base-url` fills `AGENT_BASE_URL`. The Vectorize index defaults to 1536 dimensions and cosine distance, which cannot change after it is created.
- A second run plans nothing. It ends with the missing secrets as `npx wrangler secret put <NAME>` lines, from `wrangler secret list` (names only).

**`gtm migrate [--env] [--local]`** checks that the migrations directory named by the `DB` binding exists and is numbered `0001`, `0002`, ... with no gaps or duplicates, then runs `wrangler d1 migrations apply DB --remote` (or `--local`). It refuses while the database id is a placeholder.

**`gtm brain validate [dir] [--templates <dir>] [--domain <domain>] [--write-lock]`** checks every brain component and template, and writes `brain.lock.json` when everything passes.

**`gtm brain upload [dir] [--templates <dir>] [--domain <domain>] [--env] [--dry-run]`**
- Validates first, and uploads nothing on an error, when an approved component changed after it was locked, or when there is no lock.
- Computes the locks with the core functions and writes, through `wrangler kv bulk put --remote`, every approved file (`brain:file:<component>`, `template:file:<id>`) and then, in a second call, the locks (`brain:lock`, `templates:lock`). The runtime serves a file only when it matches the lock, so a partial upload is never served.
- The bulk files are written to a private temporary directory and deleted afterwards.
- `--dry-run` lists the keys and sizes without calling Wrangler.

**`gtm brain diff [dir] [--templates <dir>] [--env]`** reads `brain:lock` and `templates:lock` and lists each component and template that is new, changed or removed compared with the local files.

**`gtm flags list | get <key> | set <key> <value> | unset <key> [--env]`**
- `list` shows every flag in the registry with its default and its remote value, including each member of a family such as `autonomy:<class>`.
- `set` refuses a key that is not in the registry and a value that does not fit its kind (booleans are stored as `true` or `false`; numbers and JSON must parse). It refuses an autonomy level above 1 for a permanently human-only action class.
- Reads go through `wrangler kv bulk get`, writes through `wrangler kv bulk put`, and `unset` through `wrangler kv key delete`, all with `--remote`.

**`gtm doctor [--config <dir>] [--env] [--remote]`** reports PASS, WARN, FAIL or INFO for each check and exits non-zero on any FAIL. Offline it reads `wrangler.jsonc` (including that the only cron trigger is `* * * * *`), `gtm.config.ts`, adapter manifests and the names in `.dev.vars`. `--remote` also reads the deployed secret names and the halt and kill-switch flags.

**`gtm deploy [--env] [--dry-run]`** runs `gtm doctor` (any FAIL stops it), checks that no placeholder is left, runs `gtm migrate`, warns when `gtm brain diff` finds differences, then runs `wrangler deploy`. `--dry-run` lists the pending migrations and runs `wrangler deploy --dry-run` instead, changing nothing.

## For contributors

- Node 24 runs the CLI's TypeScript directly; there is no build step.
- Every Wrangler call goes through the injectable `CommandRunner` (`src/lib/io.ts`). Tests replace it with an in-memory account (`test/fake-wrangler.ts`), so no test touches Cloudflare.
- `src/lib/jsonc-edit.ts` edits `wrangler.jsonc` by replacing string values at their exact source positions. Never re-serialize a deployer's config.
- No command reads or prints a secret value. Secrets are listed by name and set with `wrangler secret put`, which prompts for the value.
