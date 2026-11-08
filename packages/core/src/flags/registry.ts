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
  { key: "outreach:cold-pause", kind: "json", default: null, description: "The cold outreach kill switch: {reason, source, since, severity}. Unset means running; a read error counts as paused (critical). Only a person lifts a critical pause." },

  // Cold batch.
  { key: "cold_batch:enabled", kind: "boolean", default: "false", description: "Master switch for the daily cold batch." },
  { key: "cold_batch:auto_approve", kind: "boolean", default: "false", description: "Send passing drafts without a release code." },
  { key: "cold_batch:daily_limit", kind: "number", default: null, description: "An operator limit that can only lower the warm-up ramp level." },
  { key: "cold_batch:run_now", kind: "boolean", default: null, description: "Run the cold batch on demand at the next minute." },
  { key: "outreach:ramp_level", kind: "number", default: "0", description: "Warm-up ramp level index." },
  { key: "outreach:min_email_confidence", kind: "string", default: "medium", description: "Verification floor for cold sends." },
  { key: "outreach:holdout_rate", kind: "number", default: "0.05", description: "Share of the ready window held out as a no-send control." },
  { key: "outreach:allocation_mode", kind: "string", default: "thompson", description: "Template allocation: thompson, or weighted to revert to plain rotation." },
  { key: "outreach:send_time_experiment", kind: "boolean", default: "false", description: "Run the send-time experiment." },
  { key: "outreach:seed_inboxes", kind: "json", default: null, description: "Seed inboxes for placement checks." },
  { key: "outreach:ref_tokens_enabled", kind: "boolean", default: "false", description: "Attribution tokens on product links." },

  // Scoring and sourcing.
  { key: "intent_score:enforce", kind: "boolean", default: "false", description: "Use the intent score to filter cold selection." },
  { key: "fit:scoring_enabled", kind: "boolean", default: "false", description: "Model fit scoring for accounts." },
  { key: "fit:score_top_n", kind: "number", default: "1000", description: "Accounts in scope for fit scoring." },
  { key: "fit:score_per_run", kind: "number", default: "20", description: "Accounts scored per run." },
  { key: "discovery:enrich_per_cycle", kind: "number", default: "40", description: "Candidates enriched per discovery cycle." },
  { key: "discovery:qualify_per_cycle", kind: "number", default: "20", description: "Candidates qualified per discovery cycle." },
  { key: "discovery:email_waterfall_enabled", kind: "boolean", default: "false", description: "Email waterfall steps beyond the first finder." },
  { key: "discovery:<source>_enabled", kind: "boolean", default: "false", description: "Each additional sourcing path, one flag per source." },
  { key: "enrichment:second_provider_enabled", kind: "boolean", default: "false", description: "The second-provider step of the email waterfall." },
  { key: "enrichment:job_check_enabled", kind: "boolean", default: "false", description: "Job-change checks for stale contacts." },
  { key: "enrichment:job_check_required", kind: "boolean", default: "false", description: "Hold stale contacts that have not been job-checked." },
  { key: "verification:backfill_daily", kind: "number", default: "50", description: "Addresses verified by the nightly backfill." },

  // Replies, sequences and convert.
  { key: "signal_response:auto_send", kind: "boolean", default: "false", description: "The signal fast lane." },
  { key: "inbound:auto_send_tier", kind: "boolean", default: "false", description: "The reply auto-send tier." },
  { key: "followup:manual_channel_enabled", kind: "boolean", default: "false", description: "Ask the operator for a manual LinkedIn or X touch before the last step. Nothing is posted automatically." },
  { key: "followup:multithread_enabled", kind: "boolean", default: "false", description: "Write to a colleague after silence." },
  { key: "followup:reengage_enabled", kind: "boolean", default: "false", description: "Re-engage on a new signal." },
  { key: "convert:calendar_enabled", kind: "boolean", default: "false", description: "Calendar sync." },
  { key: "convert:booking_redirect_enabled", kind: "boolean", default: "false", description: "Tracked booking links." },
  { key: "convert:pov_enabled", kind: "boolean", default: "false", description: "Proof-of-value requests." },

  // Operations.
  { key: "ops:daily_scorecard", kind: "boolean", default: "false", description: "The daily scorecard replaces separate digests." },
  { key: "ops:target_accounts_page", kind: "boolean", default: "false", description: "The weekly target-accounts page." },
  { key: "ops:retention_enabled", kind: "boolean", default: "false", description: "Archive and delete old logs." },
  { key: "runs:durable", kind: "boolean", default: "false", description: "Journaled, resumable delegated runs." },
  { key: "security:structured_taint", kind: "boolean", default: "false", description: "The structured-taint extractor." },
  { key: "ship:enabled", kind: "boolean", default: "false", description: "The ship loop module." },

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
