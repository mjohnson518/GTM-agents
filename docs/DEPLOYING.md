# Deploying

This page is for deployers taking a GTM-agents deployment from `gtm init` to a running Worker on Cloudflare: what you need first, the commands in order, staging before production, turning capabilities on one flag at a time, rolling back, and what the per-minute trigger runs and costs. Contributors changing the commands themselves should read [packages/cli/README.md](../packages/cli/README.md).

Nothing acts on the world when you first deploy. Every capability (the chat agent, discovery, the cold batch, real sends, the inbox, replies and follow-ups) is behind a flag that defaults to off, and you turn each one on yourself.

## Prerequisites

- **The Workers Paid plan.** The Free plan cannot run this system: its limits of 10 ms of CPU per invocation, 50 subrequests per invocation and 1,000 KV writes a day are far below what the scheduled jobs and the send path need. Upgrade the account before you run `gtm setup`.
- **A domain.** Cold mail goes out from an isolated sending subdomain with its own DNS records ([SENDING.md](SENDING.md)), and the Worker needs a stable public https origin (a custom domain, or its `<worker>.<subdomain>.workers.dev` URL) for unsubscribe links and webhooks.
- **Accounts for the adapters you enable,** and their API keys: the operator channel ([OPERATOR.md](OPERATOR.md)), search and enrichment ([SOURCING.md](SOURCING.md)), the email provider ([SENDING.md](SENDING.md)) and the mailbox ([INBOX.md](INBOX.md)). You can deploy with none of them and add each one later.
- **Node 24 or later on macOS or Linux (on Windows, use WSL), and Wrangler logged in** to the account you deploy to: `npx wrangler login`, then `npx wrangler whoami` to check which account it uses. Every `gtm` command that talks to Cloudflare runs the deployment's own Wrangler with that login, without prompting. If your login can reach several accounts, set `account_id` in `wrangler.jsonc` or export `CLOUDFLARE_ACCOUNT_ID` first, so every command acts on the right one.

## The path

```bash
npx gtm init ../my-agent --local .        # from a checkout of this repository
cd ../my-agent && npm install
npx wrangler login

npx gtm setup --env staging --base-url https://agent-staging.acme.example
npx wrangler secret put GATEWAY_TOKEN --env staging   # and every other line setup prints
npx gtm migrate --env staging
npx gtm brain validate --write-lock
npx gtm brain upload --env staging
npx gtm deploy --env staging

npx gtm doctor --remote --env staging
curl https://agent-staging.acme.example/health
```

Then the same again without `--env staging` for production. Each step is below.

**Production asks first.** `gtm migrate`, `gtm brain upload`, `gtm flags set|unset` and `gtm deploy` ask for confirmation before they write to production, and need `--yes` when there is no terminal (in CI, for example). Wrangler runs without a terminal underneath, so its own "Ok to proceed?" prompts answer themselves; the `gtm` question is the real one. Staging writes without asking, so you can iterate on it quickly.

### 1. Create the deployment

`gtm init <dir>` copies the worker template: `wrangler.jsonc` with `${...}` placeholders for every resource, `src/index.ts`, `gtm.config.ts`, and empty `brain/` and `templates/` folders. Fill in `gtm.config.ts` (your company, sending addresses, postal address, adapters and model ids). Everything specific to what you sell lives there, in `brain/` and in `templates/`; nothing else needs editing.

### 2. Create the Cloudflare resources

`gtm setup` creates what the environment's block in `wrangler.jsonc` still lacks, and writes the ids and names back into the file:

| Resource | Name it gets |
|---|---|
| D1 database (`DB`) | `<worker>-db` |
| KV namespace (`KV`) | `<worker>-kv` |
| R2 bucket (`BUCKET`) | the `bucket_name` already in the file (`<worker>-bucket` after `gtm init`) |
| Vectorize index (`MEMORY`) | `<worker>-memory` |
| Queues | `<worker>-events`, `<worker>-events-dlq` (its dead-letter queue) and `<worker>-chat` |

`<worker>` is the environment's Worker name, so staging (`my-agent-staging`) gets its own set.

