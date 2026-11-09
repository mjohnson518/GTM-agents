// GTM-agents: the feature flag registry.
//
// Flags live in KV. Every behavior that could surprise someone is a flag that defaults to off or to
// a conservative value, so new capability ships dark and rollback is a flag delete. `gtm doctor`
// and `gtm flags list` read this registry to show every flag and its state.

export type FlagKind = "boolean" | "number" | "string" | "json";

export interface FlagDefinition {
  /** The KV key, or a pattern with <placeholders> for families of flags. */
  key: string;
  kind: FlagKind;
  /** The value used when the flag is unset. `null` means "unset" has its own meaning, described below. */
  default: string | null;
  description: string;
}

export const FLAGS: readonly FlagDefinition[] = [
  // System controls. Both fail closed: an unreadable value counts as halted or paused.
  { key: "system:halt", kind: "json", default: null, description: "Stops every scheduled job and every send, replies included. Unset means running; any value, or a read error, means halted. Only the operator sets or clears it." },
  { key: "outreach:cold-pause:critical", kind: "json", default: null, description: "A critical cold outreach pause: {reason, source, since}. Unset means no critical pause; a read error counts as paused. Only the operator sets or lifts it." },
  { key: "outreach:cold-pause", kind: "json", default: null, description: "A warning-level cold outreach pause: {reason, source, since}, which automation may set and lift. Unset means running; a read error counts as a critical pause." },

  // Cold batch.
  { key: "cold_batch:enabled", kind: "boolean", default: "false", description: "Master switch for the daily cold batch." },
  { key: "cold_batch:auto_approve", kind: "boolean", default: "false", description: "Send passing drafts without a release code." },
  { key: "cold_batch:daily_limit", kind: "number", default: null, description: "An operator limit that can only lower the warm-up ramp level." },
  { key: "cold_batch:run_now", kind: "boolean", default: null, description: "Run the cold batch on demand at the next minute." },
  { key: "outreach:ramp_level", kind: "number", default: "0", description: "Warm-up ramp level index." },
  { key: "outreach:min_email_confidence", kind: "string", default: "medium", description: "Verification floor for cold sends." },
  { key: "outreach:holdout_rate", kind: "number", default: "0.05", description: "Share of the ready window held out as a no-send control." },
  { key: "outreach:allocation_mode", kind: "string", default: "weighted", description: "Template allocation (docs/EXPERIMENTS.md). weighted: rotation by volume_weight. thompson: Thompson sampling with guardrails among general templates once every arm has 50 matured sends (a protected control of at least 20%, other arms at least 15%). Any other value, or a read error, is weighted." },
  { key: "quality:model_review_enabled", kind: "boolean", default: "false", description: "The model reviewer (judge role) in the quality gate. Off, or unavailable, nothing is approved automatically: drafts that would auto-send are held with REVIEW_UNAVAILABLE." },
  { key: "outreach:send_time_experiment", kind: "boolean", default: "false", description: "The send-time test (docs/EXPERIMENTS.md): each cold first touch's account gets a recipient-local slot, early (08 to 10) or afternoon (13 to 15), balanced within its time zone, and the send function narrows the window to it. Unreadable counts as off." },
  { key: "outreach:seed_inboxes", kind: "json", default: null, description: "Seed inboxes for placement checks." },
  { key: "outreach:ref_tokens_enabled", kind: "boolean", default: "false", description: "Attribution tokens on product links." },

  // Experiments (docs/EXPERIMENTS.md). No model calls; nothing applies a copy change without a person.
  { key: "experiments:enabled", kind: "boolean", default: "false", description: "Template experiments and subject tests enroll accounts in the cold batch, and the experiments_cycle job evaluates them twice a day and proposes copy changes through the copy-change gate. Off, or unreadable, nobody is enrolled and nothing is evaluated or proposed." },
  { key: "experiments:self_review_enabled", kind: "boolean", default: "false", description: "The weekly self-review (experiments_self_review, Sundays 14:00 UTC): at most three rule-based proposals a week (template weights, the holdout rate, the next signal source, the send-time test), each applied only by exp-approve-<id>." },
  { key: "experiments:control_template", kind: "string", default: null, description: "The protected control template for Thompson allocation and the copy-change gate. Unset, or not an active general template, the general template with the highest volume weight is the control." },
  { key: "experiments:template_weight:<template>", kind: "number", default: null, description: "State: a template's volume weight, written only when the operator approves a weight or promotion proposal. Unset, unreadable or malformed, the template file's volume_weight applies." },

  // Delivery: the provider boundary, the deferred queue, the warm-up ramp and the bounce monitor (docs/SENDING.md).
  { key: "delivery:enabled", kind: "boolean", default: "false", description: "Master switch for the send function's actual send. Off, or unreadable, nothing is sent: every item comes back as a retryable failure ([SEND BLOCKED:disabled]). Also gates the deferred replay and the bounce monitor jobs." },
  { key: "delivery:domain_daily_cap", kind: "number", default: "500", description: "Messages per UTC day through the email provider, from the sending domain (at most 10000). Overflow waits for midnight UTC; an unreadable value allows none." },
  { key: "delivery:account_weekly_cap", kind: "number", default: "3", description: "Cold and sequence messages per recipient account in any 7 days, enforced inside the send function (at most 50). An unreadable value allows none." },
  { key: "outreach:ramp_auto", kind: "boolean", default: "false", description: "Let the ramp job move the warm-up level (25, 50, 100, 250, 500 a day) on delivery evidence. Off, the level only changes by hand." },
  { key: "outreach:ramp_changed_at", kind: "string", default: null, description: "State: when the warm-up ramp level last changed, written by the ramp job and the bounce monitor." },
  { key: "delivery:breaker:<day>", kind: "json", default: null, description: "State: the provider circuit breaker for one UTC day, {consecutive, openedAt}. Three consecutive provider failures open it until midnight UTC; an unreadable record counts as open." },
  { key: "delivery:last_auto_resume", kind: "string", default: null, description: "State: when the bounce monitor last lifted a warning pause, kept 14 days. A spike inside that time pauses at critical." },

  // Scoring and sourcing.
  { key: "intent_score:enforce", kind: "boolean", default: "false", description: "Use the intent score to filter cold selection: only contacts in the first_touch band (80 and up) pass, and a missing score does not. Needs scoring:intent_enabled to compute the score." },
  { key: "fit:scoring_enabled", kind: "boolean", default: "false", description: "Model fit scoring for accounts." },
  { key: "fit:score_top_n", kind: "number", default: "1000", description: "Accounts in scope for fit scoring." },
  { key: "fit:score_per_run", kind: "number", default: "20", description: "Accounts scored per run." },
  { key: "fit:prescore_enabled", kind: "boolean", default: "false", description: "The free nightly account prescore (0 to 100) from data already held." },
  { key: "discovery:enabled", kind: "boolean", default: "false", description: "Master switch for the discovery cycle: search, enrich, qualify and promote." },
  { key: "discovery:searches_per_cycle", kind: "number", default: "5", description: "Paid searches per discovery cycle (at most 25)." },
  { key: "discovery:results_per_search", kind: "number", default: "10", description: "Results requested per search (at most 100)." },
  { key: "discovery:raw_backlog_max", kind: "number", default: "300", description: "Skip new searches while more raw candidates than this wait; the backlog still drains." },
  { key: "discovery:enrich_per_cycle", kind: "number", default: "40", description: "Candidates enriched per discovery cycle." },
  { key: "discovery:qualify_per_cycle", kind: "number", default: "20", description: "Candidates qualified per discovery cycle." },
  { key: "discovery:promote_per_cycle", kind: "number", default: "50", description: "Qualified candidates considered for promotion per discovery cycle (at most 100)." },
  { key: "verification:promotion_policy", kind: "string", default: "strict", description: "strict promotes only deliverable addresses; allow_risky also promotes risky (accept-all) ones. Any other value, or a read error, is strict." },
  { key: "discovery:email_waterfall_enabled", kind: "boolean", default: "false", description: "Email waterfall steps beyond the first finder." },
  { key: "discovery:<source>_enabled", kind: "boolean", default: "false", description: "Reserved for additional sourcing paths (signals, lookalikes, job boards), one flag each. The search sources a deployment wires in run whenever discovery:enabled is on." },
  // Signals and scale (docs/SIGNALS.md): one flag per source, all off by default; none of these jobs calls a model.
  { key: "signals:websets_enabled", kind: "boolean", default: "false", description: "Weekly websets (signal_websets): standing person searches with natural-language criteria, created weekly and polled on weekdays. Rows with a clean work address are inserted qualified at a fixed score; promotion still runs every check." },
  { key: "signals:monitors_enabled", kind: "boolean", default: "false", description: "Search monitors: POST /api/webhooks/search/:key records signed hits, and signal_monitor_drain turns up to 500 a run into raw candidates. Off, or unreadable, the webhook verifies the signature, then answers 503 and records nothing." },
  { key: "signals:news_enabled", kind: "boolean", default: "false", description: "Funding and leadership news (signal_news): fixed dated news searches over 30 days; a hit becomes a signal only with a published date and a URL, at a known account its title names." },
  { key: "signals:hiring_boards_enabled", kind: "boolean", default: "false", description: "Public job boards for high-fit accounts (signal_hiring_boards): open roles kept as counts per role kind, never titles; a hiring signal at most once per 90 days per account." },
  { key: "signals:lookalikes_enabled", kind: "boolean", default: "false", description: "Responder lookalikes (signal_lookalikes): companies similar to accounts that replied positively, booked meetings, signed up or pay; 30 raw candidates a run." },
  { key: "signals:coverage_fill_enabled", kind: "boolean", default: "false", description: "Coverage fill (signal_coverage_fill): up to 2 more people at fit 7+ accounts with fewer than 2 seats and a recent signal, reply or sign-up; 5 accounts a run, 30-day cooldown per account." },
  { key: "scoring:intent_enabled", kind: "boolean", default: "false", description: "The nightly intent score (intent_scoring), written to each cold contact's attributes. Shadow: it filters nothing unless intent_score:enforce is on." },
  { key: "enrichment:second_provider_enabled", kind: "boolean", default: "false", description: "The second-provider step of the email waterfall." },
  { key: "enrichment:job_check_enabled", kind: "boolean", default: "false", description: "Job-change checks for stale contacts." },
  { key: "enrichment:job_check_required", kind: "boolean", default: "false", description: "Hold stale contacts that have not been job-checked." },
  { key: "verification:backfill_daily", kind: "number", default: "50", description: "Addresses verified by the nightly backfill." },

  // Replies, sequences and convert.
  { key: "inbox:enabled", kind: "boolean", default: "false", description: "Inbox intake (docs/INBOX.md): the poll, sweep and watch renewal jobs, the push webhook's poll and Email Routing intake. Off, or unreadable, nothing is recorded or acted on: the push webhook verifies and acknowledges only, and routed mail is forwarded when a forward address is set, otherwise rejected." },
  { key: "inbox:cursor:<provider>", kind: "json", default: null, description: "State: a mailbox's poll cursor, {cursor, at}. A rebuildable cache: unset or unreadable, the poll lists the last day instead." },
  { key: "inbox:push_last", kind: "string", default: null, description: "State: when the last push-triggered poll started, so a burst of pushes runs one poll." },
  { key: "signal_response:auto_send", kind: "boolean", default: "false", description: "The signal fast lane." },
  { key: "inbound:auto_send_tier", kind: "boolean", default: "false", description: "Automatic replies (docs/AUTONOMY.md). A reply goes out without a person only with this on AND its class (reply_send or reply_demo_link) at level 2 or above AND replies:send_enabled and quality:model_review_enabled on, and then only when every auto-send rule passes. Unreadable counts as off." },
  { key: "replies:triage_enabled", kind: "boolean", default: "false", description: "Reply triage (docs/REPLIES.md): the triage model reads new human mail, and routing applies each intent's side effects (opt-out, deal stage, decline hold, referrals, objections, warmth, ledger credit, sequence stop). Off, or unreadable, nothing is triaged." },
  { key: "replies:drafting_enabled", kind: "boolean", default: "false", description: "Draft replies with the writer model after triage and ask the operator to approve each one. Nothing is sent by drafting." },
  { key: "replies:send_enabled", kind: "boolean", default: "false", description: "Send approved reply drafts from the warm mailbox, after freshness checks and every send gate (the replies_send job and /reply_send). Delivery also needs delivery:enabled." },
  { key: "replies:mirror_enabled", kind: "boolean", default: "false", description: "Mirror reply drafts into the mailbox as real drafts on their thread, and reconcile what the operator sent. Skipped when the mailbox cannot create drafts." },
  { key: "replies:reminders_enabled", kind: "boolean", default: "false", description: "The reply-owed clock: reminders at 15 minutes, 2 hours and 4 hours, then each morning, until a reply is answered; quiet threads surfaced once. No model calls." },
  { key: "sequences:reply_intake", kind: "string", default: "poll", description: "How replies reach the database, so the follow-up reply check knows it is not blind. poll (default): a step goes out only when inbox:enabled is on and the latest inbox poll completed in the last 10 minutes. routed: Cloudflare Email Routing only, where mail is recorded as it arrives; inbox:enabled alone is enough. Any other value, or a read error, holds every step." },
  { key: "sequences:enabled", kind: "boolean", default: "false", description: "Master switch for the cold sequence's follow-up steps (docs/SEQUENCES.md): the follow-up sweep, the stale-sequence check and the sequence-release command. Off, or unreadable, no follow-up is drafted or sent; replies still stop sequences." },
  { key: "followup:manual_channel_enabled", kind: "boolean", default: "false", description: "Ask the operator for a manual LinkedIn or X touch before the last step. Nothing is posted automatically." },
  { key: "followup:multithread_enabled", kind: "boolean", default: "false", description: "Write to a colleague after silence." },
  { key: "followup:reengage_enabled", kind: "boolean", default: "false", description: "Re-engage on a new signal." },
  { key: "convert:calendar_enabled", kind: "boolean", default: "false", description: "Calendar sync (docs/CONVERT.md): bookings found and attributed every 15 minutes, outreach to a booked contact's account stopped, the deal stepped to demo_scheduled, a prep brief, reminders at 24 hours and 1 hour, the held or no-show question, recap and rebook drafts, and the meeting commands. Off, or unreadable, nothing is read or changed. Nothing is ever sent but operator notices." },
  { key: "convert:post_demo_enabled", kind: "boolean", default: "false", description: "Draft the post-demo follow-ups on day 4 and day 10 after a held meeting, each for approval, once the recap is approved. They stop on any mail from the account, a suppressed address or a newer meeting. Never sent automatically." },
  { key: "convert:handoff_enabled", kind: "boolean", default: "false", description: "Write a static handoff brief for the operator when a deal reaches proposal or negotiation (hourly, no model call)." },
  { key: "convert:booking_redirect_enabled", kind: "boolean", default: "false", description: "Serve booking links through the deployment, so the booking URL can change without editing templates. Records nothing per contact; bookings are detected by calendar sync." },
  { key: "convert:pov_enabled", kind: "boolean", default: "false", description: "Proof-of-value requests." },

  // Lifecycle, the product bridge and billing (docs/LIFECYCLE.md).
  { key: "lifecycle:enabled", kind: "boolean", default: "false", description: "The product bridge and the customer lifecycle: POST /api/webhooks/product records signed events, the event spine routes them, sign-ups and payments move contacts and deals, and the lifecycle jobs run (stalled and dormant checks, the daily MRR snapshot, payload retention). Off, or unreadable, the product webhook answers 503 and records nothing, and recorded events wait unrouted, except user.deleted: an erasure is always recorded and carried out in full, whatever this flag says. No model calls." },
  { key: "lifecycle:reconcile_enabled", kind: "boolean", default: "false", description: "The nightly signed pull from the product (deletions, users, feedback), 3 pages of 200 per resource a run with a weekly full re-read. Needs PRODUCT_APP_URL (https) and PRODUCT_READ_SECRET; with lifecycle:enabled off it reads deletions only, which are always carried out." },
  { key: "lifecycle:pull:<resource>", kind: "json", default: null, description: "State: the pull's place for users, feedback or deletions, {since, cursor, high, done, fullAt}. A rebuildable cache: unset or unreadable, the next pull is a full read." },
  { key: "lifecycle:followups_enabled", kind: "boolean", default: "false", description: "Lifecycle follow-ups to product users: every 15 minutes the lifecycle_followups job decides the first-use nudges, the usefulness check, the upgrade offer, the re-engage note, the at-risk check-in and the win-back offer that are due, with at most 4 per person in 30 days. Each passes a yes/no classifier call (role classifier, budget-gated) and the quality gate, then is sent through the send function when its class is at level 2 or above, or drafted for fu-approve-<id> otherwise. Offers are always drafted. Needs lifecycle:enabled. Off, or unreadable, nothing is decided and the fu- commands refuse." },
  { key: "billing:enabled", kind: "boolean", default: "false", description: "POST /api/webhooks/billing through the BillingProvider adapter: checkouts, subscriptions, cancellations and failed payments move the lifecycle, the deal mirror and MRR, for existing contacts only. Needs lifecycle:enabled. Off, or unreadable, the route verifies the signature, then answers 503 and records nothing." },

  // Operations.
  { key: "ops:daily_scorecard", kind: "boolean", default: "false", description: "The daily scorecard (docs/MEASUREMENT.md): one operator message each weekday at 12:00 UTC, no model call. It carries spend, so the daily cost digest stands down while it is on." },
  { key: "ops:funnel_digest", kind: "boolean", default: "false", description: "The weekly funnel digest, Mondays at 09:00 UTC: sends, replies, delivery, the matured reply rate and holdout lift, flagging a reply rate under 3% or hard bounces over 2% at 50 or more sends. No model call." },
  { key: "ops:cost_digest", kind: "boolean", default: "false", description: "The daily cost digest, weekdays at 14:00 UTC: spend per job since the previous report. Skipped while ops:daily_scorecard is on. No model call." },
  { key: "ops:target_accounts_page", kind: "boolean", default: "false", description: "The weekly target-accounts page." },
  { key: "scheduler:queue_enabled", kind: "boolean", default: "false", description: "Send each due job to JOBS_QUEUE, whose consumer runs one job per invocation with its own wall time. Needs the JOBS_QUEUE binding and its consumers in wrangler.jsonc. Off, unreadable, or without the binding, due jobs run inside the cron invocation (4 at a time, a 14-minute budget per minute)." },
  { key: "ops:retention_enabled", kind: "boolean", default: "false", description: "Daily run-row retention (run_retention, 03:40 UTC): deletes execution_runs rows that are skipped and over 7 days old, completed and over 30, or failed and over 90, always keeping the newest row of each job and status and never touching running rows. Off, or unreadable, nothing is deleted. The deployment must register createRetentionJob() in its jobs." },
  { key: "runs:durable", kind: "boolean", default: "false", description: "Journaled, resumable delegated runs." },
  { key: "security:structured_taint", kind: "boolean", default: "false", description: "The structured-taint extractor." },
  { key: "ship:enabled", kind: "boolean", default: "false", description: "The ship loop module." },
  { key: "operator:agent_enabled", kind: "boolean", default: "false", description: "The operator chat agent. Off: the operator webhook still verifies updates and replies that the agent is disabled; a read error counts as off." },
  { key: "admin:enabled", kind: "boolean", default: "false", description: "The operator dashboard's WebSocket at /ws (docs/DASHBOARD.md). Off, or unreadable, /ws answers 503 before anything else. Needs the admin section in gtm.config.ts and Cloudflare Access in front of /admin and /ws." },

  // Budgets. Per-job caps are always enforced, whatever the global mode.
  { key: "budget:daily_limit_cents", kind: "number", default: "2000", description: "Global daily spend limit." },
  { key: "budget:monthly_limit_cents", kind: "number", default: "50000", description: "Global monthly spend limit." },
  { key: "budget:enforcement", kind: "string", default: "soft", description: "soft alerts at the limit; hard blocks." },
  { key: "budget:alert_threshold", kind: "number", default: "0.8", description: "Share of a limit that triggers an alert." },
  { key: "budget:job:<job>:daily_cents", kind: "number", default: null, description: "A per-job daily cap, always enforced." },
  { key: "budget:run_ceiling_cents", kind: "number", default: "1000", description: "Spend ceiling for a delegated run; tools stop at the ceiling and the run aborts at 1.25 times it." },
  { key: "chat:turn_max_cents", kind: "number", default: "50", description: "Spend ceiling for one chat turn, including delegated runs." },

  // Self-improvement (docs/LEARNING.md). Every loop only proposes; a person approves the exact text shown. Only brain_edit and retrospective_actuation at an earned level 2 or above apply on their own, never through a flag.
  { key: "learning:edit_mining_enabled", kind: "boolean", default: "false", description: "Weekly edit mining (learning_edit_mining, Mondays 07:00 UTC): diffs drafts you edited against what was sent and proposes at most 3 writing rules a week. No model call." },
  { key: "learning:voice_enabled", kind: "boolean", default: "false", description: "The voice profile: voice-build from threads you pick proposes a voice component edit, and the weekly drift check (learning_voice_drift, Mondays 07:30 UTC) suggests a rebuild at a 40% edit rate over 10 or more decisions. No model call." },
  { key: "learning:retrospective_enabled", kind: "boolean", default: "false", description: "The daily retrospective (learning_retrospective, 05:00 UTC, strategist role, 25 cents a day): exactly one proposed improvement a day. Unreadable is off." },
  { key: "learning:agent_review_enabled", kind: "boolean", default: "false", description: "The agent review (learning_agent_review, weekdays 06:30 UTC, judge role, 50 cents a day): grades the last day's drafts and worker actions A to F and stores corrective guidance as memory." },
  { key: "learning:objections_enabled", kind: "boolean", default: "false", description: "Objection curation: objection-answer proposes your answers, and the daily learning_objections job (04:45 UTC, no model) scores each used answer by the contact's next inbound within 30 days." },
  { key: "learning:fitness_enabled", kind: "boolean", default: "false", description: "The daily fitness score (learning_fitness, 04:15 UTC, no model): seven weighted dimensions from the metrics module and their trends, shown by the fitness command and the dashboard." },
  { key: "learning:benchmark_enabled", kind: "boolean", default: "false", description: "The weekly benchmark (learning_benchmark, Sundays 03:00 UTC, $1 a day): synthetic outreach, research and routing scenarios scored by a judge; a drop over 0.05 is reported as a regression." },
  { key: "learning:evolution_enabled", kind: "boolean", default: "false", description: "Weekly evolution (learning_evolution, Sundays 05:00 UTC, $2 a day, 7-day cooldown): benchmarks up to 3 candidate edits to the brain component behind a declining fitness dimension and proposes the best. It applies one only at brain_edit level 2 or above, and rolls it back when the post-apply benchmark regresses." },

  // Autonomy and the classifier tier.
  { key: "autonomy:<class>", kind: "number", default: "1", description: "Autonomy level per action class (0 to 3). Permanently human-only classes are capped at 1. A class acts at the lower of this flag and its latest recorded change (autonomy-set from the operator chat, or a demotion), so raise a level with autonomy-set; a value written here cannot lift a class above its latest recorded change, so it cannot undo a demotion. Unreadable or malformed reads as 1." },
  { key: "autonomy_review:enabled", kind: "boolean", default: "false", description: "The weekly autonomy review (autonomy_review, Mondays 06:00 UTC): it proposes promotions from evidence, each applied only by the operator's autonomy-confirm command. No model call. Demotion has no flag: it is always on." },
  { key: "classifier_tier:<call_site>", kind: "string", default: "off", description: "The cheap classifier tier per call site: off, shadow or on." },
];

export function findFlag(key: string): FlagDefinition | undefined {
  return FLAGS.find((f) => f.key === key) ?? FLAGS.find((f) => f.key.includes("<") && patternToRegExp(f.key).test(key));
}

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/<[a-z_]+>/g, "[a-z0-9_-]+");
  return new RegExp(`^${escaped}$`);
}
