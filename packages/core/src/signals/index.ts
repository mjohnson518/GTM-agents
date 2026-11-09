// GTM-agents: the signals module's public surface: recording and routing signals, carry, angles, the
// signal and scale sources (websets, monitors, news, hiring boards, lookalikes, coverage fill), their
// jobs and the adapter shapes they call. docs/SIGNALS.md describes how it works and how to deploy it.
export { ANGLE_HIGH_DAYS, ANGLE_KINDS, ANGLE_MEDIUM_DAYS, DEFAULT_ANGLE_OPENERS, HEADLINE_QUOTE_MAX, angleAge, angleConfidence, angleFromSignal, angleKind, loadAngles, openerFor, quotableHeadline, validOpener } from "./angles.ts";
export type { Angle, AngleConfidence, AngleKind, AngleOptions, AngleSubject } from "./angles.ts";
export { creditResults, ensureSourceQuery, sourceQueryId } from "./attribution.ts";
export type { AttributedSource } from "./attribution.ts";
export { carrySignals } from "./carry.ts";
export { claimCoverage, coverageAccounts, releaseCoverage, runCoverageFill } from "./coverage.ts";
export type { CoverageClaim, CoverageRunInput, CoverageStats } from "./coverage.ts";
export { SIGNAL_FLAGS, SIGNAL_LIMITS } from "./flags.ts";
export { BOARD_TOKEN, DEFAULT_ROLE_KINDS, guessBoardToken, hiringAccounts, relevantRoles, runHiringBoards } from "./hiring.ts";
export type { HiringRunInput, HiringStats } from "./hiring.ts";
export { DEFAULT_SIGNAL_JOB_OPTIONS, SIGNAL_JOBS, createSignalJobs } from "./jobs.ts";
export type { SignalAdapters, SignalDeps, SignalJobOptions } from "./jobs.ts";
export { lookalikeExclusion, runLookalikes } from "./lookalikes.ts";
export type { LookalikeRunInput, LookalikeStats } from "./lookalikes.ts";
export { MONITOR_BODY_MAX_BYTES, drainMonitorItems, handleMonitorWebhook, monitorItemId } from "./monitors.ts";
export type { MonitorConfig, MonitorDrainStats, MonitorWebhookDeps } from "./monitors.ts";
export { DEFAULT_NEWS_QUERIES, distinctiveName, fundingSeverity, knownAccounts, matchAccount, readsAs, runNewsSignals } from "./news.ts";
export type { KnownAccount, NewsCategory, NewsQuery, NewsRunInput, NewsStats } from "./news.ts";
export { JOB_BOARDS, ROLE_KINDS } from "./ports.ts";
export type { BoardOpenings, HiringBoardSource, JobBoard, MonitorHit, NewsHit, NewsSource, RoleKind, SimilarSource, WebsetCandidate } from "./ports.ts";
export { HEADLINE_MAX, NEVER_CARRIED_SOURCES, NEVER_CARRIED_TYPES, expiryAfter, recordSignal, routeContacts, signalId, validEventDate } from "./record.ts";
export type { EvidenceValue, NewSignal, RecordOutcome } from "./record.ts";
export { runWebsets } from "./websets.ts";
export type { WebsetRunInput, WebsetSpec, WebsetStats } from "./websets.ts";
