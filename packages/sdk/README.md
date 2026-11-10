# @gtm-agents/sdk

This package is for developers of the host application (the product being sold) who connect it to its GTM-agents deployment. It implements the event contract ([docs/EVENT-CONTRACT.md](../../docs/EVENT-CONTRACT.md)) on the host's side:

- **Push.** `createProductEmitter` posts signed events (sign-ups, activation, plan limits, billing changes, feedback, erasures) to the deployment. It sends each event once with a 3-second timeout, and never throws into or blocks a user's request beyond that.
- **Typed events.** A builder for every event in the catalogue, filling in the id, version and time.
- **Pull.** `createReadHandler` serves the three read endpoints the deployment calls nightly: it verifies the signature first, then cuts every row down to the contract's field whitelist.
- **Attribution.** Helpers for the `gtm_ref` cookie that carries the token from an outreach link to sign-up.

It uses WebCrypto and fetch only, with no Cloudflare dependency, so it suits Node, Bun, Deno, Workers and other edge runtimes. Like every package in the toolkit, the published package declares Node 24 or later in `engines`, and its tests run on Node 24.

## Configuration

Two secrets, two different values, shared with the deployment:

| Variable | Used for |
|---|---|
| `PRODUCT_WEBHOOK_SECRET` | Signing pushes. Unset: the emitter is a no-op |
| `PRODUCT_READ_SECRET` | Verifying the deployment's reads. Unset: the read endpoints answer 503 |

Plus the deployment's webhook URL, `{AGENT_BASE_URL}/api/webhooks/product`.

## Push events

```ts
import { createProductEmitter, userSignedUp, billingSubscribed, userDeleted } from "@gtm-agents/sdk";

const gtm = createProductEmitter({ url: process.env.GTM_EVENTS_URL, secret: process.env.PRODUCT_WEBHOOK_SECRET });

// After a user account is created. `ref` is the token your middleware stored at sign-up.
await gtm.emit(
  userSignedUp({
    user: { id: user.id, email: user.email, name: user.name, role: "owner" },
    org: { id: org.id, name: org.name, domain: org.domain, plan_tier: "free" },
    ref: user.signupRef ?? null,
    data: { plan: "free", source: "google" },
  }),
);

// When a paid subscription starts. Amounts are in the currency's minor unit (cents).
await gtm.emit(billingSubscribed({ user, org, data: { plan: "pro", interval: "month", amount: 4900, currency: "usd" } }));

// When a user is erased: the event carries only the hash of the address.
await gtm.emit(await userDeleted({ userId: user.id, email: user.email }));
```

`emit` resolves to `{ sent: true, status, duplicate }`, or `{ sent: false, reason }` with a reason of `not_configured`, `invalid_event`, `rejected`, `network` or `timeout`. It never rejects. Pass `onError` to log failures your own way.

The contract does not retry: the deployment's nightly pull repairs a lost event. If you want retries, run them from a queue of your own and reuse the event's `id`; the deployment answers `duplicate: true` and applies nothing twice.

Builders: `userSignedUp`, `orgCreated`, `userActivated`, `usageLimitReached`, `billingSubscribed`, `billingSubscriptionChanged`, `billingSubscriptionCanceled`, `billingPaymentFailed`, `billingTopupPurchased`, `orgApiKeyCreated`, `feedbackSubmitted`, `userDeleted` and `customEvent`. `eventProblem(event)` returns why the deployment would refuse an event with a 400, so your tests can catch it.

Send only addresses your product has verified: the deployment trusts the identities you sign. Send `billing.*` events from the product or from the deployment's billing adapter, not both.

## Serve the read endpoints

The deployment reads `GET {PRODUCT_APP_URL}/api/internal/gtm/users`, `/feedback` and `/deletions` nightly, with `since`, `cursor` and `limit` (at most 200). Return rows ordered by the `since` column (users by `updated_at`, feedback by `created_at`, deletions by `deleted_at`) and then by id, after the cursor.

```ts
import { createReadHandler } from "@gtm-agents/sdk";

const reads = createReadHandler({
  secret: process.env.PRODUCT_READ_SECRET,
  users: ({ since, cursor, limit }) => db.gtmUsers({ since, cursor, limit }),         // { items, hasMore? }
  feedback: ({ since, cursor, limit }) => db.gtmFeedback({ since, cursor, limit }),
  deletions: ({ since, cursor, limit }) => db.gtmDeletions({ since, cursor, limit }),
});

// Next.js route handler at app/api/internal/gtm/[resource]/route.ts:
export const GET = (request: Request) => reads(request);
```

The handler refuses an unsigned read, a signature that does not match, and a timestamp more than 5 minutes from your clock (401) before calling any loader. It answers 503 while the secret is unset, 405 to anything but GET, 404 for an endpoint you did not provide, 400 for a malformed query, and 500 when a loader throws. Every row is cut down to the contract's whitelist (`toUserItem`, `toFeedbackItem`, `toDeletionItem`), so a loader that returns extra columns leaks nothing. The response's `cursor` is the last item's id, present only when `hasMore` is true (or, without `hasMore`, when the page is full).

These endpoints are the one cross-tenant read path in your product. Serve them from a dedicated query or view, and never let end-user credentials reach them. Keep deletions readable for at least 90 days.

To verify a read yourself, use `verifyReadRequest(request, secret)` or `verifyReadSignature({ secret, method, url, timestamp, signature })`.

## Attribution

```ts
import { refCookieToSet, refFromCookies } from "@gtm-agents/sdk";

// Middleware, on every request: store a valid ?ref= token on the first touch only.
const setCookie = refCookieToSet(request.url, request.headers.get("cookie"));
if (setCookie) response.headers.append("Set-Cookie", setCookie);

// At sign-up: keep the token as users.signup_ref and send it as `ref`.
const signupRef = refFromCookies(request.headers.get("cookie"));
```

The cookie is `gtm_ref`, 30 days, `SameSite=Lax`, `Secure`, `HttpOnly`. The host checks only the token's shape (1 to 64 letters, digits, dashes or underscores); the deployment resolves it.

## Test vectors

The contract's published vectors are reproduced in `tests/contract/sdk-vectors.test.ts`, and the deployment's own signer and verifier are checked against the same bytes.
