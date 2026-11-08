// GTM-agents: the flags the cold sequence's follow-up steps read, and their limits.
//
// Every key is listed in packages/core/src/flags/registry.ts, so `gtm doctor` shows it. Reads fail
// in the direction that sends less: an unreadable switch is off. Whether a follow-up needs a
// person's release is the cold batch's decision (readAutoApprove in outreach/flags.ts): the
// cold_batch:auto_approve switch, or the cold_batch action class at level 2 or above.

export const SEQUENCE_FLAGS = Object.freeze({
  /** Master switch: the follow-up sweep, the stale-sequence check and the sequence-release command. */
  enabled: "sequences:enabled",
  /** Ask the operator for a manual touch on another channel before the last step. */
  manualChannel: "followup:manual_channel_enabled",
  /**
   * How replies reach the database, which decides how the reply check knows it is not blind:
   * "poll" (the default) needs a recent successful inbox poll; "routed" (Cloudflare Email Routing
   * only, recorded the moment it arrives) needs inbox:enabled alone.
   */
  replyIntake: "sequences:reply_intake",
});

export const SEQUENCE_LIMITS = Object.freeze({
  /** Inbound mail this recent, from the contact or anyone at the account, stops a sequence. */
  replyLookbackDays: 30,
  /** A follow-up manifest can be released for this long after it was written. */
  releaseMaxAgeHours: 72,
  /** How long the last step waits for a manual touch to be marked. */
  manualTouchDays: 5,
  /** Manual touches asked for per UTC day, at most. */
  manualTouchesPerDay: 10,
  /** A manual touch note fits a connection request. */
  manualTouchMaxChars: 300,
  /** A row due this long without a step going out is reported as stale. */
  staleAfterDays: 3,
  /** Message-ID lookups at the provider per sweep, at most. */
  messageIdLookups: 50,
  /** The last inbox poll must have completed this recently for a step to go out (poll intake). */
  intakeFreshMinutes: 10,
  /** Operator messages list at most this many rows by name. */
  listed: 10,
});
