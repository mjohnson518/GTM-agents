// GTM-agents: the metrics module's public surface: the one implementation of each outcome metric.
// Reports, experiments and promotion checks import from here and define nothing of their own.
export {
  HUMAN_CLASSIFICATIONS,
  NON_REPLY_CLASSIFICATIONS,
  NON_REPLY_INTENTS,
  POSITIVE_INTENTS,
  REPLY_INTENTS,
  countsAsReply,
  isPositiveIntent,
  isPositiveReply,
  isReplyIntent,
  meetingCountsAsPositive,
  positiveReplyAt,
} from "./positive-reply.ts";
export type { MeetingEvidence, PositiveReplyInput, ReplyIntent, ReplySignal } from "./positive-reply.ts";
export { DAY_MS, HOUR_MS, daysBefore, fullDaysBefore, metricWindow, startOfUtcDay, startOfUtcWeek, weekToDate, windowLabel } from "./window.ts";
export type { MetricWindow } from "./window.ts";
export { ATTRIBUTION_WINDOW_DAYS } from "./attribution.ts";
export { COHORT_SIGNAL_DAYS, SEND_COHORTS, cohortFor, isSendCohort, sendCohort, signalledContacts, templateIsTargeted } from "./cohort.ts";
export type { CohortSubject, SendCohort } from "./cohort.ts";
export {
  MATURITY_DAYS,
  OUTCOME_DIMENSIONS,
  UNKNOWN_SLICE,
  countReplies,
  countSends,
  firstTouchOutcomes,
  firstTouchOutcomesBy,
  isOutcomeDimension,
  maturedBefore,
  maturedSamples,
  maturedTotals,
  replyDepth,
  replyRate,
} from "./outreach.ts";
export type { MaturedSample, MaturedTotals, OutcomeCounts, OutcomeDimension, OutcomeSlice, ReplyCounts, ReplyDepth, SendCounts } from "./outreach.ts";
export { COMPLAINT_ALERT_RATE, HARD_BOUNCE_ALERT_RATE, MIN_DELIVERED_COVERAGE, deliveryAlerts, deliveryHealth } from "./delivery.ts";
export type { DeliveryAlerts, DeliveryHealth } from "./delivery.ts";
export { complaintRate, deliveryCounts, hardBounceRate, hardBounceShareOfOutcomes, peakDayDelivered, sinceWindow, trailingDays } from "./delivery-rates.ts";
export type { DeliveryCounts } from "./delivery-rates.ts";
// The unsubscribe rate: the autonomy rate check reads it.
export { optOutCounts, unsubscribeRate } from "./opt-outs.ts";
export type { OptOutCounts } from "./opt-outs.ts";
export { REPLY_SLA_HOURS, REPLY_SLA_WINDOW_DAYS, median, owedWindowDays, replyResponseTimes, replySla } from "./sla.ts";
export type { ReplySla, ResponseTimes } from "./sla.ts";
export { MICRO_CENTS_PER_CENT, failedJobs, operatorQueue, spendByJob } from "./operations.ts";
export type { JobFailures, JobSpend, OperatorQueue, Spend } from "./operations.ts";
export { BRIDGE_STUCK_HOURS, COVERAGE_DAYS, MIN_LEDGER_COVERAGE, MIN_SENDS_FOR_COVERAGE, PRODUCT_EVENT_SOURCE, judgeHealth, ledgerCoverage, measurementHealth, unreadableHealth } from "./health.ts";
export type { LedgerCoverage, MeasurementHealth } from "./health.ts";
export { MIN_HELD, SIGNUP_WINDOW_DAYS, holdoutLift, liftVerdict } from "./holdout.ts";
export type { ArmOutcome, HoldoutLift, LiftVerdict } from "./holdout.ts";
// Meetings: the one definition of a meeting booked, and the meeting counts.
export {
  HEURISTIC_ATTRIBUTIONS,
  MEETING_ATTRIBUTIONS,
  MEETING_OUTCOMES,
  countMeetings,
  isMeetingAttribution,
  isMeetingBooked,
  meetingAfterOutreachSql,
  meetingAttributedSql,
  meetingBookedSql,
  meetingEvidence,
  perHundred,
} from "./meetings.ts";
export type { MeetingAttribution, MeetingCounts, MeetingOutcome, MeetingRow } from "./meetings.ts";
// Product outcomes: the one definition of a sign-up, an activation, a new paying customer and MRR.
export { PRODUCT_OUTCOMES, PRODUCT_OUTCOME_SOURCES, countProductOutcomes, currentMrr, experimentArmForOutcome, firstTouchForOutcome, productOutcomeSql, signupSql } from "./product.ts";
export type { FirstTouchCredit, Mrr, ProductOutcome, ProductOutcomeCounts } from "./product.ts";
// Accounts that responded (a positive reply, a meeting booked, a sign-up or subscription): lookalike seeds and coverage fill.
export { respondedAccounts } from "./accounts.ts";
// Experiments: the per-arm, per-cell, per-variant and per-slot samples, and the statistics over them.
export {
  EXPERIMENT_ARMS,
  EXPERIMENT_METRICS,
  PRODUCT_EXPERIMENT_METRICS,
  experimentArmSamples,
  isExperimentMetric,
  isProductMetric,
  sendSlotSamples,
  subjectVariantSamples,
  templateCellSamples,
  verifiedReadyContacts,
} from "./experiments.ts";
export type { ArmSample, CellSample, ExperimentArm, ExperimentMetric, ExperimentSamples, SlotSample, SubjectTestSamples, VariantSample } from "./experiments.ts";
export {
  MONTE_CARLO_DRAWS,
  betaDraw,
  normalCdf,
  posterior,
  probabilityBest,
  probabilityBetterMonteCarlo,
  probabilityBetterNormal,
  sampleSizePerArm,
  shuffled,
  systematicCounts,
} from "./experiment-stats.ts";
export type { ArmCounts, Uniform } from "./experiment-stats.ts";
