# Changelog

This page is for adopters and deployers: what each release of GTM-agents contains. Every `@gtm-agents` package moves to the same version together ([docs/RELEASING.md](docs/RELEASING.md)), and a deployment changes only when its owner moves that version ([docs/DEPLOYING.md](docs/DEPLOYING.md#upgrading-to-a-new-version-of-the-toolkit)).

The file follows the format the operator dashboard's Changelog view reads: `## <version>` starts a release, `### <area>` starts an area, and each `- ` line is one entry. A deployment that keeps a copy in its static assets directory sees it in the dashboard ([docs/DASHBOARD.md](docs/DASHBOARD.md)).

## Unreleased

## 0.1.0 (2026-11-10)

The first release. Everything below is built and covered by hermetic tests (recorded provider responses, no network), but nothing has yet been run against live providers. Every capability ships off, behind a flag that defaults to off, and you turn each one on yourself in the order of the [staged rollout](docs/DEPLOYING.md#9-staged-rollout). [docs/QUICKSTART.md](docs/QUICKSTART.md) is the shortest path to a first staging deployment.

### Operator chat

- A Telegram operator chat with a hub agent that researches, searches your contacts and drafts, behind `operator:agent_enabled` ([docs/OPERATOR.md](docs/OPERATOR.md)).
- Chat commands that never reach the model, approvals bound to the exact draft shown, and chat sessions whose taint persists until `/clean` ([docs/OPERATOR.md](docs/OPERATOR.md#commands)).

### Safety and data

- The taint model and action gate, the tool registry and dispatcher, sanitize and fence, egress checks, delegation taint and a security contract every adapter runs ([docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md)).
- The effects ledger, run rows and cron health, budgets and the cost ledger, the halt flag, the cold outreach kill switch and the suppression list, with every gate failing closed ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).
- The D1 schema in idempotent, numbered migrations, forward-only contact warmth and deal stages, and erasure with tombstones ([docs/DATA-MODEL.md](docs/DATA-MODEL.md)).

### Sourcing

- A weekday discovery cycle that searches, enriches, qualifies and promotes, behind `discovery:enabled` ([docs/SOURCING.md](docs/SOURCING.md)).
- An email finder and verifier waterfall with cached verification, per-field evidence and conflict holds, and identity and duplicate rules ([docs/SOURCING.md](docs/SOURCING.md)).
- A deterministic person-fit gate, a free nightly account prescore and an optional model fit score ([docs/SOURCING.md](docs/SOURCING.md)).

### Outreach

- Operator-written templates assembled by substitution, never generated, and allocated by weight ([docs/OUTREACH.md](docs/OUTREACH.md)).
- A deterministic quality gate with an optional model reviewer, where every held draft carries the code that explains why ([docs/OUTREACH.md](docs/OUTREACH.md#the-quality-gate)).
- The daily cold batch with account-level rules, a no-send holdout, readiness scoring and approval manifests released from the operator chat, behind `cold_batch:enabled` ([docs/OUTREACH.md](docs/OUTREACH.md)).

### Sending

- A send function that runs every send check itself: the halt flag, the kill switch, suppression, the content lint, the verification policy, send windows, per-domain and per-account caps and a circuit breaker, behind `delivery:enabled` ([docs/SENDING.md](docs/SENDING.md)).
- Plain-text mail with one-click unsubscribe and a postal footer on cold and follow-up mail, and no tracking pixels or click tracking ([docs/SENDING.md](docs/SENDING.md)).
- Delivery and bounce webhooks, the deferred queue, the warm-up ramp and the bounce monitor ([docs/SENDING.md](docs/SENDING.md)).

### Sequences

- Follow-up steps threaded under the first email, swept on weekdays and released like the cold batch, behind `sequences:enabled` ([docs/SEQUENCES.md](docs/SEQUENCES.md)).
- A reply check across the whole account right before each step, and an optional manual LinkedIn or X touch that you make yourself ([docs/SEQUENCES.md](docs/SEQUENCES.md)).

### Inbox and replies

- Gmail polling and push, or Cloudflare Email Routing, with structural classification and its deterministic consequences and no model calls, behind `inbox:enabled` ([docs/INBOX.md](docs/INBOX.md)).
- Model triage and routing by intent, the meeting qualifier, drafts from approved facts, approved sends from the warm mailbox, reply-owed reminders and mailbox draft mirroring, each behind its own `replies:*` flag ([docs/REPLIES.md](docs/REPLIES.md)).

### Measurement

- One definition of each metric in `packages/core/src/metrics/`, shared by every report, experiment and promotion check ([docs/MEASUREMENT.md](docs/MEASUREMENT.md)).
- The daily scorecard, the weekly funnel digest, the cost digest and the conversion report, none of which calls a model ([docs/MEASUREMENT.md](docs/MEASUREMENT.md)).

### Experiments

- Thompson sampling with a protected control, account-clustered assignment, and template, subject and send-time tests, behind `experiments:enabled` ([docs/EXPERIMENTS.md](docs/EXPERIMENTS.md)).
- Pre-registration with two-step approval, conclusions only on the pre-registered metric with healthy measurement, the copy-change gate and a weekly rule-based self-review ([docs/EXPERIMENTS.md](docs/EXPERIMENTS.md)).

### Convert

- Read-only Google Calendar sync that never reads event titles or descriptions, and attribution without click tracking, behind `convert:calendar_enabled` ([docs/CONVERT.md](docs/CONVERT.md)).
- A booked meeting stops outreach to its account and writes a prep brief, followed by reminders, held and no-show handling, and recap, rebook and post-demo drafts for approval ([docs/CONVERT.md](docs/CONVERT.md)).

### Lifecycle and billing

- The host SDK and the signed product bridge, the event spine, the lifecycle state machine and the deal mirror, behind `lifecycle:enabled` ([docs/LIFECYCLE.md](docs/LIFECYCLE.md), [docs/EVENT-CONTRACT.md](docs/EVENT-CONTRACT.md)).
- Nightly reconciliation reads, daily MRR snapshots, and billing through the BillingProvider port with a Stripe adapter, behind `billing:enabled` ([docs/LIFECYCLE.md](docs/LIFECYCLE.md)).
- Lifecycle follow-ups to product users from approved templates, with offers always drafted for a person to approve ([docs/LIFECYCLE.md](docs/LIFECYCLE.md)).

### Autonomy

- Autonomy levels per action class, read by one reader that fails closed, with the permanently human-only classes capped in code and in the database ([docs/AUTONOMY.md](docs/AUTONOMY.md)).
- Evidence from every decision point, weekly promotion proposals that only a person confirms, immediate demotion after an incident, and an outbound writer registry with evals ([docs/AUTONOMY.md](docs/AUTONOMY.md)).
- Narrow, rule-checked automatic replies, which stay off unless you turn on `inbound:auto_send_tier` and raise the class yourself ([docs/AUTONOMY.md](docs/AUTONOMY.md)).

### Signals

- Websets, search monitors, dated funding and leadership news, public hiring boards, responder lookalikes and coverage fill, each behind its own `signals:*` flag ([docs/SIGNALS.md](docs/SIGNALS.md)).
- Signal carry to newly promoted contacts, a nightly intent score that runs in shadow until you enforce it, and openers built only from real, dated signals ([docs/SIGNALS.md](docs/SIGNALS.md)).

### Dashboard

- The operator dashboard at `/admin`, over a WebSocket gateway behind Cloudflare Access, behind `admin:enabled` ([docs/DASHBOARD.md](docs/DASHBOARD.md)).
- Overview, cockpit, pipeline, inbound, proposals, learning, contacts, agents, chat, activity, settings and changelog views, where every action runs through the same gates as its chat command ([docs/DASHBOARD.md](docs/DASHBOARD.md)).

### Self-improvement

- Edit mining, the voice profile, the daily retrospective, the agent review, objection answers, fitness, the benchmark and evolution, each behind its own `learning:*` flag ([docs/LEARNING.md](docs/LEARNING.md)).
- Every loop only proposes, and a person approves the exact text or diff it shows ([docs/LEARNING.md](docs/LEARNING.md)).

### Ship module (optional)

- Product feedback grouped into themes, and specs approved against a digest, behind the `ship:*` flags ([docs/SHIP.md](docs/SHIP.md)).
- A coding agent in a Cloudflare container with no credentials, a path policy on the exact files changed, and a pull request that a person merges ([docs/SHIP.md](docs/SHIP.md)).
- Pull requests from the target repository or from a fork, pushed only once you confirm that CI on the ship branch gets no secrets ([docs/SHIP.md](docs/SHIP.md#ci-and-the-ship-branch)).
- Deploy detection that counts a production deploy containing the merge commit, then "it is live" notes to the product users who asked, and a complete example Worker in `examples/ship/` ([docs/SHIP.md](docs/SHIP.md)).

### CLI and packaging

- The `gtm` command: `init`, `setup`, `migrate`, `brain validate|upload|diff`, `flags`, `doctor` and `deploy`, running your deployment's Wrangler with your login and asking before it writes to production ([packages/cli/README.md](packages/cli/README.md)).
- Packages built to JavaScript with types for npm, all at one version, with `gtm init` pinning a new deployment to it ([docs/RELEASING.md](docs/RELEASING.md)).
- A worker template that bundles from placeholders, and a complete, locked example brain for the fictional Acme ([docs/DEPLOYING.md](docs/DEPLOYING.md), [docs/BRAIN-SCHEMA.md](docs/BRAIN-SCHEMA.md)).
- Adapters for Telegram, Anthropic, Exa, Hunter, public job boards, Resend, Gmail, Cloudflare Email Routing, Google Calendar and Stripe, plus GitHub and Cloudflare Containers for the ship module, each with a hermetic contract test ([packages/adapters/README.md](packages/adapters/README.md)).
