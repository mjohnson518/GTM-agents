// GTM-agents: the ship module's public entry. Feedback becomes themes, themes become approved
// specs, and approved specs become pull requests a person reviews and merges. Off by default
// (ship:enabled); docs/SHIP.md covers setup.
export type { AnnounceShipped, ChangedFile, EvaluatePathPolicy, PathPolicyConfig, PathPolicyLimits, PathPolicyVerdict, Risk, ShipSpec, StartShipBuild } from "./contract.ts";
// Planning: themes, specs, approval, the path policy and the "you asked, it is live" notes.
export { DEFAULT_SHIP_PLANNING_OPTIONS, SHIP_JOBS, createShipPlanning } from "./planning.ts";
export type { ShipPlanning, ShipPlanningDeps, ShipPlanningOptions } from "./planning.ts";
export { SHIP_FLAGS, shipFlagOn, shipStepOn } from "./planning-flags.ts";
export type { ShipFlag } from "./planning-flags.ts";
export { DEFAULT_DENIED_PATHS, DEFAULT_LIMITS, DEPENDENCY_MANIFESTS, deniedBy, deniedGlobs, evaluatePathPolicy, isDependencyManifest, pathPolicyConfig, pathProblem } from "./path-policy.ts";
export { SHIP_HELP_LINES, createShipCommands, parseShipCommand } from "./planning-commands.ts";
export type { ShipCommand } from "./planning-commands.ts";
export { DEFAULT_JOIN_THRESHOLD, PRIORITY_WEIGHTS, cosine, rescoreThemes, runShipThemes, runningMean, themeScore } from "./themes.ts";
export type { ScoreInput, ThemesResult } from "./themes.ts";
export { APPROVAL_CODE_CHARS, approvalCode, declineReason, parseSpec, renderSpec, specDigest } from "./spec.ts";
export { MAX_AUTO_APPROVALS_PER_RUN, approveSpec, declineSpec } from "./approval.ts";
export { DEFAULT_NOTE_TEMPLATE_ID, NOTE_APPROVABLE_DAYS, composeNote, draftShipNotes, runNoteCommand } from "./notes.ts";
// The build: the sandbox Workflow, the gatekeeper, the risk approval, pull requests and deploy
// detection. Importing this entry needs the Workers runtime (the Workflow class extends
// WorkflowEntrypoint from "cloudflare:workers").
export { CONTRACT_MAX_BYTES, createShipBuild, createStartBuild } from "./build.ts";
export type { ShipBuild } from "./build.ts";
export { DEFAULT_SHIP_BUILD_OPTIONS, RISK_APPROVAL_EVENT, RISK_APPROVAL_TIMEOUT, SHIP_BUILDS_FLAG, createShipBuildWorkflow, runShipBuild } from "./workflow.ts";
export type { BuildOutcome, BuildStep, ShipBuildDeps, ShipBuildOptions, ShipBuildParams, ShipBuildWorkflowClass } from "./workflow.ts";
export { encodeChanges, gatekeep, lineDelta, normalizeChanges, riskCode } from "./gatekeeper.ts";
export type { GatekeepInput, GatekeepResult } from "./gatekeeper.ts";
export { RISK_HELP_LINES, createRiskApproveCommand } from "./risk.ts";
export { SHIP_WEBHOOK_PATH, createShipRoutes, handleCodeWebhook } from "./webhooks.ts";
