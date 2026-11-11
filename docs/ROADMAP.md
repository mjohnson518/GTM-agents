# Roadmap

This page is for adopters deciding whether the toolkit does what they need, and for contributors choosing what to work on. GTM-agents is built in milestones. Each one is deployable and useful on its own, and each has a gate: a concrete behavior that must work before the milestone counts as done. The gate is written as a test first.

## Where things stand

| Milestone | Status |
|---|---|
| 0. Foundation | Done |
| 0b. First agent | Done (behind `operator:agent_enabled`) |
| 1. Safety spine and data layer | Done |
| 2. Sourcing and enrichment | Done (behind `discovery:enabled`) |
| 3. Outreach | Done (behind `cold_batch:enabled` and `delivery:enabled`) |
| 4. Replies | Done (behind `inbox:enabled` and the `replies:*` flags; every reply waits for a person unless automatic replies are earned under milestone 10) |
| 5. Measurement | Done (the scorecard and digests behind the `ops:*` flags) |
| 6. Sequences | Done (behind `sequences:enabled`) |
| 7. Experiments | Done (behind `experiments:enabled`; Thompson sampling behind `outreach:allocation_mode`) |
| 8. Convert | Done (calendar sync behind `convert:calendar_enabled`; post-meeting messages are drafts, and proof of value is not built yet) |
| 9. Lifecycle | Done (behind `lifecycle:enabled` and `billing:enabled`; billing through the port, with no vendor adapter yet) |
| 10. Autonomy | Done (levels raised only by a confirmed operator command; the weekly review behind `autonomy_review:enabled`; automatic replies behind `inbound:auto_send_tier` and level 2) |
| 11. Signals and scale | Done (each source behind its own `signals:*` flag; the intent score in shadow until enforced) |
| 12. Self-improvement | Done (every loop behind its own `learning:*` flag; proposals only, except `brain_edit` at level 2) |
| 13. Ship loop (module) | Done (the optional ship module, behind the `ship:*` flags; not yet run against a live repository) |
| 14. Dashboard | Done (behind Cloudflare Access and `admin:enabled`) |

