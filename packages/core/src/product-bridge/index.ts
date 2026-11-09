// GTM-agents: the product bridge's public surface (docs/LIFECYCLE.md, docs/EVENT-CONTRACT.md): the
// envelope, the push webhook, identity resolution, the spine router for product events, erasure,
// feedback filing and the nightly pull.
export { CONTRACT_VERSION, LATE_AFTER_DAYS, MAX_FEEDBACK_CHARS, PRODUCT_EVENT_TYPES, envelopeTaint, isCatalogueType, isLate, parseEnvelope } from "./envelope.ts";
export type { CatalogueType, EnvelopeOrg, EnvelopeUser, ProductEnvelope, ProductEventType } from "./envelope.ts";
export { pushSignatureValid, readCanonicalString, readSignatureHeaders } from "./signature.ts";
export { PRODUCT_WEBHOOK_PATH, createProductWebhook } from "./webhook.ts";
export type { ProductWebhookOptions } from "./webhook.ts";
export { REF_TOKEN_TTL_DAYS, isErased, plainName, resolveProductUser, splitName } from "./identity.ts";
export type { ProductUserInput, Resolution } from "./identity.ts";
export { PRODUCT_SOURCE, createProductRouter, productTransition, routeProductEnvelope } from "./route.ts";
export type { ProductRouterOptions } from "./route.ts";
export { eraseProductUser, writeTombstone } from "./erasure.ts";
export type { ProductErasureDeps, ProductErasureInput } from "./erasure.ts";
export { FEEDBACK_SOURCE, fileFeedback } from "./feedback.ts";
export { READ_PATHS, readBase, reconcileProduct } from "./reconcile.ts";
export type { PullResource, PullState, ReconcileDeps, ReconcileReport } from "./reconcile.ts";
