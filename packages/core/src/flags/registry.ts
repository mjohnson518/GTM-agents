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
  { key: "outreach:allocation_mode", kind: "string", default: "weighted", description: "Template allocation. Only weighted rotation by volume_weight exists today; thompson is reserved for the experiments milestone, and every value runs as weighted rotation until then." },
  { key: "quality:model_review_enabled", kind: "boolean", default: "false", description: "The model reviewer (judge role) in the quality gate. Off, or unavailable, nothing is approved automatically: drafts that would auto-send are held with REVIEW_UNAVAILABLE." },
  { key: "outreach:send_time_experiment", kind: "boolean", default: "false", description: "Run the send-time experiment." },
  { key: "outreach:seed_inboxes", kind: "json", default: null, description: "Seed inboxes for placement checks." },
  { key: "outreach:ref_tokens_enabled", kind: "boolean", default: "false", description: "Attribution tokens on product links." },

  // Delivery: the provider boundary, the deferred queue, the warm-up ramp and the bounce monitor (docs/SENDING.md).
  { key: "delivery:enabled", kind: "boolean", default: "false", description: "Master switch for the send function's actual send. Off, or unreadable, nothing is sent: every item comes back as a retryable failure ([SEND BLOCKED:disabled]). Also gates the deferred replay and the bounce monitor jobs." },
  { key: "delivery:domain_daily_cap", kind: "number", default: "500", description: "Messages per UTC day through the email provider, from the sending domain (at most 10000). Overflow waits for midnight UTC; an unreadable value allows none." },
  { key: "delivery:account_weekly_cap", kind: "number", default: "3", description: "Cold and sequence messages per recipient account in any 7 days, enforced inside the send function (at most 50). An unreadable value allows none." },
  { key: "outreach:ramp_auto", kind: "boolean", default: "false", description: "Let the ramp job move the warm-up level (25, 50, 100, 250, 500 a day) on delivery evidence. Off, the level only changes by hand." },
  { key: "outreach:ramp_changed_at", kind: "string", default: null, description: "State: when the warm-up ramp level last changed, written by the ramp job and the bounce monitor." },
  { key: "delivery:breaker:<day>", kind: "json", default: null, description: "State: the provider circuit breaker for one UTC day, {consecutive, openedAt}. Three consecutive provider failures open it until midnight UTC; an unreadable record counts as open." },
  { key: "delivery:last_auto_resume", kind: "string", default: null, description: "State: when the bounce monitor last lifted a warning pause, kept 14 days. A spike inside that time pauses at critical." },

  // Scoring and sourcing.
  { key: "intent_score:enforce", kind: "boolean", default: "false", description: "Use the intent score to filter cold selection." },
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
  { key: "enrichment:second_provider_enabled", kind: "boolean", default: "false", description: "The second-provider step of the email waterfall." },
  { key: "enrichment:job_check_enabled", kind: "boolean", default: "false", description: "Job-change checks for stale contacts." },
  { key: "enrichment:job_check_required", kind: "boolean", default: "false", description: "Hold stale contacts that have not been job-checked." },
  { key: "verification:backfill_daily", kind: "number", default: "50", description: "Addresses verified by the nightly backfill." },

  // Replies, sequences and convert.
  { key: "inbox:enabled", kind: "boolean", default: "false", description: "Inbox intake (docs/INBOX.md): the poll, sweep and watch renewal jobs, the push webhook's poll and Email Routing intake. Off, or unreadable, nothing is recorded or acted on: the push webhook verifies and acknowledges only, and routed mail is forwarded when a forward address is set, otherwise rejected." },
  { key: "inbox:cursor:<provider>", kind: "json", default: null, description: "State: a mailbox's poll cursor, {cursor, at}. A rebuildable cache: unset or unreadable, the poll lists the last day instead." },
  { key: "inbox:push_last", kind: "string", default: null, description: "State: when the last push-triggered poll started, so a burst of pushes runs one poll." },
  { key: "signal_response:auto_send", kind: "boolean", default: "false", description: "The signal fast lane." },
  { key: "inbound:auto_send_tier", kind: "boolean", default: "false", description: "The reply auto-send tier." },
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
  { key: "convert:calendar_enabled", kind: "boolean", default: "false", description: "Calendar sync." },
  { key: "convert:booking_redirect_enabled", kind: "boolean", default: "false", description: "Serve booking links through the deployment, so the booking URL can change without editing templates. Records nothing per contact; bookings are detected by calendar sync." },
  { key: "convert:pov_enabled", kind: "boolean", default: "false", description: "Proof-of-value requests." },

  // Operations.
  { key: "ops:daily_scorecard", kind: "boolean", default: "false", description: "The daily scorecard (docs/MEASUREMENT.md): one operator message each weekday at 12:00 UTC, no model call. It carries spend, so the daily cost digest stands down while it is on." },
  { key: "ops:funnel_digest", kind: "boolean", default: "false", description: "The weekly funnel digest, Mondays at 09:00 UTC: sends, replies, delivery, the matured reply rate and holdout lift, flagging a reply rate under 3% or hard bounces over 2% at 50 or more sends. No model call." },
  { key: "ops:cost_digest", kind: "boolean", default: "false", description: "The daily cost digest, weekdays at 14:00 UTC: spend per job since the previous report. Skipped while ops:daily_scorecard is on. No model call." },
  { key: "ops:target_accounts_page", kind: "boolean", default: "false", description: "The weekly target-accounts page." },
  { key: "ops:retention_enabled", kind: "boolean", default: "false", description: "Archive and delete old logs." },
  { key: "runs:durable", kind: "boolean", default: "false", description: "Journaled, resumable delegated runs." },
  { key: "security:structured_taint", kind: "boolean", default: "false", description: "The structured-taint extractor." },
  { key: "ship:enabled", kind: "boolean", default: "false", description: "The ship loop module." },
  { key: "operator:agent_enabled", kind: "boolean", default: "false", description: "The operator chat agent. Off: the operator webhook still verifies updates and replies that the agent is disabled; a read error counts as off." },

  // Budgets. Per-job caps are always enforced, whatever the global mode.
  { key: "budget:daily_limit_cents", kind: "number", default: "2000", description: "Global daily spend limit." },
  { key: "budget:monthly_limit_cents", kind: "number", default: "50000", description: "Global monthly spend limit." },
  { key: "budget:enforcement", kind: "string", default: "soft", description: "soft alerts at the limit; hard blocks." },
  { key: "budget:alert_threshold", kind: "number", default: "0.8", description: "Share of a limit that triggers an alert." },
  { key: "budget:job:<job>:daily_cents", kind: "number", default: null, description: "A per-job daily cap, always enforced." },
  { key: "budget:run_ceiling_cents", kind: "number", default: "1000", description: "Spend ceiling for a delegated run; tools stop at the ceiling and the run aborts at 1.25 times it." },
  { key: "chat:turn_max_cents", kind: "number", default: "50", description: "Spend ceiling for one chat turn, including delegated runs." },

  // Autonomy and the classifier tier.
  { key: "autonomy:<class>", kind: "number", default: "1", description: "Autonomy level per action class (0 to 3). Permanently human-only classes are capped at 1." },
  { key: "classifier_tier:<call_site>", kind: "string", default: "off", description: "The cheap classifier tier per call site: off, shadow or on." },
];

export function findFlag(key: string): FlagDefinition | undefined {
  return FLAGS.find((f) => f.key === key) ?? FLAGS.find((f) => f.key.includes("<") && patternToRegExp(f.key).test(key));
}

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/<[a-z_]+>/g, "[a-z0-9_-]+");
  return new RegExp(`^${escaped}$`);
}
