// GTM-agents: the inbox module's public surface: header normalization for adapters, structural
// classification, intake, detection jobs, the push webhook, the email() entry point and body
// storage. docs/INBOX.md describes how a deployment connects a mailbox.
export { INBOUND_HEADER_NAMES, MAX_HEADER_CHARS, MAX_REFERENCES, cleanHeaderValue, messageIdDomain, messageIdKey, parseMessageIds, pickInboundHeaders } from "./headers.ts";
export type { InboundHeaderName } from "./headers.ts";
export { classifyStructural, isBillingAlert, isOptOut, ownText } from "./classify.ts";
export type { StructuralClassification, StructuralInput, StructuralResult } from "./classify.ts";
export { OOO_DEFAULT_HOLD_DAYS, OOO_MAX_DAYS, outOfOfficeHoldUntil, parseReturnDate } from "./dates.ts";
export { MAX_BOUNCE_RECIPIENTS, parseBounce } from "./bounce.ts";
export type { BounceInfo } from "./bounce.ts";
export { PENDING_GRACE_MS, answersOurMail, applyInboundRules, knownMessageIds, ownAddressKind, processPendingInbound, recordInbound } from "./intake.ts";
export type { InboxIntakeDeps, IntakeResult } from "./intake.ts";
export { BOOTSTRAP_WINDOW_MS, CURSOR_REFRESH_MS, SWEEP_WINDOW_MS, cursorKey, isUnsupported, pollInbox, readCursor, repairBodies, sweepInbox } from "./poll.ts";
export type { PollDeps, PollResult, StoredCursor, SweepDeps, SweepResult } from "./poll.ts";
export { DEFAULT_INBOX_JOB_OPTIONS, INBOX_POLL_JOB, INBOX_SWEEP_JOB, INBOX_WATCH_JOB, createInboxJobs, intakeDepsFromEnv } from "./jobs.ts";
export type { InboxDeps, InboxEnv, InboxJobOptions } from "./jobs.ts";
export { INBOX_FLAGS, PUSH_LAST_KEY, inboxEnabled } from "./flags.ts";
export { MAIL_PUSH_SECRET_NAME, MAIL_WEBHOOK_PATH, PUSH_COALESCE_MS, createInboxPushWebhook } from "./webhook.ts";
export type { InboxPushWebhookOptions } from "./webhook.ts";
export { FORWARD_EFFECT, NOT_ACCEPTING_TEXT, createInboundEmailHandler } from "./email-handler.ts";
export type { InboundEmailHandler, InboundEmailOptions, RoutedEmail, RoutedEmailMessage, RoutedEmailParser } from "./email-handler.ts";
export { htmlToText } from "./text.ts";
export { INBOUND_BODY_MAX_CHARS, INBOUND_PREVIEW_CHARS, deleteInboundBody, inboundBodyKey, inboundPreview, putInboundBody, readInboundBody } from "./body.ts";
