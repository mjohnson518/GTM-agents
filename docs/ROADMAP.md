# Roadmap

GTM-agents is built in milestones. Each one is deployable and useful on its own, and each has a gate: a concrete behavior that must work before the milestone counts as done. The gate is written as a test first.

## Where things stand

| Milestone | Status |
|---|---|
| 0. Foundation | Done |
| 0b. First agent | Done (behind `operator:agent_enabled`) |
| 1. Safety spine and data layer | Done |
| 2. Sourcing and enrichment | Done (behind `discovery:enabled`) |
| 3. Outreach | Done (behind `cold_batch:enabled` and `delivery:enabled`) |
| 4. Replies | Done (behind `inbox:enabled` and the `replies:*` flags; no reply is sent automatically yet) |
| 5. Measurement | Done (the scorecard and digests behind the `ops:*` flags) |
| 6. Sequences | Done (behind `sequences:enabled`) |
| 7. Experiments | Done (behind `experiments:enabled`; Thompson sampling behind `outreach:allocation_mode`) |
| 8. Convert | Done (calendar sync behind `convert:calendar_enabled`; post-meeting messages are drafts, and proof of value is not built yet) |
| 9. Lifecycle | Done (behind `lifecycle:enabled` and `billing:enabled`; billing through the port, with no vendor adapter yet) |
| 10. Autonomy | Done (levels raised only by a confirmed operator command; the weekly review behind `autonomy_review:enabled`; automatic replies behind `inbound:auto_send_tier` and level 2) |
| 11. Signals and scale | Done (each source behind its own `signals:*` flag; the intent score in shadow until enforced) |
| 12. Self-improvement | Done (every loop behind its own `learning:*` flag; proposals only, except `brain_edit` at level 2) |
| 13. Ship loop (module) | Built ([SHIP.md](SHIP.md)); not yet run against a live repository |
| 14. Dashboard | Done (behind Cloudflare Access and `admin:enabled`) |

**What exists today:**
- the workspace layout and its package boundaries;
- the repository checks (placeholders, secrets, migration order, house rules, conflict copies, doc links), run by the pre-commit hook and by CI;
- the reference docs in this folder;
- the engineering contract (`CLAUDE.md`) and the contributing, security, acceptable-use and conduct policies;
- the core runtime skeleton: `createWorker`, configuration, the job registry, the port interfaces, the brain and template engines, and the baseline migration;
- the worker template, which bundles from placeholders, and the admin shell;
- the `gtm` CLI ([DEPLOYING.md](DEPLOYING.md)): `init`, `doctor`, `brain validate|upload|diff`, `setup` (creates the Cloudflare resources and fills in `wrangler.jsonc`), `migrate`, `flags` (validated against the flag registry) and `deploy`;
- one per-minute cron trigger, from which the Worker runs every job whose schedule is due;
- publishable packages ([RELEASING.md](RELEASING.md)): a build that ships JavaScript and types, `gtm init` that installs from npm at one pinned version, a CI check that installs the packed packages and dry-runs a deploy, and a release workflow that publishes only on a version tag;
- `examples/brains/acme`, a complete, locked example brain with a three-step template sequence, and a behavior eval that renders it;
- the safety spine ([SECURITY-MODEL.md](SECURITY-MODEL.md)):
  - for untrusted text: the taint model and action gate, the tool registry and dispatcher, sanitize and fence, URL and egress checks, delegation taint, approval digests, and the security contract that adapters run;
  - for everything else: the effects ledger, the fault-tolerant job runner with run rows, failure pages and cron health, rate limits, the budget gate and cost ledger, the system halt and cold outreach kill switch, the suppression list and the send gates;
