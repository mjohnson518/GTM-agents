// GTM-agents: the flags convert reads, and its limits.
//
// Every key is listed in packages/core/src/flags/registry.ts, so `gtm doctor` shows it. Reads fail
// in the direction that does less: an unreadable switch is off.

export const CONVERT_FLAGS = Object.freeze({
  /**
   * Calendar sync and everything that follows a booking: attribution, the booked effects (outreach
   * stopped, warmth, deal stage, prep brief), reminders, the held or no-show question, recap and
   * rebook drafts, and the meeting commands.
   */
  calendar: "convert:calendar_enabled",
  /** Draft the post-demo follow-ups (day 4 and day 10 after a held meeting), each for approval. */
  postDemo: "convert:post_demo_enabled",
  /** Write a handoff brief when a deal reaches proposal or negotiation. */
  handoff: "convert:handoff_enabled",
});

export const CONVERT_LIMITS = Object.freeze({
  /** Calendar sync reads this many days back... */
  syncBackDays: 3,
  /** ...and this many days ahead. */
  syncAheadDays: 60,
  /** The domain rule looks for contacts written to this recently. */
  domainContactedDays: 60,
  /** With no held or no-show answer this long after asking, the recap is drafted for review. */
  recapAfterHours: 24,
  /** Post-demo follow-ups, days after the meeting ended. */
  postDemoStepDays: { 2: 4, 3: 10 },
  /** Unmatched events are forgotten once they ended this long ago; ambiguous ones after the second figure. */
  forgetUnmatchedDays: 3,
  forgetAmbiguousDays: 14,
  /** The follow-up job looks back this far for meetings that still need something. */
  followUpLookbackDays: 14,
  /** Meeting notes kept per meeting, in characters. */
  notesMaxChars: 4000,
  /** One notes command carries at most this much. */
  noteMaxChars: 2000,
  /** Operator messages list at most this many rows by name. */
  listed: 10,
});
