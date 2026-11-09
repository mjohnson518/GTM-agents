// GTM-agents: the public surface of convert: calendar sync and booking attribution, the booked
// effects, the meeting follow-ups and drafts, the static briefs, the meeting commands and the jobs.
// docs/CONVERT.md is the deployer's guide.
export { CONVERT_FLAGS, CONVERT_LIMITS } from "./flags.ts";
export { CALENDAR_EVENT_STATES, MAX_OUTSIDE_ATTENDEES, classifyEvent, isInternalAddress, isResourceAddress, meetingCode, meetingEffectKey, type CalendarEventState, type ClassifiedEvent, type OutsideAttendee } from "./state.ts";
export { attendeeFingerprint, attributeEvent, type AttendeeFingerprint, type AttributionResult } from "./attribution.ts";
export { creditMeeting, creditedSend, withdrawMeetingCredit, type CreditedSend } from "./ledger.ts";
export { BOOKED_STEPS, applyBooked, bookedKey, bookingNotice, dealFor, ensureDemoDeal, withdrawBooked, type BookedDeps, type BookedMeeting, type BookedResult, type BookedStep } from "./booked.ts";
export { displayName, loadContactBrief, renderHandoffBrief, renderPrepBrief, when, type BriefMeeting, type ContactBrief, type HandoffDeal } from "./brief.ts";
export {
  CONVERT_DRAFT_KINDS,
  OPEN_DRAFT_STATUSES,
  convertDraftKey,
  convertDraftStatus,
  createConvertDraft,
  draftText,
  meetingDay,
  withdrawConvertDrafts,
  type ConvertDraftDeps,
  type ConvertDraftInput,
  type ConvertDraftKind,
  type ConvertDraftResult,
  type DraftContext,
} from "./drafts.ts";
export { cancelMeeting, runCalendarSync, syncWindow, type MeetingRecord, type SyncDeps, type SyncResult } from "./sync.ts";
export { dueReminder, dueStep, postDemoStopReason, runMeetingFollowups, type FollowupDeps, type FollowupResult, type FollowupRow } from "./followups.ts";
export { HANDOFF_STAGES, runDealHandoffs, type HandoffDeps, type HandoffResult } from "./handoff.ts";
export { CONVERT_HELP_LINES, parseConvertCommand, resolveContact, runConvertCommand, type ConvertCommand, type ConvertCommandDeps } from "./commands.ts";
export { CALENDAR_SYNC_JOB, DEAL_HANDOFF_JOB, DEFAULT_CONVERT_JOB_OPTIONS, MEETING_FOLLOWUPS_JOB, createConvertJobs, type ConvertDeps, type ConvertEnv, type ConvertJobOptions } from "./jobs.ts";
