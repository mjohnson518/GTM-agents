// GTM-agents: the sending module's public surface: the kill switch, suppression, the send gates,
// and delivery: the provider boundary (createOutreachSender), unsubscribe, send windows, the
// deferred queue, the warm-up ramp, the bounce monitor, liveness, the provider webhook and the jobs.
// docs/SENDING.md is the deployer's guide.
export { COLD_PAUSE_CRITICAL_KEY, COLD_PAUSE_KEY, pauseColdOutreach, readColdPause, resumeColdOutreach } from "./kill-switch.ts";
export type { ColdPauseState, PauseSeverity, ResumeResult } from "./kill-switch.ts";
export { SUPPRESSION_REASONS, addSuppression, addressHash, checkSuppression, mailboxOf, normalizeAddress } from "./suppression.ts";
export type { BlockedRecipient, SuppressionCheck, SuppressionEntry, SuppressionReason } from "./suppression.ts";
export { SEND_PATHS, checkSendGates } from "./gates.ts";
export type { DeferReason, OutreachItem, OutreachOutcome, SendOutreach, SendRefusal } from "./types.ts";
export type { SendBlockReason, SendGateDeps, SendGateResult, SendPath } from "./gates.ts";
export { DEFAULT_SENDER_OPTIONS, createDeliveryBoundary, createOutreachSender, deferredDedupKey } from "./boundary.ts";
export type { BoundaryRunOptions, DeliveryBoundary, OutreachSenderDeps, OutreachSenderOptions } from "./boundary.ts";
export { BREAKER_THRESHOLD, readBreaker } from "./breaker.ts";
export type { BreakerState } from "./breaker.ts";
export { DELIVERY_FLAGS, DELIVERY_LIMITS, breakerKey } from "./flags.ts";
export { DEFAULT_TIMEZONE, isValidTimezone, recipientTimezone, timezoneFromLocation } from "./timezone.ts";
export type { TimezoneSource } from "./timezone.ts";
export { WEEKDAYS, isWithinWindow, localParts, nextAllowedTime, windowForPath, zonedTimeToUtc } from "./window.ts";
export type { SendWindow, Weekday } from "./window.ts";
export { messageHeaders, messageId, plainTextFooter } from "./message.ts";
export { UNSUBSCRIBE_KEY_MIN_LENGTH, isUsableSigningKey, publicOrigin, signUnsubscribeToken, unsubscribeUrl, verifyUnsubscribeToken } from "./unsubscribe-token.ts";
export { UNSUBSCRIBE_ROUTE, createUnsubscribeHandlers } from "./unsubscribe.ts";
export type { UnsubscribeHandlers, UnsubscribeRouteOptions } from "./unsubscribe.ts";
export { optOutAddress } from "./opt-out.ts";
export type { OptOutOptions, OptOutReason, OptOutResult } from "./opt-out.ts";
export { DEFERRED_LEASE_MS, DEFERRED_MAX_ATTEMPTS, deferredBackoffMs, replayDeferred } from "./deferred.ts";
export type { ReplayDeps, ReplayResult } from "./deferred.ts";
export { COLD_VOLUME_HARD_MAX, RAMP_LEVELS, loadDeliveryEvidence, rampAdvanceVerdict, rampStepDownVerdict, readColdVolume, readRamp, runRampJob, setRampLevel } from "./ramp.ts";
export type { ColdVolume, DeliveryEvidence, RampJobResult, RampState } from "./ramp.ts";
export { BOUNCE_CRITICAL_RATE, BOUNCE_MIN_VOLUME, BOUNCE_WARN_RATE, bounceLevel, bounceWindow, pauseSeverityFor, runBounceMonitor } from "./bounce-monitor.ts";
export type { BounceLevel, BounceMonitorResult, BounceWindow } from "./bounce-monitor.ts";
export { LIVENESS_QUIET_DAYS, runLiveness } from "./liveness.ts";
export type { LivenessResult } from "./liveness.ts";
export { EMAIL_WEBHOOK_PATH, createEmailWebhook, emailEventKey, processEmailEvents } from "./webhook.ts";
export type { EmailEventDeps, EmailEventsResult, EmailWebhookOptions } from "./webhook.ts";
export { BOUNCE_MONITOR_JOB, DEFAULT_DELIVERY_JOB_OPTIONS, LIVENESS_JOB, RAMP_JOB, REPLAY_JOB, createDeliveryJobs, senderDepsFromEnv } from "./jobs.ts";
export type { DeliveryDeps, DeliveryEnv, DeliveryJobOptions } from "./jobs.ts";
