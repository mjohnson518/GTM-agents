// GTM-agents: the reports module's public surface: the daily scorecard, the funnel and cost
// digests, the conversion report and holdout lift, their jobs and their operator commands. Every
// number in them comes from the metrics module; nothing here counts anything itself.
export { MIN_SLICE_SENDS, CONVERSION_DAYS, compareSlices, conversionWindow, leader, loadConversionReport, rankSlices, renderConversionReport } from "./conversion.ts";
export type { ConversionData, RankedSlice } from "./conversion.ts";
export { loadCostDigest, renderCostDigest } from "./cost.ts";
export type { CostData } from "./cost.ts";
export { REPORT_EFFECT, deliverOnce } from "./deliver.ts";
export type { DeliverDeps, DeliveryStatus } from "./deliver.ts";
export { REPORT_FLAGS, reportFlagOn } from "./flags.ts";
export { NOT_MEASURED, UNREADABLE, dollars, label, pct } from "./format.ts";
export { FUNNEL_BOUNCE_RATE_CEILING, FUNNEL_MIN_VOLUME, FUNNEL_REPLY_RATE_FLOOR, funnelFlags, funnelWindows, loadFunnelDigest, renderFunnelDigest } from "./funnel.ts";
export type { FunnelData, FunnelFlags, FunnelWindows } from "./funnel.ts";
export { LIFT_LOOKBACK_DAYS, liftLine, liftWindow, loadHoldoutReport, points, renderHoldoutReport } from "./holdout.ts";
export type { HoldoutReportData } from "./holdout.ts";
export { flagsOn, healthLine, loadScorecard, renderScorecard, reportDay, scorecardWindows } from "./scorecard.ts";
export type { ScorecardData, ScorecardWindows } from "./scorecard.ts";
export { COST_DIGEST_JOB, DEFAULT_REPORT_JOB_OPTIONS, FUNNEL_DIGEST_JOB, SCORECARD_JOB, createReportJobs } from "./jobs.ts";
export type { ReportDeps, ReportEnv, ReportJobOptions } from "./jobs.ts";
export { REPORT_COMMAND_NAMES, REPORT_HELP_LINES, isReportCommand, runReportCommand } from "./commands.ts";
export type { ReportCommandDeps } from "./commands.ts";
