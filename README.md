# GTM-agents

An open-source, multi-agent go-to-market system that runs as a single Cloudflare Worker. One deployment sells one product, end to end:
- it finds the right accounts and people, and verifies their work email;
- it writes and sends plain-text outreach and runs honest experiments on the copy;
- it follows up, answers replies, books meetings, and follows customers through sign-up and payment.

A person approves every send until the system has earned autonomy for that kind of action, from evidence.

> **Status: early.** Sourcing, outreach, delivery, replies, follow-ups and measurement are built and tested, each behind a flag that defaults to off, but no capability has yet been proven on a live deployment. [docs/ROADMAP.md](docs/ROADMAP.md) shows what exists today and what comes next; [docs/DEPLOYING.md](docs/DEPLOYING.md) is the full path to your own deployment.

## Who it is for

- **Founders and small teams selling a B2B product**, who want a GTM system they own and can inspect, instead of renting a black box. You bring a Cloudflare account, your email and data providers, and your knowledge of the market. The system brings the loop and the controls.
- **Contributors**, who add adapters for the providers they use, domain packs for their vertical, or improvements to the core loop.
- **The coding agents both of them use.** [CLAUDE.md](CLAUDE.md) is the engineering contract those agents follow.

## What it does

| Area | What the system covers |
|---|---|
| Sourcing | Semantic and structured search, list-building agents, monitors, hiring and funding signals, lookalikes of accounts that replied, coverage of high-fit accounts |
| Enrichment | An email waterfall across providers, verification with cached results, firmographics, per-field evidence and conflict holds, job-change checks |
| Scoring | Account fit against your rubric, person fit from buying roles, intent from dated signals, engagement and coverage |
| Outreach | Templates and operator-written copy lines (cold copy is assembled, never generated), a deterministic quality gate plus a model reviewer, approval manifests, send windows, warm-up ramp, kill switch |
| Follow-up | Threaded sequences that stop on any reply from the account, colleague follow-up after silence, re-engagement on a new signal, lifecycle follow-ups for product users |
| Experiments | A per-send ledger, Thompson sampling with a protected control, account-clustered assignment, a no-send holdout, pre-registered experiments, an approval-gated copy-change process |
| Replies | Push and poll detection, structural and model triage, intent routing, drafts grounded in approved facts, a reply-owed clock, drafts mirrored into your mailbox |
| Convert | Booking links, calendar sync that never reads event titles, reminders, no-show recovery, post-demo sequences, an optional proof-of-value hook |
| Lifecycle | A signed event bridge from your product, a lifecycle state machine, billing webhooks, MRR snapshots, erasure with tombstones |
| Self-improvement | A daily retrospective (one change at a time), learnings proposals you approve, a voice profile built from your own sent mail, mining of your edits |
| Operator | A chat channel with one-tap approvals, a web dashboard, a daily scorecard, approvals bound to exactly what you saw |

## How it stays safe

- **Untrusted text is never an instruction.** Web pages, inbound email and provider responses are tainted, fenced data. Once a session has read untrusted text, it cannot send, write or spend.
- **Skip rather than guess.** A missing first name holds the draft; it never becomes "Hi there". An unverifiable address is not emailed.
- **Gates fail closed, bookkeeping fails open.** If the halt flag, the kill switch, suppression or a budget cannot be read, the action is blocked.
- **Autonomy is earned per action class.** Pricing, offers, code merges, proof-of-value sends and data deletion are permanently human-only.
- **Plain-text email from work addresses,** with a postal footer and one-click unsubscribe. No tracking pixels, no click tracking, no LinkedIn automation.

## Architecture at a glance

```
operator chat + dashboard -> OperatorGateway -> hub agent -> tools (taint-classified, budgeted)
                                                   |
            D1 (truth) . KV (flags) . R2 (payloads) . Vectorize (memory) . Queues . Durable Objects
                                                   |
                 scheduled jobs (job registry) . webhooks (email, mailbox, product, billing)
```

- `packages/core` makes every decision.
- `packages/adapters` talks to vendors through ports.
- `brain/`, `templates/` and `gtm.config.ts` hold everything about your company, so selling a different product never requires a code change.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the full picture, and [docs/](docs/) has the rest of the reference.

## Quick start

From a published release (Node 24 or later):

```bash
npx @gtm-agents/cli@<version> init my-agent   # every package pinned to that version
cd my-agent && npm install
npx gtm brain validate && npx gtm doctor && npx wrangler deploy --dry-run
```

To work on the toolkit itself, or to use code that is not released yet, start from a checkout of this repository:

```bash
git clone <repository-url> gtm-agents
cd gtm-agents
npm install                          # also installs the git hooks
npm run check                        # typecheck, lint, tests, evals and the repository checks

npx gtm init ../my-agent --local .   # copy the worker template, using this checkout's packages
cd ../my-agent
npm install
npx gtm brain validate               # check your brain and templates against the schema
npx gtm doctor                       # bindings, config, adapters, secrets, webhooks, kill switch, flags
npx wrangler deploy --dry-run        # the Worker bundles from placeholders
```

`examples/brains/acme` is a complete brain to copy from. To deploy, follow [docs/DEPLOYING.md](docs/DEPLOYING.md): `gtm setup` creates the Cloudflare resources and fills in `wrangler.jsonc`, then `gtm migrate`, `gtm brain upload`, `gtm flags` and `gtm deploy`. Workers Paid is required.

## Documentation

| Document | For |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How a deployment works |
| [docs/INTERFACES.md](docs/INTERFACES.md) | Writing an adapter |
| [docs/EVENT-CONTRACT.md](docs/EVENT-CONTRACT.md) | Connecting your product to a deployment |
| [docs/BRAIN-SCHEMA.md](docs/BRAIN-SCHEMA.md) | Writing your brain and templates |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Why the structure is what it is |
| [docs/ROADMAP.md](docs/ROADMAP.md) | What exists and what is coming |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contributing code, adapters and docs |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability |
| [ACCEPTABLE-USE.md](ACCEPTABLE-USE.md) | What this system may and may not be used for |

## License

[Apache-2.0](LICENSE).

## Credits and contact

Created and maintained by [Marc Johnson](https://marcjohnson.xyz). If you're interested in using this system for your product or services, I'm happy to work with you: [info@c12.space](mailto:info@c12.space).
