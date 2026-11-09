// GTM-agents: billing's public surface (docs/LIFECYCLE.md): the webhook through the BillingProvider
// port, the spine router that turns billing events into lifecycle moves, and MRR helpers. No vendor
// adapter lives in core; the fake provider for tests is in "@gtm-agents/core/billing/testing".
export { BILLING_WEBHOOK_PATH, createBillingWebhook, toStored } from "./webhook.ts";
export type { BillingWebhookOptions } from "./webhook.ts";
export { BILLING_SOURCE, BILLING_STATUSES, billingTransition, createBillingRouter, normalizeStatus, routeBillingEvent } from "./route.ts";
export type { BillingRouterOptions, BillingStatus, StoredBillingEvent } from "./route.ts";
export { listPrice, monthlyCents, mrrDirection, planDirection } from "./mrr.ts";
export type { PriceList } from "./mrr.ts";
