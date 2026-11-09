// GTM-agents SDK: what a host application installs to talk to its GTM-agents deployment over the
// event contract (docs/EVENT-CONTRACT.md): typed events, the push emitter, the signed read
// endpoints and the attribution cookie. WebCrypto and fetch only, with no Cloudflare dependency.
export {
  CONTRACT_VERSION,
  PRODUCT_EVENT_TYPES,
  billingPaymentFailed,
  billingSubscribed,
  billingSubscriptionCanceled,
  billingSubscriptionChanged,
  billingTopupPurchased,
  customEvent,
  eventProblem,
  feedbackSubmitted,
  isoUtc,
  newEventId,
  orgApiKeyCreated,
  orgCreated,
  productEvent,
  usageLimitReached,
  userActivated,
  userDeleted,
  userSignedUp,
} from "./events.ts";
export type { CatalogueEventType, CustomEventType, ErasedUser, EventData, EventDataMap, EventInput, EventOrg, EventUser, ProductEvent, ProductEventType } from "./events.ts";
export { DEFAULT_EMIT_TIMEOUT_MS, EVENT_ID_HEADER, PRODUCT_WEBHOOK_PATH, SIGNATURE_HEADER, createProductEmitter, pushHeaders, signPush } from "./push.ts";
export type { EmitResult, EmitterOptions, ProductEmitter } from "./push.ts";
export {
  MAX_READ_LIMIT,
  READ_BASE_PATH,
  READ_SIGNATURE_HEADER,
  READ_TOLERANCE_SECONDS,
  TIMESTAMP_HEADER,
  createReadHandler,
  readCanonical,
  signRead,
  sortedQuery,
  toDeletionItem,
  toFeedbackItem,
  toUserItem,
  verifyReadRequest,
  verifyReadSignature,
} from "./pull.ts";
export type { DeletionItem, FeedbackItem, ReadHandlerOptions, ReadPage, ReadQuery, ReadVerification, UserItem } from "./pull.ts";
export { REF_COOKIE_MAX_AGE_SECONDS, REF_COOKIE_NAME, REF_QUERY_PARAM, REF_TOKEN_PATTERN, isRefToken, refCookie, refCookieToSet, refFromCookies, refFromUrl } from "./attribution.ts";
export { emailSha256, hmacSha256Hex, sha256Hex, timingSafeEqual } from "./crypto.ts";