**What exists today** ([CHANGELOG.md](../CHANGELOG.md) lists each release item by item):
- **Foundation:** the workspace and its package boundaries; the repository checks (placeholders, secrets, migration order, house rules, conflict copies, doc links, licenses), run by the pre-commit hook and by CI; the engineering contract (`CLAUDE.md`) and the contributing, security, acceptable-use and conduct policies; `createWorker`, configuration, the job registry with one per-minute cron trigger, the port interfaces, and the brain and template engines; the worker template, which bundles from placeholders; `examples/brains/acme`, a complete, locked example brain with a three-step template sequence.
- **Safety spine** ([SECURITY-MODEL.md](SECURITY-MODEL.md)): the taint model and action gate, the tool registry and dispatcher, sanitize and fence, URL and egress checks, delegation taint, approval digests and the security contract that adapters run; the effects ledger, the fault-tolerant job runner with run rows, failure pages and cron health, run-row retention, rate limits, the budget gate and cost ledger, the halt flag and the cold outreach kill switch, the suppression list and the send gates.
- **Data model** ([DATA-MODEL.md](DATA-MODEL.md)): over a hundred tables across the CRM, pipeline, outreach, experiments, discovery, events, agent operations and the ship loop, with the helpers that keep warmth forward-only and deal stages valid, and erasure with tombstones.
- **Operator chat** ([OPERATOR.md](OPERATOR.md)): a Telegram channel, a hub agent with research, contact search and drafting tools, chat sessions whose taint persists until `/clean`, approvals bound to the draft's digest, and bearer auth on the API.
- **Sourcing** ([SOURCING.md](SOURCING.md)) and **signals** ([SIGNALS.md](SIGNALS.md)): the weekday discovery cycle, the email finder and verifier waterfall with cached verification, per-field evidence and conflict holds, identity and duplicate rules, the person-fit gate, the nightly prescore and optional model fit score, account research that stores only cited facts, promotion with verified work emails, and a reason code on every rejected candidate; websets, search monitors (with article hits as signals), dated news, public hiring boards, responder lookalikes, coverage fill, signal carry, the intent score and openers built only from real, dated signals.
- **Outreach, sending and sequences** ([OUTREACH.md](OUTREACH.md), [SENDING.md](SENDING.md), [SEQUENCES.md](SEQUENCES.md)): template allocation and variables, the quality gate with a cliché check and an optional model reviewer, the daily cold batch with a no-send holdout, readiness and approval manifests released from the operator chat; the send function that runs every send check itself, the plain-text footer and one-click unsubscribe, delivery and bounce webhooks, send windows and the deferred queue, per-domain and per-account caps, the circuit breaker, the warm-up ramp and the bounce monitor; the follow-up sweep, steps threaded under the first email, and a reply check across the account before every step.
- **Inbox and replies** ([INBOX.md](INBOX.md), [REPLIES.md](REPLIES.md)): Gmail polling and push, Cloudflare Email Routing, structural classification without a model and its deterministic consequences; model triage, routing by intent, the meeting qualifier, drafts from approved facts, approved sends from the warm mailbox, reply-owed reminders and mailbox draft mirroring.
- **Measurement and experiments** ([MEASUREMENT.md](MEASUREMENT.md), [EXPERIMENTS.md](EXPERIMENTS.md)): one definition of each metric in one module, the daily scorecard, the funnel digest (with rejections by reason) and the cost digest, and the conversion report; Thompson sampling with a protected control, account-clustered assignment, template, subject and send-time tests, pre-registration, the copy-change gate and the weekly self-review.
- **Convert and lifecycle** ([CONVERT.md](CONVERT.md), [LIFECYCLE.md](LIFECYCLE.md)): read-only Google Calendar sync with privacy-limited fields, attribution without click tracking, prep briefs, reminders, held and no-show handling and post-meeting drafts; the host SDK, the signed product bridge and the event spine, the lifecycle state machine, the deal mirror, nightly reconciliation, MRR snapshots, a Stripe billing adapter and lifecycle follow-ups to product users.
- **Autonomy and self-improvement** ([AUTONOMY.md](AUTONOMY.md), [LEARNING.md](LEARNING.md)): one level reader that fails closed, permanently human-only classes, evidence, weekly promotion proposals a person confirms, immediate demotion, the outbound writer registry and narrow automatic replies; edit mining, the voice profile, the retrospective and agent review, learnings and brain proposals, objection answers, fitness, the benchmark and evolution.
- **Operator dashboard** ([DASHBOARD.md](DASHBOARD.md)): every view (overview, cockpit, pipeline, inbound, proposals, learning, contacts, agents, chat, activity, settings, changelog) over a WebSocket gateway behind Cloudflare Access.
- **The optional ship module** ([SHIP.md](SHIP.md)): feedback themes, specs approved against a digest, a path policy, a coding agent in a Cloudflare container with no credentials, one commit and a pull request a person merges, and "it is live" notes.
- **The `gtm` CLI and packaging** ([DEPLOYING.md](DEPLOYING.md), [RELEASING.md](RELEASING.md)): `init`, `setup`, `migrate`, `brain validate|upload|diff`, `flags`, `doctor` (with `--remote` checks of SPF, DKIM and DMARC) and `deploy`; a release build that ships JavaScript and types, `gtm init` from npm at one pinned version, and a CI smoke test of the packed packages.
- **Adapters** ([packages/adapters](../packages/adapters/README.md)): `operator-telegram`, `llm-gateway` (Anthropic), `data-exa`, `data-hunter`, `data-jobboards`, `email-resend`, `inbox-gmail`, `email-cloudflare`, `calendar-google` and `billing-stripe`, plus `code-github` and `sandbox-cloudflare` for the ship module, each with a hermetic contract test.

Nothing runs until you turn it on: every capability above is off by default behind its own flag, and none has yet been run against live providers.

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
| 9 | Lifecycle | The product bridge and SDK, the lifecycle state machine, billing webhooks, MRR snapshots, erasure with tombstones | Sign-ups and payments move contacts and deals |
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
