// GTM-agents: the events module's public surface: the effects ledger, the event spine (record,
// dispatch, route under a lease, sweep, payload retention), the events queue consumer and the audit
// writer.
export { claimEffect, hasEffect, releaseEffect, runOnce } from "./effects.ts";
export { writeAudit } from "./audit.ts";
export { EVENT_PAYLOAD_PREFIX, LEASE_MS, MAX_ROUTE_ATTEMPTS, SWEEP_AFTER_MS, dispatchEvent, eventRowId, purgeRoutedPayloads, recordEvent, routeEvent, sweepEvents } from "./spine.ts";
export type { EventRouter, EventRouters, RecordInput, RecordResult, RouteContext, RouteOutcome, StoredEvent } from "./spine.ts";
export { createEventConsumer, isEventMessage } from "./consumer.ts";
export type { EventConsumerOptions } from "./consumer.ts";
