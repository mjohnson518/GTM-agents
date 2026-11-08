// GTM-agents: the sending module's public surface: the kill switch, suppression and the send gates.
export { COLD_PAUSE_CRITICAL_KEY, COLD_PAUSE_KEY, pauseColdOutreach, readColdPause, resumeColdOutreach } from "./kill-switch.ts";
export type { ColdPauseState, PauseSeverity, ResumeResult } from "./kill-switch.ts";
export { SUPPRESSION_REASONS, addSuppression, addressHash, checkSuppression, mailboxOf, normalizeAddress } from "./suppression.ts";
export type { BlockedRecipient, SuppressionCheck, SuppressionEntry, SuppressionReason } from "./suppression.ts";
export { SEND_PATHS, checkSendGates } from "./gates.ts";
export type { SendBlockReason, SendGateDeps, SendGateResult, SendPath } from "./gates.ts";
