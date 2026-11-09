# Autonomous GTM Agent: System Blueprint

A complete specification of a multi-agent go-to-market and business development system: sourcing, enrichment, scoring, outreach, A/B testing, follow-up, reply handling, meeting conversion, customer lifecycle, self-improvement, and the operator dashboard. It is written so that a team can rebuild every capability for their own product and market.

This blueprint is derived from a production system that has run since early 2026, selling a B2B SaaS product to a niche professional buyer. Domain details have been generalized. Where a number appears, it is the default that worked in production; treat it as a starting point, not a law.

This page is for deployers, contributors and their coding agents who want the whole design in one place. It is the specification, so it also describes parts that are not built yet: [ROADMAP.md](ROADMAP.md) tracks what exists today, and the per-topic documents in [this folder](README.md) (sourcing, outreach, sending, sequences, inbox, replies and the rest) describe the built behavior in detail, with exact flags, jobs and defaults.

---

## Contents

1. [What the system does](#1-what-the-system-does)
2. [Non-negotiable design principles](#2-non-negotiable-design-principles)
3. [Architecture and stack](#3-architecture-and-stack)
4. [Agents and the runtime](#4-agents-and-the-runtime)
5. [Knowledge layer: identity, brain, memory](#5-knowledge-layer-identity-brain-memory)
6. [Data model](#6-data-model)
7. [Sourcing](#7-sourcing)
8. [Enrichment and verification](#8-enrichment-and-verification)
9. [Scoring and targeting](#9-scoring-and-targeting)
10. [Composing outreach](#10-composing-outreach)
11. [The outreach quality gate](#11-the-outreach-quality-gate)
12. [Sending and deliverability](#12-sending-and-deliverability)
13. [Sequences and follow-ups](#13-sequences-and-follow-ups)
14. [Experimentation and A/B testing](#14-experimentation-and-ab-testing)
15. [Reply handling](#15-reply-handling)
16. [Convert: meetings, booking, proof of value](#16-convert-meetings-booking-proof-of-value)
17. [Customer lifecycle, event spine, product bridge](#17-customer-lifecycle-event-spine-product-bridge)
18. [Goals, planning and coordination](#18-goals-planning-and-coordination)
19. [Earned autonomy](#19-earned-autonomy)
20. [Self-improvement loops](#20-self-improvement-loops)
21. [Product feedback to shipped code](#21-product-feedback-to-shipped-code)
22. [Security model](#22-security-model)
23. [Privacy and compliance](#23-privacy-and-compliance)
24. [Cost controls](#24-cost-controls)
25. [Measurement and reporting](#25-measurement-and-reporting)
26. [Operator interfaces](#26-operator-interfaces)
27. [Scheduling](#27-scheduling)
28. [Reliability](#28-reliability)
29. [Testing, evals and CI](#29-testing-evals-and-ci)
30. [Configuration reference](#30-configuration-reference)
31. [Build order](#31-build-order)
32. [Lessons learned](#32-lessons-learned)
33. [Adapting to your domain](#33-adapting-to-your-domain)

---

## 1. What the system does

The system runs the whole revenue loop for one product with one human operator. It finds the right accounts and people, finds a reason to write to them, writes and sends plain-text email, learns which copy works, answers replies, books meetings, follows customers through signup and payment, and turns product feedback into pull requests. Every consequential step is gated, measured, and either earned-autonomous or human-approved.

```
research -> identify -> source -> enrich -> score -> outreach -> follow-up -> reply -> convert -> lifecycle
                                              |           |           |
                                              +---- quality gate -----+
            product feedback -> themes -> spec -> sandbox build -> PR (human merge) -> "it is live" note
                         experiments, ledger, holdout -> learnings (human approved) -> next batch
```

### Capability map

| Area | What it covers |
|---|---|
| Sourcing | Semantic web search, structured "deep" company search, list-building agents, monitors, public filings, funding feeds, hiring boards, social posts, lookalikes of responders, coverage fill at high-fit accounts, quarterly re-sourcing, job-change sourcing |
| Enrichment | Email waterfall across providers, address pattern inference, verification with cached semantics, catch-all proof from delivery history, firmographic facts, per-field evidence with conflict holds, job-change checks, domain resolution |
| Scoring | Free prescore, model fit score against a rubric, person fit from titles, intent score (fit, title, signal, angle), engagement score, account coverage, seniority ranking |
| Outreach | Template library with variables, segment and persona routing, signal angles with fixed openers, quality gate, approval manifests, send pacing, warm-up ramp, kill switch, deferred replay, time-zone send windows |
| Follow-up | Threaded multi-step sequences, manual steps on LinkedIn or X, writing to a colleague after silence (multithreading), signal-triggered re-engagement, referral asks, renewal and lifecycle follow-ups |
| A/B testing | Per-send ledger with first-touch attribution, Thompson sampling with a protected control, account-clustered assignment, segment cells with pooling, pre-registered experiments, holdout lift, subject and send-time tests, approval-gated promotion |
| Replies | Push plus polling detection, structural and model triage, intent routing, meeting qualifier, fact-grounded drafting, narrow auto-send rules, freshness checks, escalating reply-owed reminders, drafts mirrored into the mailbox |
| Convert | Calendar sync with privacy-limited fields, booking attribution, prep briefs, reminders, no-show recovery, post-demo sequence, proof-of-value reports, deal handoff |
| Lifecycle | Signed event bridge from the product, contact lifecycle state machine, deal mirroring, billing webhooks, MRR snapshots, erasure with tombstones |
| Self-improvement | Daily retrospective (one change), daily quality review, fitness trend, weekly benchmark, constrained instruction evolution, edit mining into rules, voice profile, objection library, win/loss weights, learnings proposals, link triage |
| Ship loop | Feedback themes, specs, sandboxed coding agent, path policy, PR creation, deploy detection, "you asked, it is live" notes |
| Operator | Chat command surface with one-tap buttons (Telegram is the included adapter), admin dashboard over WebSocket, daily scorecard, weekly digests, approvals everywhere |

---

## 2. Non-negotiable design principles

These held the system together. Build them in from day one; retrofitting them is expensive.

1. **Untrusted text never becomes instructions.** Web pages, inbound email, provider responses and model output from those sources are data. They go in the user turn, fenced, never in a system prompt, never into copy that sends without a person, never into an identity file. A taint model enforces this mechanically (section 22).
2. **Skip rather than guess.** Empty beats fabricated. A missing first name means a held draft, not "Hi there". An unverifiable email is not sent. A model that cannot be reached holds the message.
3. **Fail closed on gates, fail open on bookkeeping.** A gate whose input cannot be read blocks (halt flag, suppression, verification, reviewer). Memory writes, audit logs and counters are fire-and-forget and never block a send.
4. **An approval covers exactly what was shown.** Approvals bind to a content digest. Editing an approved draft sends it back to review.
5. **Autonomy is earned per action class, from evidence.** Every class starts at "draft and ask". Promotion is proposed from measured outcomes and applied by the operator. Some classes are permanently human.
6. **One definition of every metric.** "Positive reply" means the same thing in every report, experiment and promotion check.
7. **Measure lift, not activity.** A per-send ledger, a protected control arm and a no-send holdout make it possible to know whether anything worked.
8. **Every risky behavior ships behind a flag that defaults off.** Deploy the code, verify it, then flip the flag. Rollback is a flag delete.
9. **Bounded and reversible.** Spend caps before every paid call, idempotent writes, soft status changes instead of deletes, one self-modification per cycle.
10. **The database is the truth; the agent is a reasoning layer on top.** Agents query state; they do not remember it.
11. **Plain text email, work addresses only.** Plain text reads as one person writing; it also means opens are not tracked, so replies are the metric.
12. **No em or en dashes.** A small house rule, enforced by a block-level check on generated copy and by a repository check on templates, code and docs. Pick your own house rules and enforce them in code, not prompts.

---

## 3. Architecture and stack

### Stack

| Concern | Default choice | Portable alternatives |
|---|---|---|
| Runtime | Cloudflare Workers (Hono router), TypeScript strict | Node on any serverless or VPS, Deno, Bun |
| Relational store | Cloudflare D1 (SQLite) | Postgres, SQLite, Turso |
| Key-value | Cloudflare KV (flags, caches, counters, dedup) | Redis, Upstash |
| Blob store | Cloudflare R2 (identity docs, payloads, briefs, archives) | S3, GCS |
| Vector store | Cloudflare Vectorize, 1536-dim embeddings | pgvector, Pinecone, Qdrant |
| Real-time | Durable Object with hibernating WebSockets | any WebSocket server |
| Queues | Cloudflare Queues (event spine, long chat turns) | SQS, BullMQ |
| Durable workflows | Cloudflare Workflows (ship builds) | Temporal, Inngest |
| Per-contact timers | Durable Object per contact with alarms | a scheduled-jobs table |
| Code sandbox | Dynamic Worker isolates with no network; container for the coding agent | Firecracker, E2B, Docker |
| UI | Lit web components + Vite, served as static assets | any SPA |
| LLMs | Anthropic Claude (top tier for hub and workers, mid tier for reviewers and drafts, small tier for triage), a separate code model | any provider with tools and structured output |
| Model gateway | Optional AI gateway for logging, BYOK and payload-logging opt-out | LiteLLM, Portkey |
| Search | Exa (semantic, deep structured, websets, monitors, agent), Firecrawl or a headless browser | Tavily, SerpAPI, Brave |
| Enrichment | Hunter (finder, domain, verifier, company), FullEnrich, Apollo, a company-profile API | PDL, Clearbit, ZeroBounce |
| Cold email | Resend from an isolated subdomain | Postmark, SES, Mailgun |
| Warm email | A Google Workspace mailbox through the Gmail API (OAuth); Cloudflare Email Routing for receive-only intake | Microsoft Graph |
| Calendar | Google Calendar, read-only scope | Microsoft Graph |
| Billing | Stripe webhooks and checkout | any |
| Operator channel | Telegram bot (webhook) | Slack, Discord |

### Shape

```
                 Admin dashboard (WebSocket RPC)        Operator chat (webhook -> queue)
                              \                          /
                               +---- Gateway / router --+
                                         |
                              Strategist (hub agent)
                       delegates to: Executor | Ops | Sender | Coder
                                         |
                  Tool layer (~160 tools, grouped, taint-classified)
                                         |
      Relational DB    KV flags/caches    Blob store    Vector memory    Queues/Workflows
                                         |
  Scheduled jobs (one per-minute cron trigger dispatches due jobs from the job registry;
                  ~150 jobs, each wrapped in a fault-tolerant runner)
                                         |
  Webhooks in: mail push, ESP events, product events, billing, git host, deploy host, search monitors
```

The autonomous loop does not depend on the agents. Most scheduled jobs are deterministic code with narrow, schema-bound model calls. The agents are for operator conversation, research and ad-hoc work. This split keeps cost low and behavior testable.

---

## 4. Agents and the runtime

### 4.1 Roles

| Agent | Purpose | Tools | Notes |
|---|---|---|---|
| Strategist (hub) | The only agent the operator talks to. Plans, delegates, reviews, answers | core tools + delegation tools | Never executes outreach itself |
| Executor | Research and drafting | web, search, enrichment lookups, mail read, drafts, memory, signals (~45 tools) | |
| Ops | CRM, pipeline, campaigns, experiments, inbound, analytics (~54 tools) | full contact and deal CRUD | |
| Sender | Campaign readiness, lint, launch, approvals, sends (~12 tools) | deliberately has no taint-source tools | So it can act without being tainted |
| Coder | Code reading and changes on a separate code model (~12 tools) | git host read/write, sandboxed execution | Never sees raw user text, only approved plans |

Workers never receive delegation tools, which prevents recursion. A `re_delegate` tool lets the hub retry a worker with corrections.

Keep all model ids in one place (`gtm.config.ts`, mapped by role: `strategist`, `worker`, `writer`, `judge`, `triage`, `classifier`, `coder`, `embedding`) and route every call through the model gateway port, which asks for a role, never a model id. Changing models is then a one-line change.

### 4.2 Delegation mechanics

- A delegation is a real model call with its own system prompt, a curated tool subset, a round limit (8 to 10), and a budget gate checked first.
- **Taint inheritance:** a worker starts at the parent's taint level and returns `max(parent, child)` through an escalate-only marker. Without this, a tainted hub can launder actions through a clean worker (confused deputy).
- Outcome is classified (`accepted | needs_revision | partial | failed`).
- The last few completed delegations from other agents (last 4 hours) are passed as cross-agent context.
- Each delegation records a task row and a capped progress trail.

### 4.3 Chat loop

- Two entry points: streaming (dashboard) and non-streaming (the chat bot).
- Limits: a configurable round limit (8 model rounds by default), 120 s model timeout, 60 s tool timeout, history of 150 messages for 30 days; old tool results are compressed after round 8.
- Reasoning effort is pinned high and raised for long or strategic messages behind a flag.
- **Session taint persists across turns** until the operator clears the session (`/clean`), which drops history and taint together.
- **Per-turn spend ceiling** (default 50 cents) counts delegated child runs. At the ceiling the loop stops calling tools and makes one short closing call so the operator still gets an answer.
- Long turns run on a queue consumer (15 minute budget) rather than inside the webhook (30 s budget). Button taps are handled at once, and operator commands never reach the model.

### 4.4 Durable runs and checkpoints

- Behind a flag, each delegated round writes a journal to blob storage with a phase (`executing_tools` before a batch, `awaiting_model` after).
- A sweep every 10 minutes resumes runs whose journal is stale for 30 minutes (max 2 resumes, max age 24 h).
- Tool calls whose outcome was not journaled get an "interrupted, effect unknown" result instead of being re-run. Never re-run a side effect blindly.
- Journal writes are conditional on the etag read, and a resume claims ownership before its first model call. Taint can only rise on resume; spend carries over.
- A run status endpoint shows state, elapsed time, spend and the progress trail.

### 4.5 Tools

About 160 tool definitions, grouped:

| Group | Examples |
|---|---|
| Web | scrape, search, map, extract, multi-step research |
| Semantic search | search, find similar, get contents, deep structured search, deep research, monitors (create, list, delete, trigger) |
| Enrichment | domain search, email finder, verifier, company-profile lookup, deep person research |
| Mail | send, list, read, mirror reply drafts |
| ESP | send, batch send, check domain |
| Unified send | one send tool that routes by configured provider |
| Docs and sheets | list, search, read, create doc, create folder, update doc, create, read, write sheet |
| Contacts | search, get, stats, next batch, find dormant, update, log outreach, create, bulk create |
| Deals | create, update, transition (validated), list and forecast |
| Drafts and templates | create, list, update, bulk approve, save template, list templates |
| Campaigns and experiments | create, manage, list, postmortem, launch; experiments create, manage, list |
| Subject tests | create, allocate, record sent, record outcome, get, list, dashboard, conclude |
| Funnel | record event, counts, conversion rate, summary, per contact |
| Smart drafting | objection response, bulk smart drafts, smart follow-up, briefing |
| Outreach ops | readiness check, deferred list/replay/cancel, pause, resume, status, monitor hits, referrals, campaign suggester, reports, account send status, send rate, lint |
| Inbound | list, get, structured extract, update, triage |
| Suppression and verification | add, check, list; verify address, check cache, backfill |
| GTM | meeting ingest, engagement score and event, hot contacts, record signal, graph neighbors, intro path, objection find, playbook get, account coverage, deal handoff, deal outcome |
| Memory and tasks | store, persist, recall; task create, update, list, get |
| Code | git read/search/branch/write/PR/trigger workflow; sandbox execute; store result |
| Code mode | `api_search` (typed API docs), `api_execute` (script against a typed proxy) |
| Billing | create checkout, get customer, list subscriptions |
| Health | system health check |

**Adding a tool:** implement it; add a schema; add a dispatch case that rate-limits first, executes, then sanitizes output; add it to a tool group; classify it in a taint-source set or the untainted set (unclassified tools are treated as full taint); add it to the right agents' subsets.

**Tool selection:** about 22 groups. `core` (contacts, memory, tasks, delegation) and `codemode` are always sent; the rest are selected by keyword. No match sends everything (fail open on capability, never on safety).

**Code mode:** instead of sending dozens of CRM tool schemas, give the model two tools and a typed API. It writes a short script against `api.contacts.*`, `api.pipeline.*`, `api.outreach.*`. Each proxy method checks the action gate and rate limit, records its tool name for taint, and sanitizes output. This cut tool-context tokens by about 40%.

**Sandbox execution:** model-written code runs in a fresh isolate with no network, receiving only an injected JSON context. 50 KB code limit, 30 s default timeout (60 s max), 10 per hour, code hashed and archived before execution, always blocked when the conversation is tainted.

**Other runtime pieces:**
- **Structured output** helper with JSON schemas for rerank, decisions, triage, gate verdicts, meeting extraction, feedback triage and specs. Always re-validate the parsed result.
- **Citations:** URL-fetching tool results are wrapped as search-result blocks with citations enabled.
- **Nudges:** every 5 tool rounds a short reflection line is prepended to a tool result (round 5: store durable learnings; 10: check drift; 15+: verify the deliverable). Zero extra calls.
- **Cheap classifier tier:** small hosted classifiers for yes/no and typed extraction (the `classifier` role, in the optional `classifier-tier` module), rolled out per call site with the `classifier_tier:<call_site>` flag as `off | shadow | on`. Switch on only after 90% agreement over 200 shadowed decisions.
- **Identity-document mutation constraints:** size, growth, dedup (embedding cosine), required headers, snapshot and rollback. They fail closed.

---

## 5. Knowledge layer: identity, brain, memory

### 5.1 Identity documents (blob store)

Operator-owned documents loaded into prompts, progressively, by relevance:

| Document | Purpose |
|---|---|
| SOUL | Identity, security directives, top-level objective, product knowledge |
| AGENTS | Agent roles, delegation rules, escalation triggers |
| PRODUCT | Full product knowledge, loaded only when relevant |
| PRINCIPLES | Operating philosophy |
| SKILL | Skill routing matrix and skill chains |
| HEARTBEAT | Schedule and health checklist |
| MEMORY | Rolling operational state, pruned daily |
| LEARNINGS | Proven insights, objection handling, template performance, general learnings. Written only through approved proposals |
| OUTREACH-PLAYBOOK | Frameworks, subject formulas, sequence rules, personalization ladder, segment messaging, deliverability checklist |
| TARGETING | The targeting brief (below) |
| REPLY-FACTS | The only facts a reply may state |
| VOICE | Voice profile built from the operator's own sent mail |
| WIKI-SCHEMA | Structure for a compounding knowledge wiki (accounts, contacts, objections, theses, competitors, topics) |

**Targeting brief.** Sections: Who, Why now, Must-have, Never, Triggers to hunt, Triggers to ignore, What I could not determine. The Never section is machine-read (in this kit, the `never` items of the brain's `icp` component, with `domains`, `accounts` and `titles` lists; see [BRAIN-SCHEMA.md](BRAIN-SCHEMA.md)) and is a hard stop in selection; if the brief cannot be read, the sweep fails rather than ignoring it. The system may propose changes in its weekly report; it never edits the file.

### 5.2 The GTM brain

Short, typed lists that prompts read instead of whole documents. One file per component; each item one or two sentences.

| Component | Read by tasks |
|---|---|
| market profile | strategist |
| personas | outreach, strategist |
| ICP | sourcing, fit, strategist |
| message pillars | outreach, judge, strategist |
| objections | replies |
| competitors | replies, strategist |
| influencers | account work |
| keyword portfolio | sourcing |
| voice | outreach, replies, judge |
| signals | sourcing |
| stack | replies |
| hiring | sourcing |
| facts | outreach, replies, judge, close |
| commercial (prices, offers) | strategist, close only, never a prospect-facing writer |

Rules:
- A file is served only if its frontmatter says `status: approved` **and** its hash matches a lock file written by an upload script. A draft is never read; prompts fall back to prior behavior. No lock serves nothing.
- Each task gets a fixed slice under a byte budget (fit 2 KB, sourcing and judge 4 KB, outreach and strategist 6 KB, replies 8 KB). A component cut for size is named as missing, with an instruction not to fill it in from memory.
- The brain version (hash prefix) is in the prompt, so outputs are traceable to a version.
- A weekly job proposes brain diffs from numbers and enum names only. Nothing writes the brain itself.
- No web text, no inbound text, no customer names.

### 5.3 Memory

| Layer | Store | Lifetime |
|---|---|---|
| Tool result cache | KV | 5 min to 7 days by source |
| Operational state | MEMORY document | rolling, pruned daily |
| Long-term memory | vector index + full-text index | decays by type |
| Consolidated insights | vector index | durable |
| Active tasks | relational table | until archived |
| Searchable history | full-text index over audit log and chat | retention window |

**Hybrid recall:** vector and full-text searches run in parallel, each over-fetching 3x; merged with reciprocal rank fusion (k = 60); score = `rrf * (0.7 + 0.3 * importance) * max(0.1, exp(-0.693 * age / halfLife))`; optional small-model rerank of the top 2K with a 5 s timeout, falling back to RRF order.

Half-lives (days): conversation summary 30, template performance 45, prospect insight 90, objection response 120, deal outcome 180, competitive intel 180, strategy learning 365.

**Maintenance:** consolidate 3 to 15 unconsolidated memories into one insight; meta-consolidate 8+ strategy memories; prune consolidated memories older than 90 days with importance under 0.3. Require several supporting data points before storing a "what works" memory at high importance, or the system learns from noise.

**Active tasks:** title, steps, current step, status, priority, context JSON (under 5 KB), parent task, deadline. The top 3 are injected into prompts; completed tasks archive after 7 days with a summary stored as memory.

---

## 6. Data model

About 105 tables. Group them like this:

| Group | Tables |
|---|---|
| CRM | contacts, contact tags, contact lifecycle, contact scores, contact engagement, contact angles, contact evidence, contact fit, accounts, account contacts, account context, graph entities, graph edges |
| Pipeline | deals, deal stage history, deal handoffs, deal outcomes, meetings, calendar meetings, proof-of-value requests, subscriptions, billing customers, MRR snapshots, referrals, ref tokens |
| Outreach | campaigns, campaign contacts, drafts, templates, copy lines, outreach log, outreach sends (ledger), sequence runs, holdout, deferred sends, send slot schedules, follow-ups, follow-up touches, manual touches, sent-dedup log, suppression list, email verifications, domain delivery, seed placements, quality checks, reply assets, reply qualifications, objections, persona playbooks |
| Experiments | experiments, experiment assignments, experiment proposals, subject tests, subject variants, subject assignments, knob proposals, qualification weights |
| Discovery | candidates, queries, ICP, webset items, account fit, account facts, account hiring roles, account job boards, board checks, domain resolutions, re-source claims, title fit reviews, signal events |
| Events | inbound emails, events, event effects, funnel events, engagement events, lifecycle transitions, erasure tombstones |
| Agent ops | audit log, cost events, execution runs, provider runs, delegation tasks, active tasks, benchmark runs, fitness scores, evolution runs, autonomy events, learnings proposals, MCP servers, memory FTS, plans, goals |
| Ship | feedback items, themes, ship tasks, link-triage items |

Tables that only make sense for one market (a market-specific knowledge wiki, records only one kind of buyer has) belong in a domain pack under `examples/packs/`, with their own migrations, not in core ([DATA-MODEL.md](DATA-MODEL.md)).

**Conventions:**
- **Account key** = lower-cased registrable domain, without `www.`. Everything account-level joins on it. A shared-host or personal domain is never an account.
- **Contact warmth:** `cold -> contacted -> warming -> engaged -> hot -> customer`, plus `churned` and `opted_out` (sticky). Warmth only moves forward, using compare-and-set writes.
- **Deal stages:** `prospecting -> contacted -> engaged -> demo_scheduled -> trial -> proposal -> negotiation -> closed_won | closed_lost`, with an allowed-transitions table.
- **Candidate statuses:** `raw -> enriched -> qualified | borderline | rejected -> promoted | duplicate`.
- **Draft statuses:** `draft -> pending_approval -> approved -> sent | rejected`.
- **The effects ledger** (`event_effects(event_id, effect)` with a unique key) is the universal "do this exactly once" primitive. `claimEffect` returns true once; `releaseEffect` undoes a claim when the work failed. Used for picks, sends, reminders, alerts, credits, and mirrors.

---

## 7. Sourcing

### 7.1 Main discovery cycle (weekdays)

1. **ICP generation** (if none unexpired): a mid-tier model, no tools, system prompt = fixed strategy text + the targeting brief; user turn = a conversion report from the DB with query texts quarantined. Output: an ICP summary and 10 micro-vertical queries, expiring in 7 days. Queries already "killed by conversion" are not recreated. The structured-search scoring prompt is fixed text plus the brief, never model output.
2. **Standard semantic search** (5 calls/day budget): results dedup on result id; the domain is taken from the URL only if it is an account domain; otherwise the row is stored as rejected to keep the dedup.
3. **Deep structured search** (3 calls/day, 50 results each) with a **hardcoded output schema** (company name, website, description, fit score, fit reasoning, key person name and title). Never let a model choose the schema it fills.
4. **Backlog gate:** more than 300 raw candidates skips new search spend; the backlog still drains.
5. **Enrich** (40 per cycle default, max 50, concurrency 5): fit gate first, then the email waterfall or a domain search that picks the most senior relevant title.
6. **Qualify** (20 per cycle, max 100): score =
   - structured fit score / 10 * 0.35 (only with 20+ characters of reasoning)
   - email +0.30, full name +0.15, account name +0.10, relevant title +0.20
   - focus keywords +0.05 each, capped at 0.25
   - buying-signal timing up to 0.50
   - win/loss and lookalike uplifts, each `0.15 * tanh(raw / 3)`, capped at +/-0.15
   - clamp [0, 1]; >= 0.5 qualified, < 0.3 rejected, otherwise borderline (terminal).
   - The built cycle scores a subset of these terms until signals and win/loss weights exist; [SOURCING.md](SOURCING.md#3-qualify) lists them.
7. **Buying signals** at qualify (only when base score >= 0.25, daily call ceiling): two searches over 90 days returning title and URL only. Hiring (0.15), fundraise (0.25), leadership change (0.15), acquisition (0.10), matched by regex on titles that **name the account**. Generic words alone never count.
8. **Email recovery** for qualified rows with no email: re-run untried waterfall steps, at most 3 passes.
9. **Promote** (top 50 with an email), checks in order: duplicate email, identity verdict, suppression, known person (same profile slug, or same full name at the same account), fit gate, verification, erasure tombstone. Then insert the contact (warmth cold, confidence by verification grade, source recorded), attach pending signals, create a prospecting deal, write a static research brief.
10. **Query refinement:** deactivate a query after 20+ promotions with under 5% conversion and 30+ days age. Never revive it.

### 7.2 Additional sources (each behind its own flag, each writing candidates that still go through promotion)

| Source | How it works | Key rules |
|---|---|---|
| List-building agent segments | Weekly start, weekday polling; fixed segments with fixed effort | Refuse unbounded efforts and any phone field; every row must carry name, account, title, domain, email and an https source URL ("sourced or blank"); email must be at the account domain |
| Websets | Weekly person searches with natural-language criteria plus enrichments | Inserted qualified with a fixed score; promotion still runs every check |
| Search monitors | Webhook writes hits to KV; a processor drains up to 500 per run | Dedup on result id or URL |
| Funding feed | Recent rounds from a funding API over 7 days | Signal needs an announced date; severity scales with rounds and size; thin accounts go to people sourcing |
| Public filings | Weekly filings search for a relevant filing type | Strict name filters; resolve names to domains; severity 0.65, 30-day expiry |
| Hiring boards | Public Greenhouse, Lever and Ashby JSON for high-fit accounts | Keep only role-kind counts (enums), never titles; signal once per 90 days per account |
| Hiring and leadership news | Fixed searches over 30 days | Hit needs a published date and must belong to a known account; title must match with the account's own name removed |
| Social posts | Fixed queries via a social search API | Post must be among the API's citations, under 14 days, author matched by exact name plus a distinctive account word in bio; never gives an opener |
| Account profiles | Structured profile API for high-fit accounts | Keep only numbers and enums (size bands, stages, locations, related companies by domain); recent dated events become signals |
| Responder lookalikes | find-similar seeded from accounts that replied positively, held meetings or pay | Exclude labelled accounts, known contacts, recent candidates and low-fit accounts; 30 inserts per run |
| Coverage fill | People search at fit >= 7 accounts with fewer than 2 relevant seats and a recent signal, reply or signup | 5 accounts per run, 2 people per account, 30-day cooldown per account |
| Quarterly re-source | Re-search high-fit accounts imported long ago | Claim the account first; detect new people by full-name mismatch |
| Job changes | See section 8.5 | A move to a high-fit account becomes a candidate plus a signal |

**People source** is a pluggable provider (search then paid match), with a fallback chain. Callers keep only name, title and a work email at the account domain.

### 7.3 Signals

Every signal row carries: source type, category, severity (0 to 1), a source URL, an event date, evidence text (stored as data only), an expiry, and either a contact or an account.

- No date or no URL means no signal.
- Most sourced signals sit at 0.6 to 0.65, below the 0.70 auto-draft line, so they move scores and pick an opener but never draft on their own.
- **Signal carry:** a signal found before the account had contacts is held at account level (72 h) and copied to up to 2 newly promoted contacts (cold, never contacted, no signal in 90 days, verification above floor).
- Some sources are never carried: job changes, multithread markers, and anything derived from product usage (privacy).
- Signals go to at most 2 never-contacted, keep-listed contacts per account; otherwise to the account; otherwise nowhere.

### 7.4 Source attribution

Every contact records the source that found it. Non-search sources get an inactive query row so they earn conversion credit. A weekly per-source split reports contacts, added, touched and positive.

---

## 8. Enrichment and verification

### 8.1 Email waterfall

| Step | Provider | Rule |
|---|---|---|
| 1 | Finder | Keep only an address at the candidate's domain; a provider error stops all later steps from that provider |
| 2 | Domain search | Use the person if listed by exact normalized name; cache the domain pattern (180 days, or "none" for 30) |
| 3 | Pattern + verify | Build from the cached pattern and verify |
| 4 | Pattern guess | `{first}.{last}`, `{first}`, `{f}.{last}`, each verified; accept only deliverable, not accept-all, at least medium |
| 5 | Second provider | Only for accounts with fit >= 7 |

- Steps are recorded as tried or pending; tried steps never repeat.
- **Budget reservation:** reserve `min(cap - used, people * worst_case_cost)` before any spend, return unused cents in a `finally`. Concurrent workers take reservations synchronously, so they cannot overspend.

### 8.2 Verification semantics

- Results cached 90 days; `unknown` and `block` results expire in 7 days.
- Confidence: reject flags (disposable, gibberish, block, webmail, undeliverable) give none; accept-all gives low, or medium if the domain is **catch-all proven**; deliverable with SMTP check gives high (score >= 90) or medium (70 to 89).
- **Catch-all proof:** the domain has 5+ delivered sends, 1+ reply and 0 hard bounces after a 72 h settle.
- **Cold floor** is configurable (default medium).
- An undeliverable or disposable result is suppressed automatically.
- Inconclusive at promotion: wait if cached, retry up to 3 times if fresh, then reject.
- Re-verify at selection when older than 30 days, within a daily allowance.
- **Send-time policies:** `reply` blocks only a cached undeliverable; `no_known_risk` also blocks cached risky results; `cold` requires a fresh entry at the floor and holds on a miss.
- A nightly backfill verifies the pool in priority order (engaged first, then by fit).

### 8.3 Firmographic facts

A company lookup per account keeps only: headcount band and count, HQ country code, founded year, sector, industry enum, company type, funding-stage enum, amount raised, up to 20 tech slugs. **All prose is dropped at parse.** Refresh after 180 days (found), 90 days (not found), 1 day (failure, max 3).

### 8.4 Per-field evidence and conflict holds

Record each field (email, title, employer domain) with provider, source URL, verified time, confidence and a retention date (365 days).
- A conflict is a different provider giving a different employer domain, or a different seniority band. The same provider repeating itself is an update.
- A conflicted contact is held out of cold selection until the operator resolves it.
- Evidence for rejected candidates is purged after 90 days.

### 8.5 Job-change checks

For never-touched cold contacts whose data is over a year old: search by exact name with current employer = the account (current), then past employer = the account (moved, with the new domain if exactly one is readable). Several namesakes pointing different ways is unknown. Moved contacts are excluded from cold selection; optionally, stale unchecked contacts are held too. A move to a high-fit account creates a candidate and a leadership signal.

### 8.6 Identity and dedup

- **Non-account domains:** personal mail domains match exactly; shared hosts (social networks, blogging platforms, data aggregators, news wires, code hosts) also match subdomains. Such a domain is never an account, never collected, never promoted. **Work email only.**
- **Account name key:** Unicode-normalize, `&` to "and", join dotted initials, drop legal suffixes; reject single tokens under 4 characters unless the domain label equals them.
- **First name:** handle "Last, First" and honorifics; return null rather than guess.
- **Address screen:** malformed, non-account, role address (info, sales, hello, partners, etc.), or clean.
- **Readiness** = the minimum confidence across fields, never a sum.
- **Name to domain resolution:** free sources first (accounts table, fit table, most common contact domain), then one paid search only for names with 2+ words and a distinctive word; a label must match the joined words, distinctive words plus an optional suffix, or initials. Cache hits 180 days, misses retried after 30.
- **Exclusion list** sent to search providers (up to 1,000): never-list, low-fit accounts, known accounts, contact domains.

---

## 9. Scoring and targeting

Who gets emailed is decided by four filters, in order: account fit, person fit, intent, then seniority.

### 9.1 Account prescore (free, nightly, 0 to 100)

Aggregated from contacts at the account: team size proxy from contact count (your ICP's sweet spot scores highest), seniority present, focus match, stage match, stated budget or size, core-market location. Rewrite the inputs for your ICP; keep the "free, from data you already have" property.

### 9.2 Account fit score (model, every 15 minutes, flag-gated)

- Top N accounts by prescore (default 1,000), M per run (default 20), concurrency 4, lock and budget gate.
- Input: structured firmographic facts when usable, else a page summary of the account's site; contact fields quarantined; your own counts outside the quarantine.
- Mid-tier model, **no tools**, schema-constrained, system prompt = a fixed 1 to 10 rubric plus the approved ICP brain component.
- Output: score, segment enum, team size, confidence, up to 3 reasons, disqualifier. Any disqualifier caps the score at 4.
- Below 5 is never cold-emailed and joins the search exclusion list. Scores refresh after 180 days. Unreachable sites retry, then keep their prescore.

### 9.3 Person fit (titles)

1. Never list from the brief (domain, account substring, title substring): drop.
2. Rules: hard drops (functions you never sell to); a drop function plus a keep word is maybe; a keep title with a job tail ("Director, Finance") is maybe; the keep regex matches buyer roles.
3. A small model reviews the most common undecided titles nightly, batches of 50, as keep or drop; uncertain means drop. Each title is paid for once.
4. **A maybe is a no until proven.** Only keep is drafted.

### 9.4 One title classifier

One function returns seniority rank, seat (decision maker, influencer, user, other), routing persona and the person-fit decision, so they never disagree. Generate the SQL and code versions from one table.

### 9.5 Intent score (nightly; shadow until enforced)

| Component | Points |
|---|---|
| ICP fit | up to 30 (`fit * 3`, else `min(18, prescore * 0.18)`) |
| Title | up to 20 by rank |
| Signal | `35 * severity * freshness` (freshness 1 at <= 14 days, 0.6 at <= 45, 0.3 at <= 90) |
| Angle | high 15, medium 10, none 3 |

Bands: 80+ first touch; 65 to 79 soft touch; 45 to 64 nurture; below, no contact.

### 9.6 Angles

Each signal source maps to an angle (funding, hiring, new leader, launch, news, job change). High confidence at <= 14 days, medium at <= 45, none after. **Openers are fixed operator-written text with only the account name substituted.** No third-party text ever reaches an email.

### 9.7 Engagement, coverage and accounts

- **Engagement score:** weighted events (reply 0.20, meeting 0.25, referral 0.30, no-show -0.20, ghosted -0.25), 30-day half-life over the last 100 events, logistic squash; trend from the last 14 days vs the prior 14.
- **Account coverage:** seat weights (top decision maker 0.35, decision maker 0.25, senior influencer 0.20, adjacent 0.15, junior 0.05) plus 0.05 per engaged contact, capped at 1. Gap queue at coverage under 0.75. Account tier from fit (9 to 10 tier 1, 7 to 8 tier 2).
- **Target-accounts page:** weekly, the top 50 accounts by intent with seats covered, last touch and the opener the system would use. Deterministic SQL.
- **Account context:** for the top 20 accounts, a context file with external text marked and command-shaped tokens cut.
- **Ranking order** for selection: scored accounts by fit, then prescore, then title rank, then confidence.

---

## 10. Composing outreach

### 10.1 Templates

- Types: cold intro, follow-up, breakup, check-in, proposal, and lifecycle kinds.
- Each has an `angle`, an operator `volume_weight`, and optional targeting arrays: segments, team sizes, personas.
- Selection: up to 8 general plus up to 8 targeted active templates. Zero templates aborts the batch with an operator notice.
- **Cold copy is assembled by substitution, not generated.** No model writes a cold first touch. Models review it (section 11).

### 10.2 Variables

`{{first_name}}`, `{{last_name}}`, `{{account_name}}` (an unknown or unusable name holds the draft; it never falls back to "your company"), `{{title}}`, `{{attributes.<key>}}` (a market-specific field from the contact's or account's `attributes`, such as a focus area; providers write attributes, so each draft is reviewed by a person), `{{angle_opener}}`, `{{angle_age}}`, `{{persona_hint}}`, `{{proven_insight}}` (from approved learnings), `{{original_subject}}`, `{{booking_url}}`, `{{sender_name}}`, line placeholders `{{segment_line}}`, `{{team_size_line}}`, `{{persona_line}}` (an empty line placeholder drops the whole line), and `{{company_context}}` (up to 300 characters of fetched site text, fetched only when a template uses it; marks the draft for per-draft review).

**Copy lines** are operator-written snippets keyed by segment, team size or persona. **Persona playbooks** hold tone, opener, value frame and CTA per persona.

Optional attribution tokens (`?ref=<token>`) on product links let the product credit a signup to a contact.

### 10.3 Model-written drafts (non-cold)

Smart follow-ups, objection answers, reply drafts, signal drafts, referral asks and renewal notes are model-written from approved inputs only (contact fields, recent outbound, approved facts, approved assets, approved objection answers, voice profile). They go through the same quality gate and, by default, to approval.

---

## 11. The outreach quality gate

Every message that may leave without a person reading it passes the gate: cold intros, sequence steps, lifecycle follow-ups, replies, post-meeting notes and "it is live" notes.

### 11.1 Deterministic checks (pure, no network)

A **block** means the draft is never created or sent. A **hold** means a person decides.

| Code | Severity | Rule |
|---|---|---|
| Linter errors | block | Hidden characters, empty subject or body, URL shorteners, placeholder leaks (`{{ }}`, `{ }`, `[INSERT]`, `[Your ...]`, ERB, Jinja, template literals, `%s`, TODO/TBD/lorem) |
| Linter warnings | hold | Spam phrases, AI-slop phrases, subject mostly caps or over-punctuated, too many exclamations, body over 200 words |
| House-rule character | block | e.g. em or en dash |
| Recipient mismatch | block | Address is not the contact the copy was written for |
| Unusable account name | block | Copy names an account the identity checks rejected |
| Greeting not personal | hold | First line lacks the first name (not for replies) |
| Account fallback used | hold | "your company" or similar although the name is known |
| Link not allowed | hold | Any link except your domain, your app host or the exact booking URL |
| Unapproved claim | hold | A figure or claim not present in the template, copy lines, contact fields or an allowed-claims list |
| Length bounds | hold | Cold 30 to 180 words, sequence 12 to 120, lifecycle 12 to 160, reply 8 to 160 |
| Subject too long | hold | Over 90 characters |
| No question | hold | A cold intro that asks nothing |
| Exclamations | hold | More than one |

Normalize Unicode (NFKC) before checking.

### 11.2 Model reviewer

- Mid-tier model, structured output, budget-gated. Scores relevance, clarity, tone and claims 1 to 5; a pass needs all >= 3 and the model's own pass. The email is in the user turn, delimited, marked as data. An approved brain slice (voice, facts, pillars) is in the system prompt.
- **Fail closed:** no key, timeout, missing verdict or out-of-range score holds the message (`REVIEW_UNAVAILABLE`). A reviewer outage stops automatic sends instead of waving them through.
- **Cost control:** a cold batch reviews one rendered draft per template plus one extra; a template keeps its worst review, so a failing template holds every draft built on it. Templates with fetched site text are reviewed per draft (up to 40 a batch); the rest are held. The follow-up sweep reviews once per template per sweep.
- Every decision is a row with rule codes and the verdict. Operator messages carry a one-line summary ("38 pass, 2 held, 0 blocked; most common: GREETING_NOT_PERSONAL (2)").

---

## 12. Sending and deliverability

### 12.1 Two sending paths

| Path | Provider | Use |
|---|---|---|
| Cold | Transactional ESP from an **isolated subdomain** | First touches and sequence steps |
| Warm | The real workspace mailbox | Replies, meeting notes, proposals, lifecycle |

`Reply-To` on cold mail is the real mailbox, so every reply lands in one inbox and one inbound pipeline. The subdomain protects the primary domain's reputation. Cold mail never goes through the mailbox, and when a mailbox is configured a reply is never sent through the cold provider.

### 12.2 The daily cold batch

One batch per day inside the send window (default: 13:00 UTC Monday to Thursday, which lands early morning US Eastern).

1. Master switch flag must be on.
2. **Daily idempotency key** holds the campaign id; a re-run resumes that campaign's unsent approved drafts instead of starting a new one. Same-day top-ups get one claim per day and subtract today's sends and queued deferrals.
3. **Volume** = the ramp level; an operator limit can only lower it; hard max 1,500.
4. Clamp to the per-domain daily cap (default 500).
5. **Auto-approve** if the flag is on or the `cold_batch` class is at L2+.
6. **Selection SQL** (oversampled 1.5x and divided by `1 - holdout_rate`): cold, never contacted; fit and person-fit exclusions; intent filter when enforced; not in sent-dedup log; not suppressed; not cached undeliverable; verification floor; no queued deferral; no open draft; not in holdout; not moved jobs; no evidence conflict; optionally job-checked recently.
7. **Pure picker**, in order: identity verdict; person fit keep (never-list read error throws); account key exists; **live-thread account block** (anyone at the account warming or better, a deal past contacted, a reply in 90 days, or a decline in the last 90 days); **account opt-out block** (anyone at the account opted out or complained); weekly account cap (default 3 per 7 days at readiness, so selection stops at 2); **1 per account per batch**.
8. Inline verification, cache first, fail closed.
9. **Atomic claim per contact** via the effects ledger; split into holdout and send.
10. Create the campaign, allocate templates (section 14), fetch site context only if needed, compose, run the quality gate, store drafts (`approved` with digest only if auto-approved and passing; otherwise pending). Each item gets an idempotency key `<date>:<contact>`.
11. **Readiness scorecard** (below). On RED caused only by suppression or account-cap overlap, drop the offenders and re-score once ("salvage").
12. **Policy:** manual mode writes an approval manifest and sends samples with a release code; RED holds everything and alerts; YELLOW sends `max(5, n/2)` and defers the rest 24 h; GREEN sends all.
13. Send, then per-item bookkeeping (each write caught and counted): draft sent, experiment credit, provider message id, outreach log, warmth `cold -> contacted`, a Contacted deal, sent-dedup row, sequence state (step 1, next send +3 days). Then seed copies. Then a completion notice with the ramp level.

### 12.3 Campaign readiness (worst dimension wins)

| Dimension | Block | Warn |
|---|---|---|
| Send cap | at cap | partial headroom |
| Bounce rate (1 day and 7 days) | critical | warn |
| Suppression overlap | any overlap | check failed |
| Verification coverage | any cached undeliverable | 50%+ uncached or any risky |
| Content lint (sample of 5) | any block | any warn |
| Account cap | projected over cap | exactly at cap |

### 12.4 Approval manifests

A manifest maps each draft id to its content digest; its code is the first 6 hex characters of a hash over the sorted `draftId:digest` lines. The operator releases with `batch-release-<id>-<code>`. Release refuses without a manifest, re-validates each draft (created within 14 days; still cold; not opted out; no reply, inquiry or unsubscribe since drafting; no newer send), and checks the digest. Samples shown: first, middle and last draft. Follow-up steps are released the same way, with their own command (section 13.1).

### 12.5 The provider boundary

Every send passes these checks inside the send function itself, so no caller can skip them:

1. System halt or cold kill switch: defer.
2. Suppression (fail closed).
3. Content lint: block is an error, warn proceeds.
4. Verification policy for the path.
5. Approval digest, when the send relies on an approval: any mismatch refuses.
6. Send window: outside it, defer with the next allowed time.
7. Per-domain daily cap: overflow deferred to midnight UTC. Per-account weekly cap on cold and sequence mail: overflow deferred until the oldest send leaves the window.
8. **Circuit breaker:** 3 consecutive provider failures in a day opens it (alert) and defers to midnight UTC. Cold mail never falls back to the warm mailbox.
9. Chunk to the provider batch limit (100), throttle per second.
10. Per item: strip AI tells, append the plain-text postal footer to cold and sequence mail (a reply to someone who wrote in carries the headers but no visible footer), add `List-Unsubscribe` headers and threading headers, tag with contact, campaign, draft, experiment and variant ids for webhook correlation.
11. Chunk idempotency key = hash of sorted item keys (the real dedup is in the DB).
12. On success: signal the sequence, record a funnel event, increment counters, write a ledger row.

Results are typed: `sent`, `deferred` (with a reason and the next attempt time), `blocked` (`[SEND BLOCKED:<reason>]`, for example suppressed, undeliverable, content_lint or approval_mismatch), `duplicate`, or `failed`. The per-account cap is enforced here as well as at selection and readiness, so no send path can go around it.

### 12.6 Send windows and time zones

- Window 08:00 to 15:00 recipient-local on window days (cold: Monday to Thursday; lifecycle: Monday to Friday).
- Time zone inferred from free-text location: country table, then regional city and state rules, then international cities, with a default.
- Items outside the window go to a **deferred queue** (dedup on contact, campaign and subject; statuses queued, sent, failed, cancelled). Replay runs several times a day (APAC morning, US morning, US afternoon), claims atomically, re-runs every boundary gate, backs off `1h * 2^attempts`, and fails after 5 attempts with an alert. Re-check replies and warmth at replay as well.

### 12.7 Warm-up ramp

- Levels 25, 50, 100, 250, 500 per day; state in KV; a read error falls back to level 0.
- **Advance** only on delivery evidence: at least 7 days since the last change, sends in the last 7 days, provider delivered events present, the peak day delivered at least 70% of the level, hard bounces under 2%, complaints under 0.1%.
- **Step down** on complaints >= 0.3% of delivered (20+ delivered), on a warning, or on the reply-collapse tripwire.

### 12.8 Bounce monitor and kill switch

- Bounce windows 7 days and 1 day: under 2% healthy, 2 to 5% warn, 5%+ critical; under 20 sends is low volume.
- Critical auto-pauses cold sending. A spike only in the 1-day window is a warning pause; a repeat within 14 days of an auto-resume escalates to critical.
- Warning pauses auto-resume after 3+ days and 3 clean days, with a ramp step-down. Critical pauses remind the operator daily and only a person can resume.
- **Reply-collapse tripwire:** if recent sends (3 to 10 days old, 150+) reply at under 25% of the baseline (10 to 38 days old, 300+, at least 1% reply rate), step down and alert once a day.
- **Kill switch** value: `{reason, source, since}`, under one key per severity (`outreach:cold-pause` for a warning, `outreach:cold-pause:critical` for a critical pause). Unreadable counts as paused and critical.
- **System halt** is a separate flag that stops every scheduled job and every send, replies included. Absent means running; anything else, including a read error, means halted. Set only by the operator.

### 12.9 Suppression and unsubscribe

- Suppression reasons: opt out, bounce, spam complaint, manual, do not contact. Lower-cased, insert-or-ignore, checked in batch, fail closed. **No remove tool by design.**
- An opt-out at an account keeps its colleagues out of cold outreach.
- **One-click unsubscribe (RFC 8058):** token = `b64url(address).b64url(HMAC(key, "u1:" + address))`. Headers `List-Unsubscribe: <https://.../u/<token>>, <mailto:...?subject=unsubscribe>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. GET shows a confirmation page and never acts (link scanners prefetch); POST opts out. Opting out suppresses, sets warmth, stops sequences, moves the lifecycle, records an autonomy incident and notifies the operator.
- A plain-text footer with a postal address and reply-to-unsubscribe line on every cold and sequence email. A reply to someone who wrote in carries the `List-Unsubscribe` and threading headers but no visible footer, so it reads like a normal reply.

### 12.10 ESP webhooks

- Verify Svix-style HMAC over `{id}.{timestamp}.{body}` with a 5-minute replay window **before** returning 200; then process in the background.
- Match by tags, else provider message id, else email.
- **Delivered:** update campaign contact, outreach log, ledger, domain delivery stats, and an audit row (the ramp's evidence).
- **Bounced (hard, or type missing):** suppress the address (reason bounce) and mark it undeliverable, stop its sequences; ledger, domain stats, autonomy incident, alert. A bad address is not an opt-out, so warmth is left alone. Every bounce updates status and a funnel event.
- **Complained:** ledger, incident, opt out, suppress regardless of match, alert.
- Opens and clicks are ignored (plain text, no tracking).
- Seed-copy events (tagged) are dropped.

### 12.11 Seed inbox placement

Up to 5 seed inboxes, up to 3 distinct templates per batch, sent with a seed tag and recorded only in a placement table. An hourly check 2 to 26 hours later reads labels (spam, promotions, inbox, missing) on workspace seeds via delegated read access. The weekly digest compares inbox and spam rates week over week.

### 12.12 Liveness

Daily: alert on zero outbound in 3 days, or a window day with eligible contacts and zero sends, with a diagnosis (kill switch, pending campaign, deferred queue). Also an inbound-reply liveness check (no replies in 5 days with 20+ sends).

---

## 13. Sequences and follow-ups

### 13.1 Cold sequence

- Step 1 cold intro; step 2 follow-up 3 days later; step 3 breakup 7 days after step 2. Follow-up templates match the step-1 angle.
- State lives on the campaign contact row: step, active, next send, paused at, pause reason.
- **The inbox must be recording.** The reply check can only see replies the inbox has recorded, so every step is held unless intake is running (`sequences:reply_intake`): with polling, the latest inbox poll must have completed in the last 10 minutes; with routed intake, where mail is recorded as it arrives, `inbox:enabled` is enough. Anything else, or a read error, holds every step.
- **Per due row, in order:** reply check (the contact, the sender, or anyone at the same account domain in 30 days stops it); person fit drop ends it; step over 3 marks it exhausted; optional manual-channel gate before step 3; missing template or a template that fails a fixture render through the gate holds every step (row stays due, operator told); deterministic gate plus one review per template; release or send.
- **Release.** Follow-up steps share the cold batch's autonomy class and are released like the cold batch. At the default level each sweep puts its passing steps in one approval manifest and asks for `sequence-release-<id>-<code>`, which re-checks every step (the reply check included) before sending. With auto-approve, or the class at L2+, steps that pass the gate and the model review are sent.
- A reviewer outage alone leaves the step due for the next sweep. A failure for one contact pauses that contact until `sequence-resume-<contact id>`.
- **Threading:** fetch each earlier step's Message-ID from the provider once, store it on the send ledger, and set `In-Reply-To` and `References`, so follow-ups thread under the first email in every client. A step that cannot be threaded is held, never sent unthreaded.
- Idempotency key per step and contact.
- Sweeps run several times a day; stale sequences are detected on weekends.

### 13.2 Manual channel step

Before step 3, optionally draft a short fixed note (max 300 characters) for LinkedIn or X and ask the operator to do it and mark `channel-done-<id> [linkedin|x]` or `channel-skip-<id>`. Step 3 waits until marked or 5 days pass. Nothing is posted automatically. A done touch is logged in the ledger as a manual provider.

### 13.3 Multithreading after silence

After a breakup with 14 to 60 days of silence, if the whole account has had no inbound and no suppression in 180 days, record a signal for one colleague (one per account per 180 days, atomic claim). The colleague still passes every batch gate and verification. The signal sweep drafts fixed copy.

### 13.4 Re-engagement on a new signal

Only when the last touch was 90+ days ago with no reply, the signal is newer than that touch, and there was no re-engage in 90 days. Never a generic re-send.

### 13.5 Signal response

- Routes: skip (suppressed, opted out, holdout, meeting booked, product user, pending outreach); first touch (never contacted); replied (operator draft only); skip if contacted under 90 days ago; re-engage (flag plus newer signal).
- Only a whitelist of sources may have their headline quoted; everything else uses fixed openers.
- **Fast-lane auto-send** requires: both the signal auto-send flag and batch auto-approve; a non-draft-only source not recorded by an agent; first-touch route; severity >= 0.70; an unexpired signal (missing expiry fails closed); no link or markup; verification readiness; ramp budget left. Run the quality gate here too.
- Signal drafts block the cold batch from writing to the same person.

### 13.6 Referrals and renewals

- **Customer referral ask:** engaged customers 90+ days after winning, no ask in 180 days, fixed copy, draft for approval.
- **Cold referral redirect:** silent high-tier prospects (3+ sends, 0 replies, last send 14 to 90 days ago) at accounts with other contacts: ask who the right person is. Max 10 per week.
- **Renewal:** one draft per subscription per renewal date; expansion offers are an offer class (always human).

### 13.7 Lifecycle follow-ups (product users)

A per-contact timer object reschedules on each lifecycle transition.

| Kind | Trigger state | Delay | Autonomy class |
|---|---|---|---|
| First-use nudge | signed up | 24 h | activation |
| Last first-use nudge | signed up | 72 h | activation |
| Usefulness check | activated | 2 h | feedback |
| Upgrade offer | at limit | 10 min | offer (always human) |
| Re-engage | stalled | 1 h | re-engage |
| At-risk check-in | at risk | 1 h | at risk |
| Win-back | churned | 30 d | offer (always human) |

Gaps: at least 3 days between follow-ups (shorter for the last nudge and usefulness check); max 4 per 30 days. Order of checks: state, caps, predecessor, autonomy level (L0 skips), window defer at L2+, a cheap yes/no classifier gate, then at L2+ the quality gate and send, else an L1 draft with `fu-approve-<id>`. Approval re-checks digest, age (2 to 14 days by kind), lifecycle state and window (overridable by repeating the command within an hour).

---

## 14. Experimentation and A/B testing

### 14.1 The per-send ledger

One row per confirmed send: contact, campaign, draft, template id, **template hash** (of the current copy), body hash, subject, subject test and variant, experiment and arm, sequence step (1 = first touch), send path (batch, release, follow-up, deferred, signal, other), provider and message id, recipient domain, send slot, **cohort**, and later: replied at, reply intent, reply after step, positive reply at, bounced at.

- **Cohort:** `signalled` (a signal in the 90 days before the send), else `segment_routed` (template has targeting), else `generic`.
- **First-touch attribution:** a reply is credited to the latest step-1 send within 60 days before it; out-of-order replies keep the earliest timestamps; `reply_after_step` records how deep the sequence was.
- **Matured samples** only: step 1, not bounced, older than the maturity window (10 days, since follow-ups land at days 3 and 10), and only rows whose template hash equals the template's current copy (so edited copy starts fresh).

### 14.2 One definition of a positive reply

Positive = triage intent in {interested, question, referral}, **or** a non-cancelled, attributed meeting first seen after the send. Opt-out, unsubscribe, auto-reply, spam and noise never count as replies. "Not a fit" is a reply but never positive. Every report, experiment and promotion uses this definition.

### 14.3 Measurement health

Before any reply-based conclusion: ledger coverage (provider-sent events matched to ledger rows) must be >= 95% over 7 days with 20+ sends. Product-metric conclusions are also blocked when the product event bridge has unrouted events older than 6 hours. Health that cannot be read blocks (fail closed). The scorecard shows it.

### 14.4 Allocation: Thompson sampling with guardrails

- **Seeded RNG** per batch (`date:uuid`, logged) so any run is reproducible.
- Each arm's share = P(arm is best) by Monte Carlo (4,000 draws) under Beta(1 + positives, 1 + sends - positives).
- Thompson takes over only when every arm has 50 matured sends; before that, operator volume weights apply.
- **Protected control** (the long-running baseline template) gets a minimum 20% share; every other arm gets a 15% floor, scaled so floors total at most 50%. At most 4 arms plus control.
- **Cells:** most specific first (`stage|region|persona`, then `stage|region`, then `stage`). A cell decides only when every arm has 150 matured sends in it, and it is shrunk toward its parent with 50 pseudo-sends (hierarchical pooling). Readiness counts real sends only.
- Shares become counts by **systematic sampling** with a random offset, then a shuffle.
- An escape hatch flag reverts to plain weighted rotation.

### 14.5 Account-clustered assignment

Colleagues at one account must share an arm, or spillover contaminates both arms. The unit is the account key (a contact without one is its own unit). Units are ordered by a salted hash; arms are assigned per unit and **pinned** in an assignments table (scope, test id, unit, arm, seed, stratum) before any draft is composed. A pinned account keeps its arm for the life of the experiment. An unpinned account enters an arm only if the arm has room for every member; otherwise it is planned without the experiment and gets no arm credit.

### 14.6 Experiment types

| Type | Notes |
|---|---|
| Template experiment | Control vs treatment template; metrics reply rate (default), signup, activation, paid; max 2 running |
| Subject test | Per template (subject x template are factorial cells); even split to 50 matured sends per variant, then Thompson with floors |
| Send-time test | Recipient-local early (08 to 10) vs afternoon (13 to 15), split by account within each time zone stratum; later slots queued and replayed hourly |
| Segment routing | Templates targeted by segment, team size, persona |
| Holdout | A no-send control group (below) |

### 14.7 Holdout

Default 5% (max 20%) of the ready, fit-ordered window is held out independently using the seeded RNG, claimed like sends, recorded, and excluded from every send path for 90 days. Lift = absolute difference in signup rate (within 30 days) and positive reply rate between treated and held, marked sufficient only with 100+ held. Spillover within accounts biases lift low; say so in the report.

### 14.8 Pre-registration and conclusion

An experiment is created as a draft and cannot start until it has: hypothesis, population, exclusions, primary metric, metric window, baseline rate, minimum detectable effect, max sample per arm (>= 20), max duration, stopping rule, and both templates. Start requires both templates active, healthy measurement, fewer than 2 running, and a **two-step approval** (the first command shows the record and both templates' numbered copy; the second starts it only if nothing changed). Sample size helper: two-sided 95% / 80% power normal approximation.

Evaluation (twice daily): confidence = P(treatment > control) by Monte Carlo; may conclude when both arms reach target and the minimum age is met (10 days for reply metrics, 45 for product metrics), or at max duration. **Keep** at P >= 0.95, **discard** at P <= 0.05, both requiring 300+ matured sends per arm; otherwise inconclusive. Blocked while measurement health blocks.

Product outcomes (signup, activation, first payment) credit the last arm the person received within 60 days, once per (experiment, contact, column).

### 14.9 Promotion: the copy-change gate

Nothing in code applies a copy change on its own. A proposal needs 300+ matured sends per arm, each at least 10 days old, and P(better) >= 0.95 (deterministic normal approximation of the Beta difference). Proposals are deduped for 7 days and sent to the operator. Promotion of a template winner raises its weight and drops the loser to a floor of 0.1; it refuses if anything changed since the proposal. A concluded subject winner becomes a new active template only after an operator-approved proposal.

A zero-reply tripwire alerts after 100 subject sends with no replies.

### 14.10 Weekly self-review

Rule-based, no model, at most 3 proposals per week: adjust a template weight (+/-0.1 when P vs control >= 0.9 or <= 0.1 with 150+ sends per arm), raise the holdout when it is too small, turn on the next signal source when verified runway is under 30 days, start the send-time test when volume allows. Each proposal carries a prediction; later outcomes record hit or miss, and new proposals show the proposer's track record. Applied only by `exp-approve-<id>`, and only if the setting still holds the value the proposal was made against.

### 14.11 Reports

- **Conversion report:** positives per template, subject, signal, cohort, segment, persona, angle and tier over 30 days. Slices under 30 sends are labelled directional and never named winners.
- **A/B dashboard:** running tests and recent conclusions with lift over second best.
- **Campaign postmortem:** pure aggregation.

---

## 15. Reply handling

### 15.1 Detection

- **Push:** mailbox push notifications to a webhook (shared secret, constant-time compare). The push is only a wake-up; ignore its history id (it is the state after the new message).
- **Poll:** every minute, list history since the stored id; bootstrap on first run or an expired id. Near-zero cost when nothing is new. **Never put model calls in the per-minute job.**
- **Safety-net sweep** every 15 minutes over the last 3 days of inbox, skipping known ids.
- Watch registration renewed daily (it expires in 7 days).
- Dedup on a unique message id.

### 15.2 Structural classification (deterministic, in order)

1. Bounce (mailer-daemon sender or bounce subject).
2. Auto reply (no-reply sender, service subject, `Auto-Submitted`, `X-Autoreply`, `Precedence: auto_reply`, anchored out-of-office subject).
3. Unsubscribe (bare "unsubscribe" or an anchored opt-out phrase).
4. Reply (`Re:`).
5. New inquiry.

Billing-failure mail goes straight to the operator. Mail from your own product's forms routes to the feedback pipeline. Never draft to your own domain.

### 15.3 Semantic triage

Small model, structured output, the full body read once with quoted history stripped, capped at 4,000 characters, delimited as data. Intents: interested, objection, question, warm, referral, not a fit, opt out, auto reply, spam, noise, unclear. A supporting quote is kept only if it appears verbatim. The result is cached as a tag on the row and parsed by later jobs. Backfill retries untriaged replies, once per email per day, budget-gated.

Side effects: opt out at >= 0.8 suppresses and moves the lifecycle; interested, question or objection at >= 0.7 advances the deal one stage (capped at demo scheduled); not a fit or opt out at >= 0.8 closes the deal lost with a reason; the ledger credits the first touch.

### 15.4 Routing by intent

| Intent | Action |
|---|---|
| Opt out / unsubscribe | Suppress (on failure alert and rethrow), opt out, stop sequences, move lifecycle, audit, notify |
| Hard bounce | Suppress the address and mark it undeliverable (never an opt-out), stop its sequences, quality incident |
| Confident decline (not a fit >= 0.8, no opt-out wording) | Hold the **account** for 90 days (not forever); a later positive reply clears it. A short closed decline with no question is archived without a draft |
| Referral | Add up to 3 colleagues found in the message **headers** at the same account domain as warm contacts (excluded from cold); skip suppressed or erased |
| Out of office | Parse the return date (named months, unambiguous numerics, max 60 days, default 7) and hold the next step until return + 1 day; no warmth change, no credit |
| Second objection | No draft (one answer per contact) |
| Opt out, spam, auto reply, noise at >= 0.8 | No draft |
| Objection | Filed into the objection library for curation |
| Interested, question | Meeting qualifier, then draft |

### 15.5 Meeting qualifier

Four checks: **problem** (a verbatim quote), **role** (from CRM title, never from the email), **timing** (a verbatim reason, a meeting request or a proposed time), **fit** (account fit >= threshold; unscored counts as fit). No gaps: book. 3+ gaps: pass (no booking language). A meeting request or proposed time with at most 1 gap: book. Otherwise: ask one question about the first gap. A proposed time forces "confirm the time, invite will follow, no link".

### 15.6 Drafting

A mid-tier model drafts from: approved reply facts (capped), approved reply assets (a demo link, a one-pager), the qualifier's rule, matched approved objection answers, and the voice profile. A request to "see the product" gets the demo asset instead of a call offer. Drafts are stored pending with an autonomy class:
- `reply_demo_link`: an asset was requested and the draft carries exactly one approved asset URL.
- `reply_question`: a question at >= 0.8 with facts available.
- `reply_send`: everything else.

### 15.7 Auto-send rules (pure function, fail closed; all must pass)

Until the auto-send tier is built, every reply needs a person's approval. These rules are its specification, and `inbound:auto_send_tier` is reserved for it.

1. The tier is enabled (a flag, or the class at L2+).
2. Outreach is not paused.
3. It is a reply, or an inquiry from someone you emailed.
4. A contact is matched.
5. No proposed time.
6. No asset request, unless the class is the earned demo-link class.
7. Reply-To equals the sender.
8. Intent: interested at >= 0.8 with a booking URL, or scheduling words in the sender's own text; earned classes need their intent at >= 0.8.
9. A risk pattern (pricing, legal, contract, compliance, cancel, unsubscribe, competitor) misses on both the inbound text and the draft.
10. Earned classes: no plan or offer terms, and **fact grounding** passes (every number in the draft appears in the facts; no "I will confirm and come back"; no customer or reference claims).
11. No links except the exact booking URL or approved asset URLs.
12. An interest reply carries the booking link; a demo-link reply carries its asset.
13. Lint does not block.
14. Then the full quality gate.

Then send on the thread, mark responded, record `auto_sent` evidence, notify after the fact. Questions, objections, declines, anyone proposing a time, and anyone asking to see the product without an earned class always go to a person.

### 15.8 Freshness before sending

Approving a reply draft marks it approved and sends nothing. Sending it (the reply send job, or `/reply_send <draft id>`) re-checks the approved digest and then refuses if a newer human message arrived on the thread or from the sender, if a sent message exists after this one, if a mailbox draft already exists (send from the mailbox instead), if the text differs from what was last shown, or on any mailbox read error. A send lock prevents double sends.

### 15.9 Reply-owed clock

- Escalating reminders for warm intents and untriaged mail from known contacts: at 15 minutes, 2 hours and 4 hours (each once; a late-seen reply gets only its highest due tier), then once each morning after 12 hours old. Claims release if the notification fails.
- A business-day clock in the digest: warn at 1 business day, breach at 2.
- **Quiet threads:** responded warm threads with 5+ days of silence and no meeting are surfaced once. Never auto-sent.

### 15.10 Mailbox draft mirroring

Every non-auto-sent reply draft becomes a real draft in the operator's mailbox on the thread (newest message only, under 14 days). Every 15 minutes, reconcile: if the mailbox draft disappeared and a message was sent, mark responded and record evidence as `approved_unchanged` (sent text matches after stripping quotes and signature) or `approved_edited`; if nothing was sent, alert once and keep it owed; after 7 days mark it ignored and rejected. The operator can work entirely from their inbox and the system still learns from every edit.

---

## 16. Convert: meetings, booking, proof of value

### 16.1 Booking link

The booking URL is configured (https only; `sending.bookingUrl` in `gtm.config.ts`). Optionally, booking links are served through the deployment: a signed `/b/<token>` redirects to the configured URL, so the URL can change without editing templates. It records nothing per contact, because there is no click tracking: bookings are detected by calendar sync. By default the booking link is the only link an automatic reply may carry.

### 16.2 Calendar sync (every 15 minutes, flag-gated)

- Read-only scope, primary calendar, 3 days back to 60 days ahead.
- **Privacy:** request only id, status, start, end, attendees (email, self, response status) and organizer. **Never fetch titles or descriptions.**
- Counts: timed events; attendees minus self, declined, internal domains and calendar resource addresses. A booking needs an outside person who **accepted**, or an invite the operator organized. Anyone can put an invite on your calendar; it does nothing until the contact accepts.
- **Attribution order:** an accepted attendee is a known contact; the operator organized it and an invitee is a contact; exactly one contact at the attendee's domain was contacted in 60 days. Domain matching applies only to operator-organized events. Ambiguity produces one notice and a `meeting-link-<event> <contact>` command; `meeting-unlink` makes a meeting inert.
- **On booked:** stop cold outreach and deferred sends; lifecycle engaged; warmth hot; create or step the deal to demo scheduled; count the meeting against the template; write a prep brief (reuse research or build a static one); notify.
- Cancelled: a rebook draft. Rescheduled: reminders reset.
- **Reminders** to the operator at 24 hours and 1 hour.
- **Held or no-show:** after the meeting, ask `meeting-held-<id>` or `meeting-noshow-<id>`. No answer in 24 hours drafts the recap for review (never sends). No-show withdraws the recap and drafts a rebook (always a draft).
- **Post-demo sequence:** recap immediately (sent at L2+ if the gate passes, else draft), step 2 at day 4, step 3 at day 10, inside the recipient's window. Step 2 waits until the recap actually went out. Stops on any reply (including from the account domain), suppression, signup, or a newer meeting. Heuristically attributed meetings are capped at L1.
- **Notes and decision map:** `meeting-notes-<id> <notes>` stores notes and drafts an operator-only decision map.
- **Prep command:** builds a one-page brief on any contact.
- **Deal handoff:** reaching proposal or negotiation (or a value threshold) generates a handoff brief.

### 16.3 Proof of value

The operator requests that the product run its core analysis on something the prospect cares about (`pov-request-<contact> <target>`). The request is HMAC-signed to the product's API; the system polls until ready, then builds a deterministic email draft with gate findings shown beside it, carrying only a share link on the app host. **Never sent automatically** (permanently human). After sending, share-link views are polled for 30 days and each new view count notifies the operator once.

---

## 17. Customer lifecycle, event spine, product bridge

### 17.1 Lifecycle states

`sighted, qualified, parked, contacted, engaged, nurturing, opted_out` (pre-signup) then `signed_up, stalled, activated, at_wall, paying, expanding, at_risk, churned` (product), plus terminal `deleted`.

| Event | From | To |
|---|---|---|
| qualified | sighted, parked | qualified |
| outreach sent | sighted, qualified, parked, nurturing | contacted |
| replied | contacted, nurturing | engaged |
| sequence exhausted | contacted | nurturing |
| unsubscribed | any pre-signup | opted_out |
| signed up | any pre-signup | signed_up |
| first value event | signed_up, stalled | activated |
| stalled check (72 h no value event) | signed_up | stalled |
| limit reached | signed_up, stalled, activated | at_wall |
| subscribed | any | paying |
| subscription changed | paying states | expanding (up) or paying (down) |
| payment failed | paying, expanding | at_risk |
| canceled | paying states | churned |
| dormant (14 days idle) | paying states / activated, at_wall | at_risk / stalled |
| recovered | at_risk | paying |
| user deleted | any | deleted |

One module is the only writer: compare-and-set with retries; attribution fields set once; first-time timestamps (signed up, activated, first paid, churned). Side effects: entering a product state stops cold outreach; deleted triggers erasure; product states notify the follow-up timer; experiment credit; deal mirror; warmth summary.

### 17.2 Deal mirror

Signed up to trial, at wall to proposal, paying to closed won, churned to closed lost (with a reason enum). Steps one stage at a time, never backwards, never a second deal for someone already won.

### 17.3 Event spine

1. **Record:** write the raw payload to blob storage first, then insert-or-ignore the event row keyed by provider id. A duplicate is not dispatched again.
2. **Dispatch** to a queue (or inline if no queue).
3. **Route** with a lease (stale after 10 minutes), max 5 attempts, then park and audit.
4. **Sweep** unrouted events older than 5 minutes, every 5 minutes.

Each event carries a taint level (product feedback text is full taint). The spine handles product, git host and deploy host events.

### 17.4 Product bridge contract

[EVENT-CONTRACT.md](EVENT-CONTRACT.md) is the wire contract; in outline:

- **Push:** `POST /api/webhooks/product` with `X-Signature: sha256=<hex HMAC(body, secret)>`, an event id header equal to `body.id`, constant-time compare. 503 when unconfigured, 401 bad signature, 400 bad shape, 200 with a duplicate flag otherwise.
- **Envelope:** `{id, version, type, occurred_at, user{id,email,name,role}, org{id,name,plan_tier}|null, ref, data}`.
- **Types:** signed up, org created, first value event, limit reached, subscribed, subscription changed, canceled, payment failed, feedback submitted, user deleted, top-up purchased, API key created.
- **Identity resolution order:** existing linked user id, an attribution ref token, exact email, account domain (new person), else a new inbound contact. Tombstones are checked first.
- **Pull (reconcile, nightly):** signed `GET` endpoints for users, feedback and deletions with high-water marks, up to 3 pages of 200 per run, a full re-read weekly. The pull is the repair path; the push does not retry.
- **Attribution token:** `?ref=<token>` on product links, stored by the product in a 30-day cookie.
- **Product signals:** expansion notices, plan-mismatch intent flags, a per-account usage signal at most monthly, a fast welcome on signup. Product usage is never used as an outreach opener to colleagues (privacy).

### 17.5 Billing and revenue

- Billing webhook (`t=,v1=` signature, 5-minute tolerance): checkout completed (link customer, signup event, stop sequences), subscription created (subscribed), updated (only real status changes; active after past due is recovered), deleted (canceled), payment failed. Effects claimed per event id and released on failure. Contacts are resolved, never created; erased people are refused.
- MRR per contact from the amount when sent, else list price; a daily MRR snapshot table sums paying states.
- Checkout sessions can be created per plan (an offer, so human-gated).

---

## 18. Goals, planning and coordination

- **Goals** are MRR targets with dates (`goal-set <amount> <date>`). The binding goal is the first one ahead and unmet. A goal is achieved early only if the last 14 daily snapshots meet it.
- **Weekly plan (Monday):** trailing 28-day funnel (sends, positive replies, signups, activations, paid), cohort rates smoothed toward priors with 20 pseudo-observations, then work backward from the MRR gap: paid per week = (gap / weeks left + churn replacement) / ARPA, divided down through each rate. **Bottleneck** = among stages with 20+ observations, the rate furthest below 0.8x its prior (or "sends" if nothing is below and paid is short). Writes weekly quotas (advisory; they do not change send volume) and posts a plan.
- **Weekly result (Sunday):** week-to-date counts vs plan.
- **Goal context:** a deterministic block injected into the hub and coordination prompts (15-minute cache).
- **Daily coordination:** a top-tier model writes a brief and may propose up to 3 knob changes from an allowlist of volume and sourcing settings with bounds. Applied only with `knob-approve-<id>`; proposals expire in 7 days.
- **Morning briefing** and **campaign suggester** surface the next best moves.

---

## 19. Earned autonomy

### 19.1 Levels

| Level | Meaning |
|---|---|
| L0 | Observe only |
| L1 | Draft and ask (default) |
| L2 | Act and notify |
| L3 | Act, report in a digest |

Stored per action class; a read error falls back to L1. Set by `autonomy-set <class> <0-3>`.

**Action classes:** cold batch (which also covers the cold sequence's follow-up steps), reply send, reply demo link, reply question, ship spec, ship notification, post-meeting follow-up, rebook, retrospective actuation, brain edit, lifecycle activation, feedback, re-engage, at risk, renewal, other.

**Permanently human** (capped at L1 on read and set): merging PRs, pricing/billing/auth changes, proof-of-value sends, offers and discounts, data deletion.

### 19.2 Evidence

Every decision writes an autonomy event: `approved_unchanged`, `approved_edited`, `rejected`, `auto_sent`, `incident`. Operator commands, mailbox-draft reconciliation and automatic sends all feed it.

### 19.3 Promotion (weekly, proposed only)

- **L1 to L2:** 30+ decisions in 60 days (a batch is one decision, so the cold batch needs 4 and specs 5), 90%+ approved unchanged, at most 5% rejected, no incident in 30 days.
- **L2 to L3:** 60+ automatic sends in 60 days, no incident and no rejection in 60 days.
- **Outcome gate for the cold batch:** matured first touches (10 to 40 days old) vs a baseline (40 to 130 days old), 200+ sends each, hard bounces under 2%, positive reply rate at or above baseline.
- **Eval coverage:** a class that writes outbound text cannot be promoted unless an evaluation suite covers its writer (section 29).
- The same proposal repeats at most every 14 days.

### 19.4 Demotion (immediate)

A hard bounce, complaint or unsubscribe on an automatic send drops every class that auto-sent to that contact in the last 14 days back to L1. For the cold batch, only per-contact complaints count; bounces and opt-outs count through an hourly rate check (14 days, 50+ sends, bounce rate >= 2% or unsubscribe rate >= 1%). A polite decline is never an incident.

---

## 20. Self-improvement loops

Each loop is independent; a failure in one never cascades.

| Loop | Cadence | What it does | Guardrail |
|---|---|---|---|
| Retrospective | daily | Picks exactly **one** improvement: a learnings update, a memory, or a bounded process change | Structural one-change limit; actions limited to proposing a template change (copy-change gate), adding an inactive query, or a playbook field (lint and link checks); at most one actuation per day; level-gated |
| Agent review | weekday mornings | Top-tier model grades the last day's drafts and worker actions A to F and stores corrective guidance as memory | Unparseable output stores nothing |
| Fitness | daily | Weighted score: outreach quality 0.20, research 0.10, pipeline 0.10, efficiency 0.10, discovery 0.15, activation 0.15, revenue 0.20; trend by regression slope | Activation scored only with 5+ signups |
| Benchmark | weekly | A judge model scores synthetic outreach, research and routing scenarios; a drop over 0.05 is a regression | Scenarios regenerate monthly |
| Evolution | weekly | Generates 3 candidate edits to the instruction document behind a declining dimension, benchmarks each, keeps the best | 7-day cooldown; below L2 it only proposes; at L2 it rolls back if the post-apply benchmark regresses |
| Session mining | weekly | Diffs the operator's edits (draft vs sent) sentence by sentence: removed or added sentences, shortening, removed links or questions; patterns seen in 2+ drafts become proposed rules (max 3/week) | No model; examples defanged |
| Voice profile | on demand + weekly drift check | Built only from threads the operator picks (their sent messages, quotes and signatures stripped), versioned | Rebuild suggested when the edit rate is >= 40% over 10+ decisions |
| Objection library | continuous | Real objections filed for curation; the operator writes and approves answers; drafts use the top 2 by success rate; the next inbound within 30 days scores the answer | Approval digest; one answer per contact |
| Win/loss weights | on close | Laplace-smoothed log-odds per attribute (stage, focus, size) feed discovery scoring; lookalike weights from lifecycle outcomes | Confidence `min(1, n/30)`; skipped under 10 labelled |
| Learnings proposals | continuous | Any loop may propose a snippet for a section of LEARNINGS; the operator approves the exact text shown | Mutation constraints; direct writes only at brain-edit L2 |
| Link triage | on demand | The operator sends a link; it is fetched safely, analyzed by one toolless schema-bound call against an architecture digest, and routed to a learning, a bounded config tactic, or a code-change request | Two-step approval bound to the bytes shown; daily caps |
| Wiki | weekly | Compiles a knowledge wiki about the market from DB aggregates; a lint pass flags stale, oversized, ping-pong and orphaned pages | Size caps |
| Memory consolidation | twice daily | Section 5.3 | Pruning rules |
| Trajectory export | nightly | Exports clean runs as training-format JSONL | Skips tainted or incomplete runs |

---

## 21. Product feedback to shipped code

1. **Themes (daily):** triage raw feedback (delimited, schema-bound); close non-actionable items; embed and join the nearest open theme at cosine >= 0.83 (running-mean centroid). Score = (demand + 3 * paying requesters + requester MRR / ARPA) * priority weight (critical 4, high 2.5, medium 1.5, low 1).
2. **Spec:** above a threshold, a top-tier model writes a spec from the neutral summary, demand numbers, the repo's engineering contract and the denied-path list: title, problem, approach, acceptance criteria, files, tests, out of scope, risk, adoption event, feasible. Infeasible or high risk declines automatically. **Raw user text never reaches the coding agent.**
3. **Approval:** `ship-approve-<id>`. At L2+, low-risk specs auto-approve (2 per run); medium waits.
4. **Durable workflow:** clone and install, run the coding agent in a sandbox, wait, run the repo's checks, one repair round, collect the diff, apply path policy, for high risk wait up to 7 days for `ship-risk-approve`, open a PR, announce.
5. **Sandbox:** a container with **no credentials**; egress only to the model API (server tools stripped), a read-only clone and the package registry; push refused; limits on turns (80), inactivity (45 min), command time, diff size (2 MB), file size and count.
6. **Path policy:** denied paths (auth, middleware, billing, pricing, privacy, security, CI config, API keys, internal APIs); medium risk above 120 lines or 5 files; review threshold 400 lines / 15 files; hard cap 2,000 lines / 60 files; binary or dependency changes are high risk; secrets, bad file modes or non-allowlisted repos are refused.
7. **Gatekeeper:** re-runs the policy on the exact files, one commit through the git data API, deterministic branch name (idempotent on retry), opens a PR. **Never merges.**
8. **Webhooks:** PR merged marks the task merged; closed unmerged declines the theme; check failures notify; a production deploy whose commit equals the merge commit marks the theme shipped and drafts "you asked, it is live" notes to requesters (auto-sent at L2+ after the gate).

---

## 22. Security model

The primary threat is **indirect prompt injection**: instructions hidden in a web page, email or provider response that try to make the agent send, write or exfiltrate.

### 22.1 Taint levels

`none < metadata < structured < full`. Every tool is in exactly one set; an unclassified tool is full taint (fail closed). Always merge with a `max` function, never hand-written comparisons.

| Set | Examples |
|---|---|
| Full taint sources | mail read, web scrape/extract/research, page contents, deep research, document and sheet read, sandbox runs |
| Metadata sources | mail list, search snippets, find similar, structured search, enrichment lookups, memory recall, inbound list/get, triage, feedback, code-mode results |
| Structured sources | a schema-validated extractor that returns only short verbatim tokens, numbers, dates and enum choices (confidence >= 0.8, max 12 fields), behind a flag |
| Untainted | your own DB reads, counts |

| Gate | Blocked at |
|---|---|
| Always gated | any taint: memory store/persist, git branch/write/PR, code execute, result store, link-triage review, deal outcome |
| Full-taint gated | full taint: every send, contact and deal writes, drafts, templates, campaigns, code mode, checkout, smart drafts, launches, approvals, pause/resume, deferred replay/cancel, referrals, signal record, monitor processing |
| Structured allowed | the only full-taint-gated tools allowed at structured taint: contact writes, deal create/update, draft create, smart follow-up, objection draft |
| Structured extra gated | blocked at structured and full: workflow start, CI trigger, sheet and doc writes, monitor create, task create |

A property test asserts **a gate never gets looser as taint rises** across every tool. Session taint persists across chat turns. The block message tells the operator how to start clean.

### 22.2 Content handling

- **Injection detection** redacts suspicious patterns (keeping surrounding bytes) and normalizes Unicode lookalikes.
- **Quarantine fence:** untrusted content is wrapped in a fence derived from the content itself, so it cannot be forged by the content.
- Output caps (head plus tail, 30,000 characters).
- Separate sanitizers for memory text, error messages and AI tells.
- **Boot context validation:** the system prompt carries structural markers; if they are missing, the agent refuses.

### 22.3 Exfiltration and SSRF

- URL validation allows only http and https and blocks localhost, metadata hosts, private, link-local, CGNAT, multicast and IPv6 local ranges.
- At full taint, fetch tools refuse URLs carrying an email address, an encoded blob or a query over 120 characters; query tools refuse queries carrying an email address.

### 22.4 Approvals and overrides

- **Content digests** (hash of recipient, subject, body) bind every approval; `markDraftShown` / `wasDraftShown` ensure the operator approves what they saw; batch manifests bind releases.
- **Smart override:** a small classifier may grant a per-call override for a short list of already-human-gated tools (draft create, deal create/update, campaign create/manage, log outreach). It sees structural facts only (field names, types, lengths, recipient domain, injection booleans), never values. 50 per day, deny by default, every grant audited. Sends and code are never overridable.

### 22.5 Other controls

- **Halt** (section 12.8) and **kill switch**, both fail closed and human-only to clear when critical.
- **Rate limits** per category (examples: API 100/min, chat 30/min, web 40/h, enrichment 30/h, mail 50/h, search 20/h, git write 20/h, sandbox 10/h, code mode 30/h, ESP 30/h, billing 20/h).
- **Auth:** admin and API bearer tokens with constant-time compare; chat allowlist on the operator bot (none configured denies all); every webhook verified before 200 (HMAC with timestamp windows; 503 when the secret is unset); WebSocket origin and token checks.
- **Secrets:** environment only; a pre-commit and CI secrets scan for common key formats and PEM blocks.
- **Untrusted-text rule for prompts:** instructions in the system prompt, data in the user turn, delimited, no tools for the model that reads untrusted text, output validated against a strict shape.
- **Review rule:** any change to the action gate, delegation, the tool dispatcher, migrations or a spend path is reviewed from a context that did not write it.

---

## 23. Privacy and compliance

- **Work email only.** Personal domains are never collected, enriched or emailed. Provider calls that reveal personal emails or phone numbers are refused at a gatekeeper.
- **Provider terms** are never accepted by the agent; the operator is notified.
- **Minimal retention of third-party data:** keep enums and numbers from data providers; drop prose at parse. Store signal evidence as data only.
- **Calendar:** never fetch event titles or descriptions.
- **Erasure:** write a tombstone first (hash of the lower-cased email, plus the product user id); then scrub every table and blob that holds the person (inbound mail, deferred sends, feedback, verifications, funnel events, signals, qualifications, scores, meeting notes, evidence, ledger, objections, candidates, payloads, audit text). Keep the address only in suppression. Every sourcing path, the product bridge, billing and referrals check tombstones, so an erased person is never re-added.
- **Retention:** routed event payloads and raw fields of rejected candidates after 90 days; evidence after 365 days; audit and run rows archived to blob storage in redacted form (emails hashed, free text dropped) after 90 days, verified, then deleted.
- **Declines vs opt-outs:** an opt-out is permanent and account-wide for cold outreach; a decline holds the account for 90 days.
- **CAN-SPAM style basics** on cold mail: postal address, one-click unsubscribe, honest subjects. Check the law for each market you send to, and record the legal basis per market.
- Model gateway calls carrying personal data opt out of payload logging.

---

## 24. Cost controls

- Every model call records cost in micro-cents with cache-read and cache-write multipliers; non-model providers record actual or estimated spend.
- **Global budget:** daily and monthly limits (default $20/day, $500/month) with an alert threshold; soft or hard enforcement.
- **Per-job daily caps** are always enforced, whatever the global mode. A skipped job alerts once per day.
- **Per-run ceiling** for delegated runs ($10 default): stop tools at the ceiling, abort at 1.25x. **Per-turn ceiling** for chat (50 cents) including child runs.
- **Reserve before spend** for any multi-call operation; count before the call so a crash undercounts work rather than overspending.
- **Provider credit gatekeeper:** an allowlist of capabilities with worst-case credit costs and a daily credit cap reserved under a lock and settled to the reported cost.
- Model tiering: top tier for the hub, specs and reviews of agents; mid tier for drafts, fit scoring and the reviewer; small tier for triage, title review and classifiers; cheap hosted classifiers where shadow agreement allows.
- Prompt caching for conversation prefixes; tool caches by source; summary mode for page reads.
- Where costs cliff: model calls in high-frequency jobs, uncached page reads in loops, sending the whole tool catalog every turn, and top-tier models for routine writes.

---

## 25. Measurement and reporting

### 25.1 Daily scorecard (one message, no model call)

Replaces separate briefings and digests when enabled. Lines:
- week-to-date funnel vs quota (sends, positive replies, signups, activations, new paying, meetings);
- sends (first touches, follow-ups, 7-day);
- delivery (flag hard bounces >= 2% or complaints >= 0.1%, with delivered coverage >= 95%);
- replies and positives;
- reply SLA (warm replies waiting over 4 hours);
- spend per job;
- failed jobs;
- convert (30 days): booked and held meetings, held per 100 first touches, reply to meeting, meeting to signup, signup to activated, activated to paid, median hours to answer a warm reply;
- cohorts;
- measurement health;
- everything waiting on the operator;
- flags that are on.

### 25.2 Other reports

| Report | Cadence | Contents |
|---|---|---|
| Weekly GTM digest | Sunday | Outreach, discovery, contacts by source, conversion report, queue health, holdout lift, seed placement, planning hints; stored as memory |
| Funnel digest | Monday | Flags reply rate under 3% or bounce over 2% at 50+ volume |
| Morning briefing | weekdays | Priorities, suggestions |
| Daily cost digest | weekdays | Spend by job |
| Pipeline board | on demand | Stages with gate checks |
| Deal velocity | daily | Stalling and accelerating deals |
| Per-source split | weekly | Contacts, added, touched, positive by source |

---

## 26. Operator interfaces

### 26.1 Chat bot (Telegram is the included adapter)

- Webhook verified, chat allowlist, update-id dedup, long turns on a queue.
- Commands are a registry that generates `/help`; slash forms are normalized (`/fu_approve_x` becomes `fu-approve-x`).
- **One-tap buttons** are attached only to commands that carry a random id, and a button runs only if its command appears in the text of the message it is attached to. Model or agent text never gets buttons.
- Anything that is not a command goes to the hub agent. A `clarify` flow lets the hub pause and ask the operator a question, resuming on the reply.

**Command families:**

| Family | Commands |
|---|---|
| Reply and follow-up approvals | Approve and Reject buttons on each approval request, `/replies`, `/reply_send <draft id>`, `/reply_draft <id>`, `/reply_done <id>`, `/reply_ignore <id>`, `fu-approve/reject-<id>`, `signal-send/discard-<id>` |
| Batches | `batch-release-<id>-<code>`, `batch-reject-<id> [why]`, `sequence-release-<id>-<code>` |
| Outreach control | `outreach-status`, `outreach-run [now]`, `outreach-pause [why]`, `outreach-resume`, `sequence-resume-<contact id>`, `fit-status`, `channel-done/skip-<id>` |
| Experiments | `experiment-drafts`, `experiment-start/promote/hold-<id>`, `experiment-set-treatment-<id> <tpl>`, `subject-test-start/discard-<id>`, `exp-list/approve/reject` |
| Learning | `learnings-pending`, `learnings-approve/reject-<id>`, `learnings-expire-old [confirm]`, `evolution-show/apply/discard-<id>`, `retro-apply/discard-<id>`, `objection-curate/answer/approve/discard`, `voice-threads/build/apply-vN/discard-vN` |
| Sales | `board`, `conversion [dimension]`, `handoff <email>`, `prep <contact>`, `targets`, `account <domain>`, `evidence-conflicts`, `evidence-resolve-<id>`, `asset-list/add/remove` |
| Meetings | `meeting-held/noshow-<id>`, `meeting-notes-<id> <notes>`, `meeting-link-<id> <contact>`, `meeting-unlink-<id>`, `pov-request-<contact> <target>` |
| Ship and feedback | `ship-approve/reject-<id>`, `ship-risk-approve/reject-<id>`, feedback approve/reject |
| Link triage | `<url>`, `link-show/approve/reject/defer-<id>`, queue |
| Autonomy and goals | `autonomy-status`, `autonomy-set <class> <0-3>`, `goals`, `goal-set <amount> <date>`, `goal-retire <date>`, `knob-list/approve/reject` |
| System | `run-trace-<id>`, `system-halt [why]`, `system-resume` (no buttons on purpose), `/clean`, `/status`, `/help` |

### 26.2 Admin dashboard

A single-page app over an authenticated WebSocket RPC (default-deny; only `connect` and `health` are public).

| View | Panels | Actions |
|---|---|---|
| Overview | System status, active agents, contact base, pipeline value, cost today, security posture, infrastructure | |
| GTM cockpit | Cold outreach state, per-domain send cap, accounts at weekly cap, deferred queue, pending monitor hits, outreach 7 days (sent, bounced, replied, engaged, won, auto transitions), discovery 14 days (ingested, qualified, promoted, rejected, top query), recommendations, today's moves | Pause with reason, resume, drain monitor hits, replay deferred |
| Pipeline | Kanban across stages, total pipeline, weighted forecast, win rate | Create, update, transition |
| Inbound | Totals, new, drafts ready, email list | Archive, ignore, send draft (bound to the text shown) |
| Agents | Hierarchy, models, tool counts, 30-day runs, self-improvement systems | |
| Chat | Streaming chat with the hub | Send, abort |
| Activity | Audit trail | Export, live stream |
| Learnings | Pending proposals, overrides today, nudges today, last trajectory export, MCP servers, full-text session search | Approve or reject proposals, search |
| Link triage | Readiness, flow, routing destinations, spend, recent links | Refresh |
| Settings | Configuration, cron schedule, feature flags, integrations, storage, capabilities, security architecture, security audit | Run audit |
| Changelog | Every release with search and area filter | |

RPC methods: connect, status, health; chat send/history/abort; pipeline summary/deals/create/update/transition; contacts query/get/update/stats/next/log/summary; agents list/status/task; activity list/stream; security audit; inbound list/action/draft send/stats; config get; cost summary; fitness trend; GTM cockpit/pause/resume/drain/replay; link-triage status; learning summary/list/approve/reject/MCP list/history search.

### 26.3 HTTP surface

| Route | Auth |
|---|---|
| `GET /health` | none (detail mode runs checks) |
| `GET /api/v1/runs/:id` | bearer |
| `GET /api/v1/agents` | bearer |
| `POST /api/webhooks/operator` | channel secret + chat allowlist |
| `POST /api/webhooks/mail` | shared secret |
| `POST /api/webhooks/email` | email provider signature (Svix-style HMAC) |
| `GET/POST /u/:token` | signed unsubscribe token |
| `GET/HEAD /b/:token` | signed booking token |
| `POST /api/webhooks/product` | HMAC |
| `POST /api/webhooks/git` | HMAC |
| `POST /api/webhooks/deploy` | HMAC |
| `POST /api/webhooks/billing` | billing signature |
| `POST /api/webhooks/search/:id` | per-monitor HMAC |
| `/admin/*` | static assets behind your access layer |
| `/ws` | token in `connect` |
| `email()` entry point | Cloudflare Email Routing invokes it directly; no HTTP route |

Every `/api/*` route except the webhooks takes the bearer token; every webhook verifies its own signature. Body limit 100 KB.

---

## 27. Scheduling

Scheduled jobs run from a single per-minute cron trigger. Each minute the scheduled handler, a loop over the job registry rather than a switch statement, dispatches every job whose schedule is due. All jobs are wrapped in the fault-tolerant runner and are halt-aware. Times are UTC. (On Cloudflare, numeric day-of-week counts 1 as Sunday, so Monday to Friday is `2-6`; the job registry accepts named days only, such as `MON-FRI`.)

The table shows the intended cadence. Each per-topic document lists its jobs' exact default schedules, and every job's schedule can be changed through its options.

| When | Jobs |
|---|---|
| Every minute | Inbound monitor; batch release valve; on-demand batch; link-triage drain |
| Every 5 min | Event spine sweep |
| Every 10 min | Durable run sweep |
| Every 15 min | Calendar sync, proof-of-value poll, inbound sweep, mailbox draft reconcile, triage backfill, draft backfill, reply clock, contacted-deal backfill, account fit scoring |
| Hourly | Send-slot replay (:05), seed placement and batch quality check (:35), log retention (:50) |
| Daily 04:00 | Trajectory export, lifecycle reconcile, MRR snapshot, journal and payload retention, date normalization, prescore, person-fit sweep, intent scoring, stale draft expiry, memory maintenance, blocker detection |
| Weekdays 07:00 | Agent review, daily coordination |
| Daily 08:00 / 08:30 | Retrospective / backup; mail watch renewal |
| Daily 09:00 | Product feedback and ship cycle |
| Weekdays 09:00 | Memory, follow-up sweep, subject auto-promote, account facts, job changes, hiring boards, account profiles, deal velocity, bounce monitor, verification backfill, deferred replay, task archival, experiment cycle, monitor hits, funding feed, list-agent polling, coverage fill, discovery cycle, pipeline review, blocker detection |
| Daily 10:30 / 15:30 | Cron health checks |
| Weekdays 12:00 | Scorecard, morning briefing |
| Mon to Thu 01:00 / 17:00 | Deferred replay and follow-up sweep (APAC and US afternoon windows) |
| Mon to Thu 13:00 | Cold batch, follow-up sweep |
| Weekdays 14:00 | Follow-up sweep, liveness, deferred replay, memory, experiments, blocker detection, engagement, multithread, re-engage carry, signal response, stage stall, quiet threads, digests, stale sequences |
| Saturday 14:00 | Stale sequences |
| Sunday 14:00 | Weekly result, session mining, voice drift, self-review, weekly digest, link-triage drop digest |
| Monday 06:00 | Wiki, persona rates, brain diff, lookalikes, websets, filings, list-agent segments, lookalike weights, benchmark, evolution, renewal, referral and cold-referral sweeps, account sync, playbooks, weekly plan, autonomy review, target-accounts page, account expert, re-source |
| Monday 09:00 | Websets sweep, funnel digest, social signals, hiring/leadership signals |

---

## 28. Reliability

- **Fault-tolerant runner:** every job runs in a wrapper that classifies errors (transient vs bug), counts failures per job, pages the operator once per job per UTC day, escalates after 3 failures or a 3-day streak, and never lets one job's failure stop the next. Jobs due in the same minute run sequentially.
- **Execution runs table** records every job run with status, duration and error; health checks read it.
- **Cron health:** twice a day, verify each critical job ran after its expected hour; re-run the ones that can be safely re-run.
- **Blocker detection:** expire drafts stuck in approval for 48 hours, pause idle campaigns, find actions with repeated errors, find experiments past their max duration and evaluate them.
- **Idempotency everywhere:** daily keys with a TTL slightly longer than the interval; set the key **before** a send, not after (a crash suppresses a day; a double send to 1,000 people cannot be undone); the effects ledger for once-only work; provider idempotency keys as a second line.
- **Webhook plus polling** for every real-time input.
- **Fail-open bookkeeping** with counted failures, so missing writes are visible.
- **Audit log** with a fallback chain (DB, then blob, then KV) and a full-text index.

---

## 29. Testing, evals and CI

- **Unit and regression tests** for every gate, scorer, allocator, parser and state machine. Pin load-bearing constants with tests.
- **Security property tests:** every tool classified; unknown tools are full taint; gates never loosen as taint rises; every taint source is fenced; redaction keeps surrounding bytes; data-carrying URLs refused at full taint; halt and kill switch fail closed; approvals bound to digests.
- **Behavioral evals** run before every commit: citations, identity-document constraints, content rules, outbound writers, send/answer decisions, injection resistance, taint kill switch, structured output conformance. A live tier runs against real models.
- **Outbound writer registry:** every module that writes text to a prospect is listed with an eval. Scorers: no house-rule characters, lint passes, no numbers absent from the inputs, length bounds. Autonomy promotion requires a registered eval for the class's writer.
- **Pre-commit hook:** reject stray conflict copies, secrets scan, digest-source check, typecheck, lint, tests, evals. Never bypass it.
- **CI:** typecheck, tests, lint, dependency audit plus secrets scan, evals, build.

---

## 30. Configuration reference

Every behavior that can surprise someone is a flag in KV, default off or conservative. [registry.ts](../packages/core/src/flags/registry.ts) defines every flag, and `gtm doctor` lists each one with its state. A representative set:

| Flag | Default | Effect |
|---|---|---|
| `system:halt` | unset | Stops everything |
| `outreach:cold-pause` | unset | Kill switch value, warning severity (automation may set and lift it) |
| `outreach:cold-pause:critical` | unset | Kill switch value, critical severity (only a person lifts it) |
| `delivery:enabled` | off | Master switch for the send function's actual send |
| `delivery:domain_daily_cap` | 500 | Messages per UTC day through the email provider |
| `delivery:account_weekly_cap` | 3 | Cold and sequence messages per recipient account in any 7 days |
| `cold_batch:enabled` | off | Master switch for the cold batch |
| `cold_batch:auto_approve` | off | Send passing drafts without release |
| `cold_batch:daily_limit` | unset | Can only lower the ramp level |
| `cold_batch:run_now` | unset | On-demand batch |
| `quality:model_review_enabled` | off | Model reviewer in the quality gate; off, nothing is approved automatically |
| `outreach:ramp_level` | 0 | Warm-up level index |
| `outreach:ramp_auto` | off | Let the ramp job move the level on delivery evidence |
| `outreach:min_email_confidence` | medium | Cold verification floor |
| `outreach:holdout_rate` | 0.05 | No-send holdout share |
| `outreach:allocation_mode` | weighted | `thompson` selects Thompson allocation (section 14.4) once experiments are built; until then every value runs as weighted rotation |
| `outreach:send_time_experiment` | off | Send-time test |
| `outreach:seed_inboxes` | unset | Seed inbox list |
| `outreach:ref_tokens_enabled` | off | Attribution tokens on product links |
| `intent_score:enforce` | off | Intent score filters selection |
| `fit:prescore_enabled` | off | Free nightly account prescore |
| `fit:scoring_enabled` | off | Model fit scoring |
| `fit:score_top_n` / `fit:score_per_run` | 1000 / 20 | Fit scoring scope |
| `discovery:enabled` | off | Master switch for the discovery cycle |
| `discovery:enrich_per_cycle` / `discovery:qualify_per_cycle` | 40 / 20 | Discovery throughput |
| `discovery:email_waterfall_enabled` | off | Waterfall steps 2 to 5 |
| `enrichment:second_provider_enabled` | off | Waterfall step 5 |
| `enrichment:job_check_enabled` / `enrichment:job_check_required` | off | Job-change checks / hold unchecked |
| `discovery:<source>_enabled` | off | Each additional sourcing path |
| `verification:promotion_policy` | strict | `allow_risky` also promotes accept-all addresses |
| `verification:backfill_daily` | 50 | Nightly verification volume |
| `signal_response:auto_send` | off | Signal fast lane |
| `inbox:enabled` | off | Inbox intake: poll, sweep, push and Email Routing |
| `replies:triage_enabled` / `replies:drafting_enabled` | off | Reply triage and routing / reply drafts for approval |
| `replies:send_enabled` / `replies:mirror_enabled` / `replies:reminders_enabled` | off | Approved reply sends / mailbox draft mirroring / the reply-owed clock |
| `inbound:auto_send_tier` | off | Reply auto-send tier (reserved; every reply needs approval until it is built) |
| `sequences:enabled` | off | Master switch for the cold sequence's follow-up steps |
| `sequences:reply_intake` | poll | How follow-ups know the inbox is recording: `poll` or `routed`; anything else holds every step |
| `followup:manual_channel_enabled` | off | Manual LinkedIn/X step |
| `followup:multithread_enabled` | off | Colleague after silence |
| `followup:reengage_enabled` | off | Re-engage on new signal |
| `convert:calendar_enabled` | off | Calendar sync |
| `convert:booking_redirect_enabled` | off | Booking links served through the deployment (nothing recorded per contact) |
| `convert:pov_enabled` | off | Proof-of-value requests |
| `operator:agent_enabled` | off | The operator chat agent |
| `ops:daily_scorecard` | off | Scorecard replaces digests |
| `ops:target_accounts_page` | off | Weekly target-accounts page |
| `ops:retention_enabled` | off | Archive and delete old logs |
| `runs:durable` | off | Journaled, resumable runs |
| `security:structured_taint` | off | Structured taint extractor |
| `ship:enabled` | off | Ship loop |
| `budget:daily_limit_cents` / `budget:monthly_limit_cents` | 2000 / 50000 | Global budget |
| `budget:enforcement` | soft | `hard` blocks at limit |
| `budget:alert_threshold` | 0.8 | Share of a limit that triggers an alert |
| `budget:job:<job>:daily_cents` | per job | Always enforced |
| `budget:run_ceiling_cents` | 1000 | Delegated run ceiling |
| `chat:turn_max_cents` | 50 | Chat turn ceiling |
| `autonomy:<class>` | 1 | Autonomy level |
| `classifier_tier:<call_site>` | off | Cheap classifier per call site: `off`, `shadow` or `on` |

Configuration in `gtm.config.ts`: send window days and hours, the sending domain and addresses, the postal footer, the booking URL (`sending.bookingUrl`), enabled adapters (the outbound provider among them) and model ids per role. Secrets and vars: the unsubscribe signing key (`UNSUBSCRIBE_SIGNING_KEY`) and the base URL (`AGENT_BASE_URL`).

---

## 31. Build order

Each phase is deployable and useful on its own. [ROADMAP.md](ROADMAP.md) tracks these phases as milestones and says which are done.

| Phase | Build | Done when |
|---|---|---|
| 0. Foundation | Worker, DB with contacts and audit log, one agent, 3 tools, bearer auth, operator bot | A task returns research and a draft |
| 1. Safety spine | Taint model, sanitize and fence, rate limits, halt, suppression, effects ledger, fault-tolerant runner, budget gate | An injected page cannot cause a send |
| 2. Sourcing and enrichment | Search, structured search, candidates pipeline, finder and verifier, identity rules, fit gate, prescore | Qualified contacts appear daily with verified work emails |
| 3. Outreach | Templates, variables, quality gate, cold batch with manifest approval, ESP with webhooks, unsubscribe, send window, deferred queue, ramp, bounce monitor | A batch goes out, delivery is recorded, a bounce suppresses |
| 4. Replies | Push and poll detection, classification, triage, routing, drafting, freshness, reply clock, mailbox draft mirror | A reply is triaged and drafted within minutes and nagged until answered |
| 5. Measurement | Ledger, positive-reply definition, scorecard, conversion report, measurement health | Every report agrees on the numbers |
| 6. Sequences | Threaded steps, stop rules, follow-up sweep | Follow-ups thread and stop on any reply at the account |
| 7. Experiments | Thompson allocation, account clustering, holdout, pre-registration, copy-change gate | An experiment concludes honestly |
| 8. Convert | Booking link, calendar sync, reminders, no-show, post-demo, deal mirror | A booked meeting stops outreach and creates a brief |
| 9. Lifecycle | Product bridge, state machine, billing, MRR, erasure | Signups and payments move contacts and deals |
| 10. Autonomy | Levels, evidence, promotion proposals, demotion, evals registry | A class earns L2 from evidence |
| 11. Signals and scale | Additional sources, signal carry, intent score, angles, coverage fill, multithreading | Most first touches carry a dated reason |
| 12. Self-improvement | Retrospective, review, learnings proposals, voice, edit mining, brain | The system proposes better copy and you approve it |
| 13. Ship loop | Themes, specs, sandbox, path policy, PRs, deploy detection | A feature request becomes a PR you review |
| 14. Dashboard | WebSocket gateway and views | The operator runs the day from two screens |

---

## 32. Lessons learned

1. **Cron day-of-week numbering differs by platform.** On Cloudflare, `1-5` meant Sunday to Thursday. Use named days and check which days actually fire.
2. **Never put model calls in a per-minute job.** 1,440 runs a day turns cents into real money.
3. **Taint must cross delegation boundaries.** A tainted hub delegating to a clean worker is a confused deputy.
4. **Rate-limit and budget-check before the call, not after.**
5. **Documents injected into prompts need pruning or caps,** or they outgrow the context window in weeks.
6. **Cheap models make expensive mistakes on writes.** Use small models for classification, not for writing production data.
7. **Cache auth tokens with explicit expiry, not in module scope.** Service-account tokens expire in an hour.
8. **Domain-wide delegation must list every scope you request.** A new scope (for example calendar read-only) fails with `unauthorized_client` until an admin adds it. Surface the provider's error code in job errors so this is obvious.
9. **Dedup TTLs should match the upstream retry window** plus a margin.
10. **Single events are noise.** Require a minimum sample before a learning is stored at high importance.
11. **Config tools can silently ignore unknown fields.** Verify new bindings in deploy output.
12. **Enforce one-change-per-cycle structurally** (schema), not just in the prompt.
13. **Verify webhook signatures before returning 200;** process after.
14. **Flag every behavior change** and deploy dark first.
15. **Several title classifiers will disagree.** Have exactly one.
16. **Count declines and opt-outs differently.** A permanent ban on a polite "not now" throws away accounts.
17. **Link scanners prefetch.** An unsubscribe GET must never act.
18. **Account-level spillover ruins A/B tests** unless colleagues share an arm.
19. **Editing a template invalidates its history.** Key evidence on a hash of the current copy.
20. **The operator will edit in their inbox, not your UI.** Mirror drafts there and learn from the diff.
21. **A reviewer outage must stop sends,** not wave them through.
22. **Trust in the system comes from approvals that mean exactly what was shown.**
23. **Long chat turns die inside webhooks.** Move them to a queue with a longer budget.
24. **Make every gate's input read fail closed, and test that it does.**

---

## 33. Adapting to your domain

The example column uses Acme, the fictional developer-tools company in [examples/brains/acme](../examples/brains/acme/). It sells a product that detects and quarantines flaky tests in CI.

| What varies | Example: Acme (fictional) | In yours |
|---|---|---|
| Buyer accounts and contacts | Software companies with 30 to 300 engineers; engineering leaders and senior engineers | Any account-based market: companies and their buying committee |
| Buying roles | Economic buyer (VP Engineering), platform champion (Staff Engineer), quality lead, security reviewer | Your buying roles (economic buyer, champion, user, blocker), in the brain's `personas` |
| Fit rubric | Engineering team size, CI on every pull request | Your ICP rubric; keep "no tools, schema-bound, disqualifier caps the score" |
| Signals | Hiring platform engineers, a new engineering leader, a funding round, a move to a monorepo | Your triggers: funding, hiring for a role, leadership change, tech adoption, expansion, compliance deadlines, product launches |
| Hiring boards | Platform, build and test-infrastructure roles | Hiring for the role that uses your product |
| Proof of value | A report of the flaky tests in a prospect's own pipeline | Your product's fastest demonstration of value |
| Product bridge events | Repository connected, plan limit reached | Your activation and limit events |
| Plans and prices | Team, Business and Enterprise plans | Yours, in the brain's `commercial` component, served only to the strategist and close tasks |
| Sending paths | Cold path on an email provider subdomain, warm path on the workspace mailbox | Same pattern with your providers |
| Operator channel | Telegram, the included adapter | Slack, Discord or SMS, through an operator channel adapter |

**Transfers unchanged:** the taint model, quality gate structure, approval digests, effects ledger, ledger-based measurement, Thompson allocation with account clustering and holdout, pre-registration, the copy-change gate, earned autonomy, the reply routing table, the freshness check, the reply-owed clock, the calendar privacy rule, the lifecycle state machine shape, the event spine, erasure with tombstones, the fault-tolerant runner and cron health, and the ship loop's sandbox and path policy.

**Needs domain work:** the targeting brief and brain files, the fit rubric, title rules, signal sources and their regexes, templates and copy lines, reply facts and assets, the product bridge event types, pricing, and the legal basis for contacting people in each market you sell to.