- the data model ([DATA-MODEL.md](DATA-MODEL.md)): about a hundred tables across the CRM, pipeline, outreach, experiments, discovery, events, agent operations and the ship loop, with the helpers that keep warmth forward-only and deal stages valid;
- the first agent ([OPERATOR.md](OPERATOR.md)): a Telegram operator channel, a hub agent that runs a tool loop through the dispatcher with research, contact search and drafting tools, chat sessions whose taint persists until `/clean`, approvals bound to the draft's digest, and bearer auth on the API;
- sourcing and enrichment ([SOURCING.md](SOURCING.md)): a weekday discovery cycle, the email finder and verifier waterfall with cached verification, per-field evidence and conflict holds, identity and duplicate rules, a deterministic person-fit gate, a nightly account prescore and an optional model fit score, and promotion of qualified candidates with verified work emails;
- outreach ([OUTREACH.md](OUTREACH.md)): template allocation and variables, the quality gate with an optional model reviewer, the daily cold batch with account-level rules, a no-send holdout, readiness scoring, and approval manifests released from the operator chat;
- delivery ([SENDING.md](SENDING.md)): a provider boundary that runs every send check itself, the plain-text footer and one-click unsubscribe, delivery and bounce webhooks that suppress hard bounces and complaints, send windows and the deferred queue, per-domain and per-account caps, a circuit breaker, the warm-up ramp, the bounce monitor and liveness checks;
- the inbox ([INBOX.md](INBOX.md)): Gmail polling and push, Cloudflare Email Routing through the Worker's `email()` entry point, structural classification without a model, and the deterministic consequences of each class (a reply stops every sequence at the account, an unsubscribe suppresses, an out-of-office reply holds the next step, a bounce suppresses the address);
- replies ([REPLIES.md](REPLIES.md)): model triage, routing by intent, the meeting qualifier, drafts from approved facts, approved sends from the warm mailbox with freshness checks, reply-owed reminders, mailbox draft mirroring, and the one definition of a positive reply;
- measurement ([MEASUREMENT.md](MEASUREMENT.md)): one definition of each metric in one module (sends, matured samples, replies and positive replies, first-touch attribution, bounce and complaint rates, reply SLA, spend, failed jobs, measurement health, holdout lift), the daily scorecard, the funnel and cost digests and the conversion report, all reading the same definitions;
- meetings ([CONVERT.md](CONVERT.md)): read-only Google Calendar sync with privacy-limited fields, attribution without click tracking, the one "meeting booked" definition, a booking that stops outreach and writes a prep brief, reminders, held and no-show handling, and post-meeting drafts;
- the operator dashboard ([DASHBOARD.md](DASHBOARD.md)): every view (overview, cockpit, pipeline, inbound, proposals and learning, contacts, agents, chat, activity, settings, changelog) over a WebSocket gateway behind Cloudflare Access;
- self-improvement ([LEARNING.md](LEARNING.md)): edit mining, the voice profile, the retrospective and agent review, learnings and brain proposals, objection answers, fitness, the benchmark and evolution;
- the optional ship loop ([SHIP.md](SHIP.md)): feedback themes, specs approved against a digest, a path policy, a coding agent (Claude Code by default, OpenCode as a swap) in a Cloudflare container with no credentials and only allowlisted egress, one commit and a pull request a person merges, and deploy detection with "it is live" notes;
- a Stripe billing adapter and lifecycle follow-ups to product users;
- experiments ([EXPERIMENTS.md](EXPERIMENTS.md)): Thompson sampling with a protected control, account-clustered assignment, template, subject and send-time tests, pre-registration with two-step approval, conclusions only on the pre-registered metric with healthy measurement, the copy-change gate, and a weekly rule-based self-review;
- signals ([SIGNALS.md](SIGNALS.md)): Exa websets, search monitors and dated news, public hiring boards, responder lookalikes and coverage fill, signal carry to new contacts, an intent score, and openers built only from real, dated signals;
- earned autonomy ([AUTONOMY.md](AUTONOMY.md)): one level reader that fails closed, permanently human-only classes capped by code and by the database, evidence from every decision point, weekly promotion proposals only a person confirms, immediate demotion after incidents, an outbound writer registry with evals, and narrow, rule-checked automatic replies;
- lifecycle ([LIFECYCLE.md](LIFECYCLE.md)): the host SDK, the event spine, signed product and billing webhooks, the lifecycle state machine with one writer, the deal mirror, nightly reconciliation, MRR snapshots, and one definition each of sign-ups, activations and new paying customers;
- run-row retention and one definition of the bounce rate, shared by the ramp, the bounce monitor, readiness and the reports;
- sequences ([SEQUENCES.md](SEQUENCES.md)): the follow-up sweep, steps threaded under the first email, a reply check from anyone at the account right before each send, and release like the cold batch;
- the first adapters: `operator-telegram`, `llm-gateway` (Anthropic), `data-exa` (search), `data-hunter` (finder, verifier, people), `email-resend`, `inbox-gmail`, `email-cloudflare` and `calendar-google`, each with a hermetic contract test.

Nothing runs until you turn it on: the agent, discovery, the cold batch, real sends, the inbox, reply handling, follow-ups, calendar sync, lifecycle, the autonomy review and the optional ship loop are each off by default, and none has yet been run against live providers. The first release remains.

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
