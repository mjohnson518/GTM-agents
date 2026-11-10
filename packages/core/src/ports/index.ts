// GTM-agents: public entry point for the port interfaces and the adapter manifest schema.
export { AdapterError, TAINT_LEVELS } from "./types.ts";
export type { AdapterContext, AdapterErrorCode, AdapterLogger, BilledUsage, Cost, Evidence, Page, TaintLevel } from "./types.ts";
export { SIGNAL_TYPES } from "./discovery.ts";
export type {
  Candidate,
  CompanyProvider,
  CompanyRecord,
  DiscoveryQuery,
  DiscoverySource,
  PeopleProvider,
  PersonFilters,
  PersonRecord,
  ResearchDossier,
  Signal,
  SignalSource,
  SignalType,
  WatchHandle,
} from "./discovery.ts";
export { VERIFICATION_STATUSES } from "./contact.ts";
export type { ContactFinder, EmailVerifier, VerificationStatus } from "./contact.ts";
export type { EmailEvent, EmailProvider, InboundMessage, InboxProvider, OutboundMessage, SendOutcome } from "./email.ts";
export type { ApprovalRequest, OperatorChannel, OperatorMessage, OperatorUpdate } from "./operator.ts";
export type { BillingEvent, BillingInterval, BillingProvider, CalendarAttendee, CalendarEvent, CalendarEventSummary, CalendarProvider, CrmSink, Sandbox } from "./business.ts";
export { SHIP_BRANCH_PREFIX, SHIP_TASK_ID, shipBranch, type ChangedFile, type CheckConclusion, type ChecksState, type ChecksSummary, type CodeHost, type CodeHostEvent, type CodingCollectFailure, type CodingCollectResult, type CodingRunState, type CodingSandbox, type CodingSandboxLimits, type CodingStatus, type CodingStep, type CodingStepKind, type CommitRequest, type PathKind, type CommitResult, type DeploymentState, type PullRequestRef, type PullRequestRequest, type PullRequestState, type RepoFile } from "./code.ts";
export { MODEL_ROLES } from "./model.ts";
export type { CompletionRequest, CompletionResult, ModelContentBlock, ModelGateway, ModelRole, ModelStreamHandlers } from "./model.ts";
export { GATE_LEVELS, PORT_NAMES, manifestSchema, manifestToolSchema } from "./manifest-schema.ts";
export type { AdapterManifest, GateLevel, ManifestTool } from "./manifest-schema.ts";
