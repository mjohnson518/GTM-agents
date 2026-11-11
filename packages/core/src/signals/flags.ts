// GTM-agents: the flags and fixed limits of the signal sources.
//
// Every source is its own job behind its own flag, and every flag defaults off (flags/registry.ts
// lists them for `gtm doctor`). A flag that cannot be read is off. The limits below are per-run
// ceilings and rule constants; they are not flags, so loosening one is a code change and a review.

export const SIGNAL_FLAGS = Object.freeze({
  websets: "signals:websets_enabled",
  monitors: "signals:monitors_enabled",
  /** Article hits from monitors become funding and leadership signals (read by the monitor drain). */
  articleMonitors: "signals:article_monitors_enabled",
  news: "signals:news_enabled",
  hiringBoards: "signals:hiring_boards_enabled",
  lookalikes: "signals:lookalikes_enabled",
  coverageFill: "signals:coverage_fill_enabled",
  /** Compute the nightly intent score (shadow: recorded, never used to select). */
  intent: "scoring:intent_enabled",
  /** Use the intent band to filter cold selection. Existing flag, read by selection. */
  intentEnforce: "intent_score:enforce",
});

export const SIGNAL_LIMITS = Object.freeze({
  /** Most sourced signals sit here, below the auto-draft line. */
  sourcedSeverity: 0.6,
  /** The severity at which a signal may draft on its own. Sourced signals stay below it. */
  autoDraftSeverity: 0.7,
  /** Account-level signals wait this long for contacts to be promoted, then are no longer carried. */
  carryHoldHours: 72,
  /** Contacts one account-level signal is copied to. */
  carryMaxContacts: 2,
  /** A contact with its own signal this recent gets no carried one. */
  carryQuietDays: 90,
  /** Never-contacted contacts one signal is routed to at an account. */
  routeMaxContacts: 2,
  newsWindowDays: 30,
  newsExpiryDays: 30,
  newsQueriesPerRun: 4,
  newsResultsPerQuery: 25,
  newsAccountsScanned: 2000,
  hiringSignalEveryDays: 90,
  hiringRecheckDays: 7,
  hiringAccountsPerRun: 20,
  hiringMinFit: 7,
  hiringMinPrescore: 70,
  /** Relevant open roles before hiring counts as a signal. */
  hiringMinRoles: 3,
  hiringExpiryDays: 30,
  websetMaxPerRun: 3,
  websetItemsPerRun: 200,
  websetPollDays: 14,
  /** The fixed qualification score a webset row with a usable address is inserted at. */
  websetScore: 0.6,
  monitorDrainPerRun: 500,
  monitorHitsPerDelivery: 500,
  lookalikeInsertsPerRun: 30,
  lookalikeSeedsPerRun: 5,
  lookalikeResultsPerSeed: 10,
  lookalikeSeedDays: 180,
  lookalikeRecentCandidateDays: 90,
  coverageAccountsPerRun: 5,
  coveragePeoplePerAccount: 2,
  coverageCooldownDays: 30,
  coverageMinFit: 7,
  coverageMinSeats: 2,
  coverageRecentDays: 30,
  intentContactsPerRun: 5000,
});
