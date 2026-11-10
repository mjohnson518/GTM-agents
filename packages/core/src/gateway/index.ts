// GTM-agents: the operator dashboard's server side: the /ws route and its Cloudflare Access check, the
// request dispatcher the OperatorGateway Durable Object runs, and the sources other modules plug in.
// docs/DASHBOARD.md is the deployer's guide; protocol.ts is the contract with apps/admin.
export { ACCESS_JWT_HEADER, AccessKeyCache, CLOCK_SKEW_S, KEY_MAX_AGE_MS, KEY_REFETCH_MS, accessIssuer, certsUrl, isAllowedEmail, verifyAccessRequest, verifyAccessToken } from "./access.ts";
export type { AccessIdentity, AccessResult, AccessVerifyOptions, AdminConfig } from "./access.ts";
export { activityItem, csvCell } from "./activity.ts";
export { ChatStream, STREAM_FLUSH_MS, STREAM_MAX_CHARS, chunkText } from "./chat-stream.ts";
export type { ChatStreamOptions } from "./chat-stream.ts";
export { RpcError } from "./context.ts";
export type { ConnectionState, GatewayContext, RunningTurn } from "./context.ts";
export { CLOSE, HANDLERS, MAX_FRAME_BYTES, RATE_CLOSE_AT, RATE_LIMITS, RATE_WINDOW_MS, dashboardEnabled, handleFrame, socketGate } from "./dispatch.ts";
export type { FrameOutcome } from "./dispatch.ts";
export { HUMAN_GATE_FLAGS, checkFlagWrite, isEditableFlag } from "./flags.ts";
export { DRAIN_MAX_ROWS, REPLAY_MAX_ROWS, parseChangelog } from "./ops.ts";
export { PARAMS, parseParams } from "./params.ts";
export { proposalDigest } from "./proposals.ts";
export { ADMIN_FLAG, GATEWAY_INSTANCE, GATEWAY_PATH, IDENTITY_HEADER, NOT_ALLOWED_CLOSE, admitUpgrade, createGatewayRoute, originAllowed } from "./route.ts";
export { gatewayWiring, registerGateway } from "./wiring.ts";
export type { DashboardExtensions, FitnessSource, GatewayWiring, LearningSource, LinkTriageSource, ProposalSource } from "./wiring.ts";
export * from "./protocol.ts";
