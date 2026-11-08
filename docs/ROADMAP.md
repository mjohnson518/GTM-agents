# Roadmap

GTM-agents is built in milestones. Each one is deployable and useful on its own, and each has a gate: a concrete behavior that must work before the milestone counts as done. The gate is written as a test first.

## Where things stand

| Milestone | Status |
|---|---|
| 0. Foundation | In progress |
| 1 to 14 | Planned |

**What exists today:**
- the workspace layout and its package boundaries;
- the repository checks (placeholders, secrets, migration order, house rules, conflict copies, doc links), run by the pre-commit hook and by CI;
- the reference docs in this folder;
- the engineering contract (`CLAUDE.md`) and the contributing, security, acceptable-use and conduct policies.

The runtime is not usable yet.

## Milestones

| # | Milestone | What it adds | Gate |
|---|---|---|---|
| 0 | Foundation | Workspace, checks and CI. Core runtime skeleton (`createWorker`, job registry, config schema, port interfaces, brain loader). The worker template with placeholders and the admin shell. The `gtm` CLI (`init`, `doctor`, `brain validate`). The Acme example brain | `gtm init` produces a template that passes `wrangler deploy --dry-run` with placeholders, and `gtm brain validate examples/brains/acme` passes |
| 0b | First agent | The operator channel, the hub agent with three tools, bearer auth for the API | A task sent from the operator channel returns research and a draft |
| 1 | Safety spine and data layer | Taint model, sanitize and fence, approval digests, effects ledger, fault-tolerant job runner and cron health, rate limits, budget gate and cost ledger, halt flag and kill switch, suppression. Then the baseline data model | An injected web page in a tool result cannot cause a send |
| 2 | Sourcing and enrichment | Semantic and structured search, the candidates pipeline, the email finder and verifier waterfall, identity rules, the fit gate, prescoring | Qualified contacts appear daily with verified work emails |
| 3 | Outreach | Templates and variables, the quality gate, the cold batch with manifest approval, email provider and webhooks, one-click unsubscribe, send windows, the deferred queue, the warm-up ramp, the bounce monitor | A batch goes out, delivery is recorded, and a bounce suppresses the address |
| 4 | Replies | Push and poll detection, structural and model triage, intent routing, drafting from approved facts, freshness checks, the reply-owed clock, drafts mirrored into the mailbox | A reply is triaged and drafted within minutes, and the operator is reminded until it is answered |
| 5 | Measurement | The per-send ledger, the single positive-reply definition, the daily scorecard, the conversion report, measurement health | Every report agrees on the numbers |
| 6 | Sequences | Threaded follow-up steps, stop rules, the follow-up sweep | Follow-ups thread under the first email and stop on any reply from the account |
| 7 | Experiments | Thompson sampling with a protected control, account-clustered assignment, holdout, pre-registration, the copy-change gate | An experiment concludes honestly on its pre-registered metric |
| 8 | Convert | Booking links, calendar sync with privacy-limited fields, reminders, no-show recovery, the post-demo sequence, the deal mirror | A booked meeting stops outreach and creates a prep brief |
| 9 | Lifecycle | The product event bridge and SDK, the lifecycle state machine, billing webhooks, MRR snapshots, erasure with tombstones | Sign-ups and payments move contacts and deals |
| 10 | Autonomy | Levels per action class, decision evidence, promotion proposals, demotion on incidents, the eval registry for outbound writers | An action class earns "act and notify" from evidence |
| 11 | Signals and scale | Additional sources, signal carry, intent scoring, angles, coverage fill, multithreading | Most first touches carry a dated reason |
| 12 | Self-improvement | Daily retrospective, agent review, learnings proposals, voice profile, edit mining, brain diff proposals | The system proposes better copy and a person approves it |
| 13 | Ship loop (module) | Feedback themes, specs, the sandboxed coding agent, path policy, pull requests, deploy detection | A feature request becomes a pull request a person reviews |
| 14 | Dashboard | The WebSocket gateway and the full admin views | The operator runs the day from two screens |

## Principles that hold at every milestone

- New behavior ships behind a flag that defaults to off.
- Every gate fails closed, and every piece of bookkeeping fails open.
- Every send goes through the same send path and its checks.
- Every fixture is synthetic.
