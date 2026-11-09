# Architecture decision records

Each record states a structural choice, why it was made, and what it costs. A change that reverses one of these gets a new record that supersedes it, instead of an edit to the old one.

| ADR | Decision | Status |
|---|---|---|
| [ADR-001](#adr-001-single-tenant-per-deployment) | Single tenant per deployment | Accepted |
| [ADR-002](#adr-002-cloudflare-native) | Cloudflare-native | Accepted |
| [ADR-003](#adr-003-ports-and-adapters-no-vendor-sdk-in-core) | Ports and adapters, no vendor SDK in core | Accepted |
| [ADR-004](#adr-004-deterministic-copy-with-gated-model-roles) | Deterministic copy with gated model roles | Accepted |
| [ADR-005](#adr-005-human-only-action-classes-the-agent-cannot-loosen) | Human-only action classes the agent cannot loosen | Accepted |
| [ADR-006](#adr-006-synthetic-fixtures-and-placeholder-only-templates) | Synthetic fixtures and placeholder-only templates | Accepted |
| [ADR-007](#adr-007-one-definition-of-every-metric) | One definition of every metric | Accepted |
| [ADR-008](#adr-008-agents-stage-humans-commit) | Agents stage, humans commit | Accepted |
| [ADR-009](#adr-009-source-first-typescript-on-node-24) | Source-first TypeScript on Node 24 | Accepted |
| [ADR-010](#adr-010-brain-and-template-files-are-strict-markdown) | Brain and template files are strict Markdown | Accepted |

---

## ADR-001: Single tenant per deployment

**Context.** A GTM system holds a company's prospects, its voice, its sending reputation, its budget and its autonomy history. A multi-tenant design would let one company's data, spend or deliverability affect another's, and every query would need a tenant filter that must never be forgotten.

**Decision.** One deployment serves one company and one product. Selling a second product means a second deployment, with its own database, KV namespace, brain, sending subdomain, budget and autonomy levels.

**Consequences.**
- No tenant column, no cross-tenant query paths and no shared rate limits.
- Isolation comes from Cloudflare resource boundaries, not application code.
- Running several products means running several Workers. `gtm init` and `gtm setup` make that cheap, but there is no single pane across deployments.
- The one deliberately cross-tenant path lives in the host application: the reconciliation reads in [EVENT-CONTRACT.md](EVENT-CONTRACT.md).

## ADR-002: Cloudflare-native

**Context.** The system needs:
- a relational store, a key-value store, blob storage and a vector index;
- queues and per-contact timers;
- real-time connections for the dashboard;
- sandboxed code execution;
- cron.

Assembling those from several vendors means several bills, several auth models and several failure modes.

**Decision.** Build on Cloudflare: Workers (Hono router), D1, KV, R2, Vectorize, Queues, Durable Objects, Workflows and Workers AI. Say so plainly, and don't hide it behind a storage abstraction.

**Consequences.**
- One deploy target, one config file, one bill.
- The template is deployable from placeholders with `wrangler deploy --dry-run`.
- Concepts port easily and code does not. The event spine, the effects ledger, the job registry and the safety controls translate to Postgres, Redis, S3 and a queue, but running elsewhere means rewriting the runtime layer.
- D1's limits shape the data layer: SQLite semantics, 100 bound parameters per statement, and batched queries that respect them.
- Cloudflare's cron day-of-week numbering (1 is Sunday) is a known trap. The job registry accepts named days only.

## ADR-003: Ports and adapters, no vendor SDK in core

**Context.** Email providers, data providers, model providers, calendars, billing systems and chat platforms all change. Each deployment picks different ones. Policy scattered across vendor integrations drifts: two places that check suppression will eventually disagree.

**Decision.** Core defines ports, and every third party is an adapter behind one ([INTERFACES.md](INTERFACES.md)).
- Adapters translate and never decide.
- Core never imports a vendor SDK; lint enforces it.
- Every adapter ships a manifest (secrets, flags, per-tool taint and gate, price table, limits) and passes a shared contract test with a recorded `fetch`.

**Consequences.**
- Swapping a provider is a configuration change.
- Policy has exactly one implementation.
- Adapters are small and testable without network access.
- Every new capability needs a port first, which is slower for the first integration of a kind.
- Interfaces change additively. Breaking one is a major version.

## ADR-004: Deterministic copy with gated model roles

**Context.** A model writing cold email at volume produces confident, plausible, unverifiable claims, and one bad batch damages a sending domain for weeks. Models are good at classification, judgment and drafting from approved inputs. They are bad at being the last line of defense.

**Decision.**
- Cold first touches are assembled by substitution from operator-written templates and copy lines. No model writes them.
- Models have explicit roles: strategist, worker, writer, judge, triage, classifier, coder, embedding. Core asks for a role, never a model id, and model ids live only in `gtm.config.ts`.
- Every message that may leave without a person reading it passes a deterministic gate (lint, house rules, claims, links, length, recipient match) and then a model reviewer.
- When the reviewer is unavailable, the message is held.

**Consequences.**
- Copy quality depends on the operator's templates, which is where accountability belongs.
- Experiments compare templates, not samples from a model.
- Fewer copy variants are possible without operator effort.
- A reviewer outage pauses automatic sends.

## ADR-005: Human-only action classes the agent cannot loosen

**Context.** Earned autonomy lets an action class move from "draft and ask" to acting on its own once evidence supports it. Some actions are unsafe to automate at any track record, because a single mistake is expensive or irreversible.

**Decision.** These action classes are permanently human:
- merging code;
- changes to pricing, billing or auth;
- offers and discounts;
- proof-of-value sends;
- data deletion.

They live in one constant (`PERMANENT_HUMAN`). Their level is capped at "draft and ask" both when it is read and when it is set. No flag, config value or agent action can raise it.

**Consequences.**
- These paths always wait for a person, even when the evidence would justify more.
- Changing the list is a code change with review, never an operational toggle.

## ADR-006: Synthetic fixtures and placeholder-only templates

**Context.** This repository is a template. Anything committed to it is copied into every deployment and visible to everyone. A real contact in a fixture is a privacy leak. A real resource id in the template is a configuration accident waiting to happen.

**Decision.**
- Every fixture is synthetic: the fictional company Acme, `*.example` domains, invented people and replies.
- The worker template carries `${...}` placeholders for every resource id and name, and `gtm setup` fills them in a deployment's own copy. The Worker and bucket names are the one exception: Wrangler validates their format even in a dry run, so they start as the generic defaults `gtm-agent` and `gtm-agent-bucket`.
- `scripts/check-placeholders.mjs` and `scripts/secrets-scan.sh` run in the pre-commit hook and in CI. They reject UUID-shaped strings outside fixtures that declare themselves synthetic, real `*.workers.dev` hostnames, concrete resource ids in Wrangler config, and credential-shaped values.
- A deployment's real brain, config and secrets live in its own private overlay ([examples/overlay](../examples/overlay/)).

**Consequences.**
- Tests read slightly artificially.
- The template always deploys from placeholders, and copying it never copies anyone's data.

## ADR-007: One definition of every metric

**Context.** When "positive reply" means one thing in the daily scorecard, another in an experiment and a third in an autonomy promotion check, the numbers disagree and nobody trusts any of them.

**Decision.** Each metric has exactly one implementation, in `packages/core/src/metrics/`, used by every report, experiment and promotion check. Examples:
- **Positive reply:** an interested, question or referral intent, or an attributed, non-cancelled meeting first seen after the send. Opt-outs, auto-replies, spam and noise never count.
- **Meeting booked.**
- **Conversation started.**

Measurement health (ledger coverage, unrouted product events) gates every conclusion, and fails closed.

**Consequences.**
- Reports agree by construction.
- Changing a definition changes every number at once, so a definition change is reviewed like a schema change.

## ADR-008: Agents stage, humans commit

**Context.** Coding agents are effective contributors to this repository and to deployments built from it. A commit is a publication decision: it lands in history, triggers CI and can deploy. An agent that commits and pushes can publish something nobody reviewed.

**Decision.**
- Agents working in this repository stage their changes and hand the commit to a person.
- They do not commit, push, rewrite history or touch remotes.
- The hooks in `.githooks/` are the gate and are never bypassed.

**Consequences.**
- Every commit has a human author who read the staged diff.
- Agent-assisted work takes one extra step per commit.
- Local hooks (`.local/hooks/<name>`) give each maintainer a place for checks that only make sense on their machine.

## ADR-009: Source-first TypeScript on Node 24

**Context.** The same TypeScript runs in four places:
- in the Worker, bundled by Wrangler;
- in tests, run by Vitest;
- in the dashboard, bundled by Vite;
- in the `gtm` CLI, run by Node.

A build step per package means stale output, source maps and a slower loop for every contributor.

**Decision.**
- There is no build step in development. Node 24 runs the CLI's TypeScript directly, using native type stripping, and the bundlers consume the same sources.
- `tsconfig.base.json` enables `strict`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `allowImportingTsExtensions` and `noUncheckedIndexedAccess`.
- Code uses only erasable syntax: no enums, namespaces or constructor parameter properties.
- Relative imports name the `.ts` file.

**Consequences.**
- Contributors need Node 24 or later (`.nvmrc`, `engines`).
- Published packages need JavaScript, because Node refuses to strip types from files inside `node_modules`. A release-only build compiles each package with its `tsconfig.build.json` (JavaScript, plus declarations for the libraries) and generates the published `package.json` at pack time, pointing `exports` and `bin` at `dist/`. Development never runs it: the source manifests keep their `.ts` exports and stay private, so only the generated ones can publish. [RELEASING.md](RELEASING.md) covers the build, the smoke test and the release workflow.
- Some TypeScript conveniences are off-limits, and lint and the compiler say so immediately.

## ADR-010: Brain and template files are strict Markdown

**Context.** Operators write the brain and templates, and they review and diff them in pull requests. YAML is flexible enough to be ambiguous. JSON is unpleasant to write prose in. Free-form Markdown cannot be validated or budgeted.

**Decision.**
- Brain and template files are Markdown with flat `key: value` frontmatter.
- Brain items are `## <id>` sections of `- key: value` bullets.
- A small, strict parser in core reads them, with no YAML dependency.
- One set of Zod schemas per component is the single source of truth. Validation, the loader and the published JSON Schemas (generated with `z.toJSONSchema()`) all derive from it.
- [BRAIN-SCHEMA.md](BRAIN-SCHEMA.md) is the format reference.

**Consequences.**
- Files are readable, diffable and validated with precise errors.
- Values cannot span lines or contain commas inside list fields. That is a deliberate limit for one-or-two-sentence items.
