// GTM-agents: the HTTP module's public surface: bearer authentication for /api/* and the
// constant-time comparison that shared-secret checks use.
export { WEBHOOK_PREFIX, bearerAuth, constantTimeEqual, isWebhookPath } from "./auth.ts";
export type { BearerAuthOptions } from "./auth.ts";
