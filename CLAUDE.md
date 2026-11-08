# GTM-agents: engineering contract

GTM-agents is an open-source, multi-agent go-to-market system that runs as a single Cloudflare Worker. One deployment sells one product. It:
- sources accounts and people, then enriches and verifies them;
- composes and sends outreach, and runs experiments;
- follows up, handles replies, books meetings and reports.

It runs under an earned-autonomy model: a person approves every send until the system proves it can be trusted with a class of action. This file is the engineering contract every change in this repository follows, whether a person or a coding agent writes it. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes what the system does; this file says how we work on it.

## Commands

```bash
npm install                      # Node 24+; also points git at .githooks/ (the "prepare" script)
npm run typecheck                # tsc for the root and every workspace
npm run lint                     # eslint, house rules, doc links, conflict copies
npm test                         # hermetic Vitest suites (the Workers pool for packages/core)
npm run eval                     # behavior evals (gate, triage, templates); no network
npm run check:placeholders       # template hygiene: UUIDs, workers.dev hosts, resource ids, secret-shaped values
npm run check:secrets            # known credential formats
npm run check:migrations         # migration order and idempotency
npm run check:licenses           # production dependencies of every workspace are permissively licensed
npm run check:brain              # the example brain and templates validate against the schema and lock
npm run check                    # all of the above, in that order; must be green before staging
```

The worker template and the CLI:

```bash
npx wrangler deploy --dry-run    # in apps/worker; placeholders must still produce a valid bundle
npx gtm doctor --config apps/worker   # bindings, config, adapters, secrets, webhooks, kill switch, flags
npx gtm brain validate <dir>     # brain and templates against the schema, byte budgets and lock
```

`gtm setup`, `gtm migrate`, `gtm flags`, `gtm deploy` and `gtm brain upload|diff` are not available yet; [docs/ROADMAP.md](docs/ROADMAP.md) tracks them.

## Repository layout

```
packages/core        runtime: createWorker(config), stages, lifecycle, security spine, experiments,
                     scorecard, job registry, brain loader, data layer, migrations, port interfaces
packages/adapters    one folder per adapter, subpath exports, manifest.json + contract test each
packages/sdk         what a host application installs (event emitter, signature helpers, typed events);
                     no Cloudflare dependency
packages/cli         the `gtm` command: init, setup, doctor, migrate, brain, flags, deploy
packages/modules     optional features: ship, link-intake, classifier-tier, code-mode
apps/worker          the deployable and the template `gtm init` copies (wrangler.jsonc with placeholders,
                     src/index.ts, gtm.config.ts, brain/, templates/)
apps/admin           Lit + Vite operator dashboard, served at /admin through the ASSETS binding
examples/            brains/acme (fictional company), host-nextjs, packs/, overlay/
docs/                ARCHITECTURE, INTERFACES, SECURITY-MODEL, EVENT-CONTRACT, BRAIN-SCHEMA, DECISIONS, ROADMAP
tests/               cross-package suites: security contract, evals, contract vectors (all synthetic)
scripts/             placeholder check, secrets scan, migration order, house rules, doc links, hooks
```

Core never imports a vendor SDK. Everything that talks to a third party is an adapter behind a port in [docs/INTERFACES.md](docs/INTERFACES.md). Everything company-specific lives in `brain/`, `templates/` and `gtm.config.ts`. Selling a different product must never require a code change.

## Non-negotiables

A pull request that weakens any of these is rejected, whatever else it does.