- **It looks before it creates.** It asks Cloudflare, read-only, whether each name already exists. If Cloudflare cannot be asked, it stops before creating anything.
- **It never adopts a resource silently.** If a resource with a derived name already exists but `wrangler.jsonc` does not name it yet, it may belong to another deployment with the same Worker name, so setup stops and says so. Rerun with `--reuse-existing` only if it is yours. Every existing resource is listed in the plan.
- **It asks first.** It prints the plan and waits for a yes. Pass `--yes` in scripts; without a terminal and without `--yes`, it changes nothing.
- **It edits only the placeholders.** Comments and formatting in `wrangler.jsonc` stay as they are. If the file changes while setup runs, it does not write, and prints the values to enter by hand.
- **It is safe to run again.** A second run finds everything and plans nothing. If a create fails halfway, fix the cause and rerun: it reuses what it already made.
- **The Vectorize index's dimensions cannot change later.** The default is 1536 with cosine distance; pass `--vector-dimensions` and `--vector-metric` to match your embedding model before the first run. Setup refuses to adopt an existing index with different settings.
- **`--base-url`** fills `AGENT_BASE_URL`, the Worker's public https origin. Without it, setup lists `vars.AGENT_BASE_URL` as still to fill in, and `gtm deploy` waits for it.

Setup ends with the secrets that are still missing and the chat queue's name (`<worker>-chat`). List each environment's chat queue name in `agent.chatQueue` in `src/index.ts`, so chat turns reach the operator agent directly. Without `agent.chatQueue` the Worker expects a queue named `gtm-chat`; chat messages that arrive on another queue are still handled, with a warning in the logs.

### 3. Set the secrets

Setup prints one `npx wrangler secret put <NAME>` line per missing secret: the core ones (`GATEWAY_TOKEN`, `UNSUBSCRIBE_SIGNING_KEY`) and each enabled adapter's. Run each; Wrangler prompts for the value, so it never lands in your shell history or in a file. No `gtm` command reads or prints a secret value. For `wrangler dev`, put local values in `.dev.vars`, which is gitignored.

### 4. Apply the migrations

`gtm migrate` checks that the migrations are numbered in order with no gaps, then runs `wrangler d1 migrations apply DB --remote`. Migrations are idempotent and D1 records which ones ran, so running it again is harmless. `--local` applies them to the database `wrangler dev` uses. [DATA-MODEL.md](DATA-MODEL.md) describes the tables.

**Always migrate before new code runs.** New code can rely on new columns: deploying with a bare `wrangler deploy` before `gtm migrate` breaks reply and follow-up drafting until the migration that adds their columns has run. `gtm deploy` migrates first for you.

### 5. Upload the brain and templates

Write `brain/` and `templates/` ([BRAIN-SCHEMA.md](BRAIN-SCHEMA.md)), review them, and lock what you approved with `gtm brain validate --write-lock`. Then `gtm brain upload`:

- validates everything first, and uploads nothing if there is an error, or if an approved file changed after it was locked;
- writes each approved file to KV (`brain:file:<component>`, `template:file:<id>`), then, in a separate call, the locks (`brain:lock`, `templates:lock`). The runtime serves a file only when its bytes match the lock, so an upload that stops halfway is never served half-written; rerun it;
- takes up to a minute to reach every Cloudflare location. Until then a location serves the previous version or holds a changed file back, never a mix.

`gtm brain upload --dry-run` lists the keys without writing. `gtm brain diff` shows which components and templates differ from what is uploaded.

### 6. Deploy

`gtm deploy` runs, in order:

1. `gtm doctor`; any FAIL stops the deploy;
2. a check that no `${...}` placeholder is left;
3. `gtm migrate`; a failure stops the deploy;
4. `gtm brain diff`; differences are a warning, not a stop;
5. `wrangler deploy`.

Use it instead of a bare `wrangler deploy`, which skips the migrations.

`gtm deploy --dry-run` runs the checks, lists the pending migrations and bundles the Worker without changing anything.

### 7. Verify

