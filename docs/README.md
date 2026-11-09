# Documentation

| Document | Read it when you want to |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Understand how a deployment works: the loop, the packages, the Cloudflare bindings, the event spine, the Durable Objects, scheduling, model roles and the safety controls |
| [INTERFACES.md](INTERFACES.md) | Write an adapter: the port interfaces, the adapter manifest, how adapter tools are classified and gated, and the contract tests |
| [SECURITY-MODEL.md](SECURITY-MODEL.md) | Classify a new tool, or judge what the system protects against: taint levels, tool classes and gates, the dispatcher, the fence, egress checks, delegation, approvals and the security contract |
| [OPERATOR.md](OPERATOR.md) | Connect a chat channel to your agent: the bot, the webhook, the allowlist, commands, approvals and sessions |
| [OUTREACH.md](OUTREACH.md) | Turn on cold outreach: templates and variables, the quality gate, the daily cold batch, readiness, manifests and release |
| [SENDING.md](SENDING.md) | Send email safely: the sending domain, the provider and webhooks, the footer and unsubscribe, windows, caps, the ramp and the bounce monitor |
| [SEQUENCES.md](SEQUENCES.md) | Turn on follow-ups: steps and timing, what stops a sequence, threading, release, the manual channel step |
| [INBOX.md](INBOX.md) | Connect a mailbox: Gmail or Cloudflare Email Routing, detection, structural classification and what each class does |
| [DASHBOARD.md](DASHBOARD.md) | Run the day from the dashboard: Cloudflare Access setup, the views and what each can do, and the security model |
| [LEARNING.md](LEARNING.md) | Let the system propose improvements: each learning loop, its guardrail and how you approve its proposals |
| [EXPERIMENTS.md](EXPERIMENTS.md) | Prove what works: allocation, assignment, experiment types, pre-registration, conclusion rules, the copy-change gate and the self-review |
| [SIGNALS.md](SIGNALS.md) | Give outreach a dated reason: each signal source, signal rules and carry, the intent score, openers and template variables |
| [AUTONOMY.md](AUTONOMY.md) | Decide how much the agent does on its own: levels, evidence, promotion and demotion, the writer registry and evals, automatic replies |
| [LIFECYCLE.md](LIFECYCLE.md) | Connect your product: the event bridge and SDK, lifecycle states, identity resolution, the deal mirror, billing through the port, MRR |
| [CONVERT.md](CONVERT.md) | Turn on meetings: connecting the calendar, privacy, how a booking is detected and attributed, what it does, prep briefs and post-meeting drafts |
| [BLUEPRINT.md](BLUEPRINT.md) | Read the whole design in one place: the full specification, including parts not built yet |
| [MEASUREMENT.md](MEASUREMENT.md) | Read the numbers: the one definition of each metric, matured samples, measurement health, the daily scorecard and the other reports |
| [REPLIES.md](REPLIES.md) | Handle replies: triage, routing, the meeting qualifier, drafting, approving and sending, reminders and mailbox mirroring |
| [SOURCING.md](SOURCING.md) | Turn on sourcing: discovery, enrichment and verification, the fit gate, promotion, flags, costs and adapters |
| [DATA-MODEL.md](DATA-MODEL.md) | Read or write the database: conventions, status enums, erasure, and every table by group |
| [EVENT-CONTRACT.md](EVENT-CONTRACT.md) | Connect your product (the host application) to a deployment: signed events in, reconciliation reads, attribution, erasure and the optional proof-of-value hook |
| [BRAIN-SCHEMA.md](BRAIN-SCHEMA.md) | Write the brain and templates for your company: file format, components, byte budgets, the lock file and validation |
| [DECISIONS.md](DECISIONS.md) | Know why a structural choice was made, and what it costs |
| [ROADMAP.md](ROADMAP.md) | See what exists today and what is coming, milestone by milestone |
