# GTM-agents

An open-source, multi-agent go-to-market system that runs as a single Cloudflare Worker. One deployment sells one product, end to end:
- it finds the right accounts and people, and verifies their work email;
- it writes and sends plain-text outreach and runs honest experiments on the copy;
- it follows up, answers replies, books meetings, and follows customers through sign-up and payment.

A person approves every send until the system has earned autonomy for that kind of action, from evidence.

> **Status: early (0.2.0).** Every capability listed below is built and covered by hermetic tests, and each ships behind a flag that defaults to off. None has yet been run against live providers. [CHANGELOG.md](CHANGELOG.md) lists what this release contains, [docs/ROADMAP.md](docs/ROADMAP.md) shows what exists and what comes next, and [docs/DEPLOYING.md](docs/DEPLOYING.md) is the full path to your own deployment.

## Who it is for

- **Founders and small teams selling a B2B product**, who want a GTM system they own and can inspect, instead of renting a black box. You bring a Cloudflare account, your email and data providers, and your knowledge of the market. The system brings the loop and the controls.
- **Contributors**, who add adapters for the providers they use, domain packs for their vertical, or improvements to the core loop.
- **The coding agents both of them use.** [CLAUDE.md](CLAUDE.md) is the engineering contract those agents follow.

## What it does

| Area | What the system covers |
|---|---|
| Sourcing | Semantic and structured search, standing person searches (websets), search monitors, hiring and funding signals, lookalikes of accounts that responded, coverage of high-fit accounts |
| Enrichment | An email finder and verifier waterfall with cached verification, per-field evidence and conflict holds, identity and duplicate rules |
| Scoring | A free nightly account prescore, an optional model fit score against your rubric, person fit from buying roles, an intent score from dated signals |
| Outreach | Templates and operator-written copy lines (cold copy is assembled, never generated), a deterministic quality gate plus a model reviewer, approval manifests, send windows, warm-up ramp, kill switch |
| Follow-up | Threaded sequences that stop on any reply from the account, an optional manual LinkedIn or X touch you make yourself, lifecycle follow-ups for product users |
| Experiments | A per-send ledger, Thompson sampling with a protected control, account-clustered assignment, a no-send holdout, pre-registered experiments, an approval-gated copy-change process |
| Replies | Push and poll detection, structural and model triage, intent routing, drafts grounded in approved facts, a reply-owed clock, drafts mirrored into your mailbox |
| Convert | A booking link variable, calendar sync that never reads event titles, attribution without click tracking, prep briefs, reminders, held and no-show handling, post-meeting drafts |
| Lifecycle | A signed product bridge and host SDK, a lifecycle state machine, the deal mirror, billing webhooks (a Stripe adapter), MRR snapshots, erasure with tombstones |
| Self-improvement | A daily retrospective (one change at a time), learnings proposals you approve, a voice profile built from your own sent mail, mining of your edits |
| Ship (optional module) | Product feedback grouped into themes, specs you approve, a sandboxed coding agent that opens a pull request a person merges, "it is live" notes to the people who asked |
| Operator | An operator chat with one-tap approvals, a web dashboard behind Cloudflare Access, a daily scorecard, approvals bound to exactly what you saw, earned autonomy per action class |

## How it stays safe

- **Untrusted text is never an instruction.** Web pages, inbound email and provider responses are tainted, fenced data. Once a session has read untrusted text, it cannot send, write or spend.
- **Skip rather than guess.** A missing first name holds the draft; it never becomes "Hi there". An unverifiable address is not emailed.
- **Gates fail closed, bookkeeping fails open.** If the halt flag, the kill switch, suppression or a budget cannot be read, the action is blocked.
- **Autonomy is earned per action class.** Pricing, offers, code merges, proof-of-value sends and data deletion are permanently human-only.
- **Plain-text email from work addresses,** with one-click unsubscribe on every message and a postal footer on cold and follow-up mail. No tracking pixels, no click tracking, no LinkedIn automation.

## Architecture at a glance

```
operator chat + dashboard -> OperatorGateway -> hub agent -> tools (taint-classified, budgeted)
                                                   |
            D1 (truth) . KV (flags) . R2 (payloads) . Vectorize (reserved) . Queues . Durable Objects
                                                   |
                 scheduled jobs (job registry) . webhooks (email, mailbox, product, billing)
```

- `packages/core` makes every decision.
- `packages/adapters` talks to vendors through ports.
- `brain/`, `templates/` and `gtm.config.ts` hold everything about your company, so selling a different product never requires a code change.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has the full picture, and [docs/](docs/) has the rest of the reference.

## Quick start

[docs/QUICKSTART.md](docs/QUICKSTART.md) is the shortest path from nothing to a staging deployment whose operator chat answers `/status`, with everything else still off. In short, from a published release (Node 24 or later):

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
npx gtm doctor --remote              # also checks SPF, DKIM and DMARC on your sending domain
npx wrangler deploy --dry-run        # the Worker bundles from placeholders
```

`examples/brains/acme` is a complete brain to copy from. To deploy, follow [docs/DEPLOYING.md](docs/DEPLOYING.md): `gtm setup` creates the Cloudflare resources and fills in `wrangler.jsonc`, then `gtm migrate`, `gtm brain upload`, `gtm flags` and `gtm deploy`. Workers Paid is required.

## Documentation

| Document | For |
|---|---|
| [docs/QUICKSTART.md](docs/QUICKSTART.md) | Your first staging deployment, step by step |
| [docs/DEPLOYING.md](docs/DEPLOYING.md) | Deploying, the staged rollout, operating and troubleshooting |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How a deployment works |
| [docs/INTERFACES.md](docs/INTERFACES.md) | Writing an adapter |
| [docs/EVENT-CONTRACT.md](docs/EVENT-CONTRACT.md) | Connecting your product to a deployment |
| [docs/BRAIN-SCHEMA.md](docs/BRAIN-SCHEMA.md) | Writing your brain and templates |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Why the structure is what it is |
| [docs/ROADMAP.md](docs/ROADMAP.md) | What exists and what is coming |
| [CHANGELOG.md](CHANGELOG.md) | What each release contains |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contributing code, adapters and docs |
| [SECURITY.md](SECURITY.md) | Reporting a vulnerability |
| [ACCEPTABLE-USE.md](ACCEPTABLE-USE.md) | What this system may and may not be used for |

## License

[Apache-2.0](LICENSE).

## Credits and contact

Created and maintained by [Marc Johnson](https://marcjohnson.xyz). If you're interested in using this system for your product or services, I'm happy to work with you: [m@c12.space](mailto:m@c12.space).