1. **Untrusted text is never an instruction.** Tool output, web pages, inbound email, product feedback and webhook payloads are data. They are sanitized, fenced and tainted, and never pasted into a system prompt.
2. **Skip rather than guess.** A missing variable, an unverified address or an unknown identity skips the contact. It never produces a placeholder, a guessed email or an invented fact.
3. **Gates fail closed; bookkeeping fails open.** A send gate, approval check, kill switch or budget read that errors blocks the action. A memory write, audit row or cost record that errors is logged and dropped, and never allowed to fail the user-facing path.
4. **Approvals bind to content.** An approval covers the exact digest approved. Editing an approved draft returns it to review.
5. **Autonomy is earned per action class and can only be loosened by a person.** The permanently human-only classes are a constant the agent cannot edit at runtime: merging code, pricing, billing and auth changes, offers and discounts, proof-of-value sends, and data deletion.
6. **One definition of every metric.** "Positive reply", "meeting booked" and "conversation started" each have exactly one implementation, in `packages/core/src/metrics/`, used by every report, experiment and promotion check.
7. **Measure lift, not activity.** An experiment concludes on a pre-registered metric with a holdout. A copy change ships only through the copy-change gate.
8. **Flags default off.** Every new capability ships behind a flag that stays off until the operator turns it on, and `gtm doctor` lists every flag and its state.
9. **Bounded and reversible.** Every job has a per-run ceiling (rows, spend, time) and leaves a run row. Anything that writes outside the database is either idempotent or claimed in the effects ledger first.
10. **The database is the truth.** Blob storage, KV and the vector index are caches or archives that can be rebuilt from it.
11. **Email is plain text,** with a postal footer, `List-Unsubscribe` headers and threading headers. No tracking pixels, no click tracking.
12. **No em dashes or en dashes anywhere:** not in code comments, docs, generated copy or templates. Use commas, periods, colons or parentheses. `scripts/check-house-rules.mjs` enforces this.

## Hygiene

