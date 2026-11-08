// GTM-agents: the data module's public surface: the data model's enums, the account key, D1
// helpers, contact email fields and forward-only warmth, and deal transitions.
// docs/DATA-MODEL.md describes the tables.
export * from "./enums.ts";
export { D1_MAX_BINDINGS, inChunks, placeholders } from "./d1.ts";
export { PERSONAL_EMAIL_DOMAINS, SHARED_HOST_DOMAINS, accountKey, registrableDomain } from "./keys.ts";
export { advanceWarmth, canAdvanceWarmth, contactEmailFields } from "./contacts.ts";
export type { ContactEmailFields, WarmthResult } from "./contacts.ts";
export { DEAL_TRANSITIONS, canTransitionDeal, transitionDeal } from "./deals.ts";
export { eraseByHash, eraseContact } from "./erasure.ts";
export type { ErasureResult, ErasureSource } from "./erasure.ts";
export type { DealTransitionResult } from "./deals.ts";