- `gtm doctor --remote` reads the deployed secrets and the halt and kill-switch flags. (Every run of `gtm doctor` also checks that the selected environment's block in `wrangler.jsonc` has exactly one cron trigger; run it with `--env staging` too.)
- `GET /health` answers with `"ok": true`.
- Register the operator channel's webhook now that the Worker has a URL ([OPERATOR.md](OPERATOR.md)).
- In the Cloudflare dashboard, the Worker's **Cron Events** show an invocation every minute. Each job that was due leaves a row in `execution_runs`, `skipped` with the reason `flag off` until you turn it on.

## Staging first

The template has a `staging` environment with its own Worker (`<name>-staging`), its own D1 database, KV namespace, bucket, index and queues, and so its own flags, brain and data. Every command above takes `--env staging`; without it, they act on production (the top level of `wrangler.jsonc`).

Set staging up completely, turn its capabilities on, and watch it for a few days before you repeat the path for production. Staging should point at test inboxes and a test operator chat, never at real prospects.

## Turning things on

Turn on one capability at a time, watch it for a day, then the next. `gtm flags list` shows every flag with its default and its deployed value.

```bash
npx gtm flags list --env staging
npx gtm flags set operator:agent_enabled true --env staging
npx gtm flags get cold_batch:enabled --env staging
```

`gtm flags` refuses a key that is not in the flag registry and a value that does not fit the flag's kind, and it never sets the autonomy of a permanently human-only action class above 1.

A sensible order, each with its own page:

| Capability | Flag | Read first |
|---|---|---|
| The operator chat agent | `operator:agent_enabled` | [OPERATOR.md](OPERATOR.md) |
| Mailbox intake | `inbox:enabled` | [INBOX.md](INBOX.md) |
| Discovery and enrichment | `discovery:enabled` | [SOURCING.md](SOURCING.md) |
| The daily cold batch, released by you | `cold_batch:enabled` | [OUTREACH.md](OUTREACH.md) |
| Real sends through the email provider | `delivery:enabled` | [SENDING.md](SENDING.md) |
| Reply triage, drafting and sending | `replies:triage_enabled`, `replies:drafting_enabled`, `replies:send_enabled` | [REPLIES.md](REPLIES.md) |
| Follow-up steps | `sequences:enabled` | [SEQUENCES.md](SEQUENCES.md) |

Leave `cold_batch:auto_approve` off: until then, nothing goes out without your release code.

## Rolling back

- **One capability:** `gtm flags unset <flag>` returns it to its default, which is off.
- **Everything:** `gtm flags set system:halt '{"reason":"investigating","by":"operator"}'` stops every scheduled job and every send, replies included. `gtm flags unset system:halt` resumes. A halt flag that cannot be read also counts as halted.
- **Cold outreach only:** set `outreach:cold-pause:critical` the same way ([SENDING.md](SENDING.md)).
- **The code:** `npx wrangler rollback` (with `--env staging` for staging) returns to the previous Worker version. Migrations are not rolled back; they only add tables and columns.

Flags live in KV, so a change can take up to a minute to reach every location.

## What runs every minute, and what it costs

The Worker has exactly one cron trigger, `* * * * *`. Every minute the scheduled handler works out which registered jobs have a schedule matching that minute (in UTC, with named days such as `MON-FRI`) and runs them concurrently through the fault-tolerant runner, four at a time and longest ceiling first, each under its own duration ceiling; one job's failure never affects another. The bound keeps a busy minute within the connections one invocation may open. A job is skipped, with a run row saying why, while its previous run is still going. Each job sees the real time it starts as its clock. A minute with nothing due returns without reading or writing anything. Adding a job never means adding a trigger. Keep the trigger the only one: an extra trigger would run the jobs due in its minutes a second time, and `gtm doctor` fails on it. [ARCHITECTURE.md](ARCHITECTURE.md) describes the job registry.

With the template's jobs, these are due most often:

| Job | Schedule | Flag |
|---|---|---|
| `inbox_poll` | every minute | `inbox:enabled` |
| `replies_send`, `replies_reminders` | every 5 minutes | `replies:send_enabled`, `replies:reminders_enabled` |
| `inbox_sweep`, `replies_triage`, `replies_mirror`, `account_fit_scoring` | every 15 minutes | `inbox:enabled`, `replies:triage_enabled`, `replies:mirror_enabled`, `fit:scoring_enabled` |

The rest run a few times a day or less.

All the jobs due in one minute share that minute's invocation, and Cloudflare limits a cron invocation to 15 minutes of wall time and, for a trigger that fires more often than hourly, 30 seconds of CPU time. Jobs mostly wait on the network, which does not count as CPU time. A job is started only if its ceiling ends within the invocation's 14-minute budget; one that could not start leaves a failed run row saying "was not started", the operator channel is paged (at most once a day per job), and if it is critical the cron health check reruns it when it is safe to. Spread long jobs' schedules apart if you see that. Every due job reads the halt flag and its own flag from KV and leaves a run row, so even with everything off a deployment makes about:

- 1,440 Worker invocations a day (about 43,200 a month, under half a percent of the 10 million requests the Paid plan includes);
- 2,400 job runs a day, each a few KV reads and one row in `execution_runs`; `inbox_poll` alone writes about 1,440 rows a day, so plan retention for run rows (`ops:retention_enabled`).

No model is ever called from a job that runs every minute; per-minute work is deterministic and cheap. What costs money is the work you turn on: model calls, searches, enrichment lookups and sends. Each is recorded in the cost ledger and capped by the budget flags (`budget:daily_limit_cents`, `budget:monthly_limit_cents`, and a per-job cap). The [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [KV](https://developers.cloudflare.com/kv/platform/pricing/) and [D1](https://developers.cloudflare.com/d1/platform/pricing/) pricing pages have the current included amounts.
