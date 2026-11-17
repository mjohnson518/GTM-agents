# Changelog

This page is for adopters and deployers: what each release of GTM-agents contains. Every `@gtm-agents` package moves to the same version together ([docs/RELEASING.md](docs/RELEASING.md)), and a deployment changes only when its owner moves that version ([docs/DEPLOYING.md](docs/DEPLOYING.md#upgrading-to-a-new-version-of-the-toolkit)).

The file follows the format the operator dashboard's Changelog view reads: `## <version>` starts a release, `### <area>` starts an area, and each `- ` line is one entry. A deployment that keeps a copy in its static assets directory sees it in the dashboard ([docs/DASHBOARD.md](docs/DASHBOARD.md)).

## Unreleased

### Fixes

- The self-improvement checks (brain edits, snippets, the competitor watch's note, defanged examples) and the meeting-notes quote filter now catch every link the outbound quality gate does, a bare host on any top-level domain (`globex-login.ru`, `acme.click/offer`) included, where they knew only a fixed list before, plus any URL scheme and a host joined to a path or a dash. The gate and the automatic-reply rules share one definition (`shared/links.ts`). A brain edit is checked only on the fields it changes, so text already served never blocks it, and a discovery query may name a product such as "Next.js".
- A proposer keeps at most one brain or voice file pending per component: a newer one supersedes the older (expired, "superseded by <id>"), so reviewing the same component twice on the Product and ICP page no longer leaves two versions waiting ([docs/LEARNING.md](docs/LEARNING.md)).
- A competitor digest sent again after a failed one names the week's pending proposal again, and a database error during the competitor watch now stops the run and gives its claims back instead of counting as a failed search.
- `watch-list` shows every pinned account, marking one whose name is too generic for the watch to match.
- `@gtm-agents/core` pins `hono` 4.13.16, which fixes five moderate advisories in earlier versions (routing, `mount()`, `css`, `csrf()` and form validation). The Worker uses none of the affected `mount()`, `css`, `csrf()` or validator helpers, and a new test checks that the token check on `/api/*` still applies to paths holding an encoded line terminator.

### Getting started

- `gtm brain init` asks seven short batches of questions and writes draft `personas`, `icp`, `message-pillars`, `facts` and `voice` files, every one `status: draft`. A skipped answer is never filled, an existing file is never overwritten, and the company, sender, booking and send-window answers are printed as `gtm.config.ts` lines to paste. `--answers <file.json>` and `--questions` let a coding agent run the interview in chat ([docs/BRAIN-SCHEMA.md](docs/BRAIN-SCHEMA.md#starting-from-an-interview)).
- A Claude Code plugin, `gtm-agents`, published from this repository: skills to write a brain from an interview, read `gtm doctor`, turn on the staged rollout one capability at a time, run the day and add an adapter. They never handle a secret and never approve for you. Install it with `/plugin install gtm-agents --marketplace mjohnson518/GTM-agents` ([docs/QUICKSTART.md](docs/QUICKSTART.md#with-a-coding-agent)).
- `renderBrainFile` moves to `@gtm-agents/core/brain` (still exported from `@gtm-agents/core/learning`) and takes an optional `status`.

### Watches and briefs

- The account watch, behind `signals:account_watch_enabled`: every Monday, one dated news search for each of up to 10 accounts (pinned with `watch-add`, then open deals past contacted, then the best fit), within 50 cents a day. New items go to you in one digest with their links, each listed once ever; funding and leadership items also become signals ([docs/SIGNALS.md](docs/SIGNALS.md#account-watch)).
- The competitor watch, behind `signals:competitor_watch_enabled`: every Monday, news and public open-role counts for each competitor in the brain, in one digest. With `signals:competitor_proposals_enabled`, a week with news makes at most one proposed `competitors` edit (at most 3 items, checked for links, dashes, instructions and figures the brain does not hold), which you approve against its exact diff and which never applies on its own.
- Competitor items in the brain take an optional `domain`, for the open-role counts ([docs/BRAIN-SCHEMA.md](docs/BRAIN-SCHEMA.md)). The Acme example brain sets one.
- Prep briefs can show the account's research facts with their sources, marked unverified, behind `convert:brief_research_enabled` ([docs/CONVERT.md](docs/CONVERT.md)).
- `watch-add`, `watch-remove` and `watch-list` in the chat pin the accounts the watch covers first ([docs/OPERATOR.md](docs/OPERATOR.md#commands)).

### Meeting notes

- Meeting notes, behind `convert:notes_enabled`: the new `meeting_notes_ingest` job reads recordings from Fathom or Granola hourly and keeps one only when an invitee is a known contact (never internal meetings or strangers), storing its transcript in `BUCKET` for a year; `meeting_notes_extract` makes one `worker`-role call per call recorded (100 cents a day) and keeps pain points, objections, next steps and competitors only as quotes found word for word in the transcript. They show in your prep and handoff briefs, kept apart from your own notes; objections are filed for you to answer; and Monday's digest names competitors mentioned on calls. With `convert:notes_in_recap`, recap drafts add the agreed next steps, quoted, and wait for your review. Needs migration 0038 ([docs/MEETING-NOTES.md](docs/MEETING-NOTES.md)).
- Two adapters, `notes-fathom` and `notes-granola`, for the new `MeetingNotesProvider` port. The template lists both disabled.
- Erasure now also deletes a person's meeting transcripts, and objections filed from their words (from calls, and from replies, where they were kept before) lose those words: unapproved ones are deleted, approved ones keep your answer.

### Sourcing and signals

- A new adapter, `data-leadmagic` (ContactFinder, EmailVerifier and the new EmploymentChecker port), for LeadMagic. The template lists it disabled; enable it and put `LEADMAGIC_API_KEY`. Once enabled it is the second finder in the email waterfall, after Hunter, behind the existing `discovery:email_waterfall_enabled`; it charges only for an address it validated. A `VERIFIER` constant in `src/index.ts` chooses which adapter verifies: Hunter by default, or LeadMagic, which is cheaper but reports accept-all domains as unknown, so `allow_risky` has no effect with it ([docs/SOURCING.md](docs/SOURCING.md#choosing-the-verifier)).
- Employment checks, behind `signals:job_change_enabled`: the new `signal_employment` job checks up to 10 contacts with a profile URL each weekday, warmest first, about 6 cents each, within 60 cents a day. A contact who moved is marked `moved`, so the cold batch and sequences stop mailing a dead address, and you are told about a warming or warmer one; a current role begun in the last 90 days becomes a `job_change` signal for the new-role angle ([docs/SIGNALS.md](docs/SIGNALS.md#employment-checks)).
- Champion moves, behind `signals:champion_moves_enabled`: an engaged, hot or customer contact who moved is looked up at their new employer, and a clean work address there becomes a candidate that the discovery cycle verifies, qualifies and promotes like any other. Erasure follows the person to both addresses ([docs/SIGNALS.md](docs/SIGNALS.md#champion-moves)).

### CRM mirror

- A one-way CRM mirror, behind `crm:mirror_enabled`: every 15 minutes the new `crm_mirror` job copies contacts and their companies into the CRM, with our own activity as dated notes (emails sent, replies by intent only, meetings booked and held, deal stage changes). It never sends inbound text, writes nothing more about a person who opted out or is suppressed (one note records an opt-out), and on erasure tells you which CRM record to delete instead of deleting it. At most `crm:mirror_per_run` (100) rows a run; no model calls and no spend. Needs migration 0037 ([docs/CRM.md](docs/CRM.md)).
- A new adapter, `crm-attio` (CrmSink), for Attio: companies upserted on their domain, people on their address with a company reference, activity as plain-text notes. The template lists it disabled; enable it and put `ATTIO_API_KEY`. `CrmSink.upsertContact` gains an optional `accountExternalId`, and `logActivity`'s `contactId` is the CRM's record id.

### Product and ICP

- The Product and ICP page suggests search queries and personas, behind `targeting:suggest_enabled`: one `worker`-role model call reads only the approved `product` and `icp` (and the served `personas` and `keyword-portfolio`, so it does not repeat them) and suggests up to 8 queries and 4 personas. Every item is filtered (the brain's schema, links, dashes, prices, instructions, repeats, and never-list companies, domains and titles, with the reason shown). You pick suggestions, edit their main text, and approve each component as every served item plus your picks, through the ordinary brain proposal path; a proposal can never drop or change what is served. At most `targeting:suggestions_daily_max` (5) suggestions and 50 cents a day, under the job `targeting_suggest`. Needs migration 0036 ([docs/TARGETING.md](docs/TARGETING.md#suggested-search-queries-and-personas)).
- A readiness card on the same page says what discovery and fit scoring have to work with: which of `product`, `icp`, `personas` and `keyword-portfolio` are approved, whether the sourcing brain loads whole, whether `discovery:enabled`, `fit:scoring_enabled` and `enrichment:research_enabled` are on, and what each missing piece costs.

### Sourcing

- A candidate with no work address is no longer marked `qualified`. Before, one with a good enough name, title and account fit qualified anyway, then waited for good: promotion needs an address and nothing looks for one again, and no reason was recorded, so the funnel digest never counted it. Qualify now rejects it with the new reason code `no_email` (or `person_fit_maybe` when enrichment skipped the lookup for an undecided title), and promotion rejects any candidate already left `qualified` without an address the same way, so a deployment's backlog of them is cleared on its next run ([docs/SOURCING.md](docs/SOURCING.md#reject-reasons)).

## 0.2.0 (2026-11-16)

A Product and ICP page that drafts your product description and ideal customer profile from your own site for you to approve, an operator chat that batches messages, keeps timers and notes and respects quiet hours, sharper copy checks, cleaner sourcing reports, two new signal and research sources, and a DNS check for the sending domain. As in 0.1.0, everything is covered by hermetic tests and nothing has yet been run against live providers; every new capability ships behind a flag that defaults to off. Upgrading applies migrations `0030` to `0035` (`gtm migrate`, or `gtm deploy`, which migrates first), and `gtm brain upload` now stops rather than undo a brain change approved in the dashboard: run `gtm brain pull` first ([docs/TARGETING.md](docs/TARGETING.md#keeping-your-brain-folder-in-step)).

### Product and ICP

- A Product and ICP page in the dashboard, behind `targeting:enabled`: describe your product and your ideal customer as the `product` and `icp` brain components, edit them item by item, and approve each one against its exact diff through the ordinary brain proposal path. With `targeting:draft_enabled` on and a model gateway wired, it drafts both from your own site (the URL and up to three more pages on the same domain, read with `web_fetch`'s rules) or from pasted text, in one `worker`-role call under a fixed rubric with the site fenced as untrusted. Every drafted item is filtered (links, prices, dashes, customer names, instructions, text copied from the site, and every `never` item are left out, with the reason shown), the served ICP's hard stops are kept (an ICP that leaves one out needs it confirmed), and nothing drafted is served until a person approves the exact file. At most `targeting:drafts_daily_max` (10) drafts and 100 cents a day, under the job `targeting_draft`. Needs migration 0035; approving needs `learningDashboard()` in `createWorker`, which the template wires ([docs/TARGETING.md](docs/TARGETING.md), [ADR-012](docs/DECISIONS.md#adr-012-brain-text-drafted-from-the-operators-own-site)).
- A new optional brain component, `product` (kinds `summary`, `problem`, `capability`, `outcome`, `use_case`, `differentiator`, `not_for`), read only by the `fit` and `strategist` slices within its own 1.5 KB allowance, after their other components. A brain without it gets exactly the slices it got before, and the template writers never read it. `TaskSpec` gains `optional` and `optionalBytes`, with `taskComponents` and `budgetFor` ([docs/BRAIN-SCHEMA.md](docs/BRAIN-SCHEMA.md#byte-budgets)).
- `gtm brain pull` writes the brain the deployment serves into your brain folder, and `gtm brain upload` stops when the deployment serves a component at a newer version than your file, or one your folder lacks, or one at the same version with other content, so an approval made in the dashboard is never silently undone (`--force` replaces it). `applyBrainEdit` now refuses to replace a component listed in the lock whose served bytes do not match it. The `web_fetch` tool's reading rules are shared as `fetchPublicPage` ([docs/DEPLOYING.md](docs/DEPLOYING.md)).

### Operator chat

- Messages sent in a row can share one hub turn, behind `operator:chat_batching`: adjacent messages for the model in one chat queue delivery, from the same operator in the same session, are joined by a blank line into one turn with one reply and one turn ceiling, up to 8,000 characters. Commands always run alone and in their place, and each message is still claimed once. The flag needs `max_batch_size` above 1 on the chat queue's consumer; the template keeps 1, so nothing changes until a deployment raises it and turns the flag on ([docs/OPERATOR.md](docs/OPERATOR.md#messages-sent-in-a-row)).
- Timers the agent sets for itself, behind `operator:timers_enabled`: the new `timer_set` tool schedules a later turn in the same chat, 5 minutes to 14 days out, and `/timers` lists and cancels them. A timer's turn starts at least as tainted as its session was when the timer was set, `timer_set` is refused once a session has read a web page, and a `/clean` since cancels the timer. The per-minute `operator_timers` job queues due timers without a model call, at most `operator:timers_daily_max` (20) a day. A timer carrying taint cannot set another. Needs migration 0031 and the `operator_timers` job in the Worker's `jobs` (`createOperatorTimerJobs` from `@gtm-agents/core/operator`; the template adds it): without the job, `timer_set` is never offered. Erasing a person also deletes timers whose note mentions them ([docs/OPERATOR.md](docs/OPERATOR.md#timers)).
- A timer that expires without running (more than 6 hours late, its message lost, or no model gateway) is reported to its chat as one notice per chat, with its id, due time, reason and the first line of its note. `createOperatorTimerJobs` takes an optional `operator` channel factory for this, which the template passes; a Worker entry written before passes `{ operator }` too, or its timers keep expiring unannounced. `expireLateTimers` now returns the timers it expired instead of a count ([docs/OPERATOR.md](docs/OPERATOR.md#timers)).
- Notes the agent keeps across sessions and `/clean`, for the whole deployment, behind `operator:notes_enabled`: `note_save` saves a short fact or preference, `notes_read` reads one by id, and `/notes` lists and forgets them, in the operator chat and the dashboard. A note keeps the taint of the session that saved it: notes saved with no taint are shown in every turn, any other only by id until it is read, which raises the reader to at least `metadata`. At most 50 notes, 10 of them tainted, and 3 saves a turn. `note_save` is refused once a session has read a web page. Needs migration 0032; erasing a person deletes the notes that name them ([docs/OPERATOR.md](docs/OPERATOR.md#notes)).
- Quiet hours and pacing for operator notices, behind `operator:outbox_enabled`: `withOperatorOutbox` wraps the operator channel, holds notices during the new `operator.quietHours` (whole hours in the operator's time zone) and over `operator:outbox_hourly_max` (12) a chat per UTC hour, and retries notices Telegram refuses with a retryable error for a day (pages for a week). The `operator_outbox` job, every five minutes with no flag and no model call, delivers held notices folded into one message per chat. Replies to the operator are never held; pages and approval requests arrive at once, silently in quiet hours. `/outbox` lists what is held and `/outbox send` releases it. A lifecycle follow-up preview the outbox holds never counts as shown, so `fu-approve` shows it first. The operator port gains `OperatorMessage.kind` and `ApprovalRequest.silent`, which `operator-telegram` honors. Needs migration 0033, and a Worker entry written before this wraps its `operator` factory and adds `createOperatorOutboxJobs` (the template does both). Erasing a person deletes held notices that name them ([docs/OPERATOR.md](docs/OPERATOR.md#quiet-hours-and-the-outbox)).
- The chat consumer puts each chat's messages in a delivery back in the order they were sent (by the channel's message id) before anything runs, so a `/clean` between two tasks stays between them, with or without `operator:chat_batching`. It also starts no run once 10 minutes of a delivery have passed: the messages it has not reached go back to the chat queue, unclaimed, instead of being cut off without a reply when a larger `max_batch_size` fills the invocation's 15 minutes. `gtm doctor` gains a chat queue check: a consumer for `CHAT_QUEUE`, `max_concurrency` 1, and, with `--remote`, a warning when `operator:chat_batching` is on while `max_batch_size` is 1 ([docs/OPERATOR.md](docs/OPERATOR.md#messages-sent-in-a-row)).
- The agent learns what you decided about its drafts, behind `operator:decision_lines_enabled`: approving or rejecting a draft that a chat or dashboard turn created, by a tap or in the dashboard, writes one line into the session that created it (the draft's id, kind and recipient, the decision and the time), which the next turn sees in front of your message. No model call is made. A session cleared since the draft was created gets nothing, and drafts no turn created (replies to inbound mail, meeting follow-ups) never write a line. `approveShownDraft`, `rejectDraftById` and `handleApprovalCallback` take an optional `flags` reader; without it, no line is written. The dashboard's chat history leaves the lines out. Needs migration 0034 ([docs/OPERATOR.md](docs/OPERATOR.md#decisions-in-the-session)).

### Sending

- A send window that opens in an hour the clocks skip now opens when the clocks jump, in every time zone. Before, zones west of UTC (the Americas) got an opening an hour early, outside the window, so that day's window was missed; nothing was ever sent outside a window, because the send function checks the window itself. In the hour the clocks repeat, the opening is now the first of the two everywhere. Operator quiet hours that end in a skipped hour end when the clocks jump, instead of up to an hour early or late ([docs/SENDING.md](docs/SENDING.md#send-windows-and-time-zones)).

### Outreach

- A cliché check in the quality gate, behind `quality:cliche_lint_enabled`: worn openers, empty nudges and buzzwords hold a draft with `LINT_CLICHE`, and phrases quoted in the brain's voice `dont` and `avoid` items hold it with `VOICE_AVOIDED` ([docs/OUTREACH.md](docs/OUTREACH.md#the-quality-gate)).

### Signals

- Article hits from search monitors can become funding and leadership signals at known accounts, by the news job's rules, behind `signals:article_monitors_enabled`; the same URL is recorded once across monitors and, on a best-effort basis, across monitors and the news search. The flag needs migration `0030` ([docs/SIGNALS.md](docs/SIGNALS.md#search-monitors)).

### Sourcing

- Every candidate that ends rejected, borderline or duplicate records a reason code in `attributes.reject_reason`, and the weekly funnel digest counts rejections by reason, source and query ([docs/SOURCING.md](docs/SOURCING.md)).
- The `data-exa` price table follows Exa's current list prices: $0.007 a request including 10 results, and $0.001 for each further result.
- Account research, behind `enrichment:research_enabled`: the `account_research` job researches accounts through `data-exa` (Exa's Agent API) best prescore first, at most once a calendar month each, and fills `account_facts` only with fields a source is cited for, each with its URL; the fit score's profile adds funding raised, technologies, last round date and hiring functions. Effort `medium` ($0.10 a run) by default, `low` ($0.025) through the `researchEffort` option, 300 cents a day ([docs/SOURCING.md](docs/SOURCING.md#account-research)).

### Deploying

- `gtm doctor --remote` checks SPF, DKIM and DMARC on the sending domain and reports them; nothing is blocked. Set `sending.dkimSelector` to include the DKIM check ([docs/DEPLOYING.md](docs/DEPLOYING.md)).

### Decisions

- ADR-011: LinkedIn and X touches stay manual ([docs/DECISIONS.md](docs/DECISIONS.md#adr-011-linkedin-and-x-touches-stay-manual)).
- ADR-012: Brain text drafted from the operator's own site ([docs/DECISIONS.md](docs/DECISIONS.md#adr-012-brain-text-drafted-from-the-operators-own-site)).

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
