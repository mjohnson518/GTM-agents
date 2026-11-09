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
  meetingAttributedSql,
  meetingBookedSql,
  meetingEvidence,
  perHundred,
} from "./meetings.ts";
export type { MeetingAttribution, MeetingCounts, MeetingOutcome, MeetingRow } from "./meetings.ts";