- **Fixtures are synthetic.** The fictional company is Acme (`examples/brains/acme`), and every person, account, address and reply in a test is invented, on `*.example` domains. No fixture ever holds a real person's data, and no real contact list is ever added to the repository.
- **The template stays deployable from placeholders.** `apps/worker/wrangler.jsonc` carries `${...}` placeholders for every resource id and name, except the Worker and bucket names, whose format Wrangler validates; those start as generic defaults. `scripts/check-placeholders.mjs` (pre-commit and CI) fails on UUID-shaped strings outside synthetic fixtures, real `*.workers.dev` hostnames, concrete resource ids in Wrangler config, and secret-shaped values. A fixture that needs UUIDs declares itself synthetic on its first line with `gtm:synthetic-fixture`.
- **Secrets come from `wrangler secret put`** (or `.dev.vars`, which is gitignored, for local development), never from code, config files or tests. `scripts/secrets-scan.sh` runs in the pre-commit hook and in CI.
- **Agents working in this repository stage their changes and hand the commit to a person.** They do not commit, push, rewrite history or touch remotes ([ADR-008](docs/DECISIONS.md#adr-008-agents-stage-humans-commit)). The hooks in `.githooks/` are the gate, and nobody bypasses them. Commit subjects are short, imperative and capitalized, with no trailing period.
- **Every source file starts with a header comment** naming this project and what the file owns, for example `// GTM-agents: the action gate`.

## Security rules

- Never disable or bypass the taint model (`packages/core/src/security/action-gate.ts`).
  - Levels are `none < metadata < structured < full`. Merge them with `maxTaintLevel`, never with hand-written comparisons.
  - A gate may never get looser as taint rises. The security contract in `tests/security/` proves it for every tool.
- Every tool is classified.
  - A new tool declares the taint its output carries and the taint level from which it is refused. An unclassified tool runs as fully tainted and is refused once anything untrusted has been read.
  - Raw web content, inbound email bodies and product feedback are always full taint.
  - Taint propagates across delegation, and a worker can only raise its parent's taint on return.
- Never skip sanitizing a tool result, and never concatenate untrusted text into a system prompt. It goes into the fenced user turn.
- Every send path checks these inside the send function itself: suppression, the halt flag, the kill switch, the content lint, the send window, and the per-domain and per-account caps. No caller may skip them. A send that relies on an approval verifies the digest first.
- The permanently human-only actions live in one constant (`PERMANENT_HUMAN`). Nothing reads a flag to loosen them.
- Every bridge and webhook route verifies its signature before touching the database. It never takes an account, contact or draft id from a request body without re-resolving it.

## Review rules

- A diff touching any of these is reviewed, before it is staged, by a reviewer who did not write it (a second person, a subagent or a fresh session):
  - `packages/core/src/security/` or `packages/core/src/autonomy/`;
  - the delegation layer or the tool registry;
  - migrations;
  - a spend path.
- Judge blast radius by grepping callers, not by counting changed lines.
- When you find a pattern, fix every instance of it, not just the one that was reported.
- A behavior change ships with the test that would have caught its absence. Each milestone's gate in [docs/ROADMAP.md](docs/ROADMAP.md) is written as a test first.
- Every tracked file is written for the people who use or extend the system: deployers, contributors and their agents. It explains the system, not the history of how a change was made.

## Conventions

**Code and naming**
- TypeScript runs from source with no build step ([ADR-009](docs/DECISIONS.md#adr-009-source-first-typescript-on-node-24)):
  - use erasable syntax only (no enums, namespaces or constructor parameter properties);
  - name the `.ts` file in relative imports;
  - use `import type` for types.
- Database and backend names are `snake_case` (`first_name`, `account_key`, `last_contacted_at`). UI names are `camelCase`, and the mapping lives in one place in `apps/admin`.

**Data model**
- The account key is the lowercased registrable domain.
- Contact warmth runs `cold -> contacted -> warming -> engaged -> hot -> customer`, with `churned` and `opted_out` as terminal side states. Warmth only moves forward, using compare-and-set writes.
- The other status enums:
  - Candidates: `raw -> enriched -> qualified | borderline | rejected -> promoted | duplicate`.
  - Drafts: `draft -> pending_approval -> approved -> sent | rejected`.
  - Deals: `prospecting -> contacted -> engaged -> demo_scheduled -> trial -> proposal -> negotiation -> closed_won | closed_lost`.

  Do not invent parallel ones.
- Domain-specific contact and account fields go in the `attributes` JSON column, never in new columns. A new column is only for data every deployment has.
- Addresses, names, prices and product facts come from `gtm.config.ts`, the brain or the database. A literal company name, email address, URL or price in code is a bug.

**Failure handling**
- Memory storage, audit logging and cost tracking are fire-and-forget.
- The rate limiter, memory and the audit log fail open.
- Every gate fails closed.

**Migrations, adapters and jobs**
- Migrations are numbered `NNNN_description.sql` and idempotent: `IF NOT EXISTS`, plus a `-- once:` comment before any `ADD COLUMN`. They run in order, and `scripts/check-migration-order.mjs` runs in the hook. Every table has a `created_at`.
- Each adapter folder has `manifest.json` (name, ports, required secrets, flags, per-tool taint and gate, cost table), `index.ts` exporting `createAdapter`, and `contract.test.ts` running the shared contract for its port.
- Jobs register with the job registry (`name`, `schedule`, `flag`, `ceilings`, `run`). The cron handler is a loop over the registry, never a switch statement. Schedules use named days (`MON-FRI`), because Cloudflare counts day 1 as Sunday.

**Models**
- Model calls go through the model gateway port with a role: `strategist`, `worker`, `writer`, `judge`, `triage`, `classifier`, `coder` or `embedding`. Concrete model ids live only in `gtm.config.ts`.
- Never put a model call in a per-minute job.

## Documents and where things go

| Question | Read |
|----------|------|
| How does a deployment work, and what are the bindings | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| What does an adapter have to implement | [docs/INTERFACES.md](docs/INTERFACES.md) |
| How is a tool classified, and what does the action gate refuse | [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md) |
| How does a host application talk to the agent | [docs/EVENT-CONTRACT.md](docs/EVENT-CONTRACT.md) |
| What goes in `brain/` and `templates/`, and how is it validated | [docs/BRAIN-SCHEMA.md](docs/BRAIN-SCHEMA.md) |
| Why was a structural choice made | [docs/DECISIONS.md](docs/DECISIONS.md) |
| What exists, and what each milestone must prove | [docs/ROADMAP.md](docs/ROADMAP.md) |
| How to contribute | [CONTRIBUTING.md](CONTRIBUTING.md) |

Operational facts about a particular deployment (resource names, secrets, the brain) never live in this repository. They live in that deployment's own private overlay ([examples/overlay](examples/overlay/)).
