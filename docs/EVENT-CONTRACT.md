# Product event contract

This page is for developers connecting the product being sold (the "host application") to its GTM-agents deployment, and for contributors changing either side of the wire contract between them. Any product can implement it in an afternoon. It has five parts:
- one webhook the host posts to;
- three signed read endpoints the host serves;
- one cookie for attribution;
- an erasure flow;
- an optional proof-of-value hook.

With it, sign-ups, payments and plan limits move contacts and deals in the agent, experiments measure conversions instead of only replies, and erasure requests reach the agent.

Version: `1`. Changes are additive. A breaking change bumps `version` in the envelope and in this document.

## Overview

```
host application                                    GTM-agents Worker
----------------                                    -----------------
user signs up, pays, hits a limit  --- push ---->   POST /api/webhooks/product
                                                     (signed, deduplicated by event id)
nightly reconcile                  <--- pull ----   GET  {PRODUCT_APP_URL}/api/internal/gtm/users
                                                     GET  .../feedback
                                                     GET  .../deletions
?ref=<token> on outreach links     --- cookie -->   stored by the host, copied to users.signup_ref
proof of value (optional)          <--- call ----   POST {PRODUCT_APP_URL}/api/internal/gtm/proof
```

Both sides hold two secrets, and they are different values:
- `PRODUCT_WEBHOOK_SECRET`: the host signs pushes with it and the agent verifies them.
- `PRODUCT_READ_SECRET`: the agent signs pulls and proof calls with it and the host verifies them.

On the agent side they are Worker secrets; on the host side they are environment variables. When either is unset, that direction does nothing:
- `PRODUCT_WEBHOOK_SECRET` unset on the host makes its emitter a no-op; unset on the agent, the webhook answers 503.
- `PRODUCT_READ_SECRET` unset on the agent skips the nightly pull; unset on the host, the read endpoints answer 503.

## 1. Push: host to agent

### Endpoint

`POST {AGENT_BASE_URL}/api/webhooks/product`

Headers:

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `X-Signature` | `sha256=<hex HMAC-SHA256(PRODUCT_WEBHOOK_SECRET, raw request body)>` |
| `X-Event-Id` | equal to `body.id` |

The signature covers the raw bytes the host sent, not a re-serialization. The agent compares signatures in constant time.

### Responses

| Status | Meaning |
|--------|---------|
| `200 {"ok":true,"duplicate":false}` | Recorded and dispatched (`"late":true` is added for an event older than 7 days) |
| `200 {"ok":true,"duplicate":true}` | Already seen (same `id`); nothing is dispatched again |
| `400` | The body is not JSON, or it fails the schema below |
| `401` | Bad or missing signature, or `X-Event-Id` missing or different from `body.id` (a body without an `id` cannot match) |
| `413` | The body is larger than 100 KiB (102,400 bytes) |
| `500` | The event could not be recorded; nothing was kept, and the nightly pull repairs it |
| `503` | The agent is not accepting product events: `PRODUCT_WEBHOOK_SECRET` is unset, the deployment has not wired the lifecycle, or `lifecycle:enabled` is off. A `user.deleted` event is the exception: once its signature verifies, it is always recorded and honored, whatever the flags say, so a deletion is never lost |

The agent checks the signature before it parses anything, and handles a valid push in this order:
1. Write the raw payload to blob storage.
2. Insert the event row, keyed by `id` (insert-or-ignore).
3. Dispatch it to the queue, or route it inline when no queue is bound.

It returns 200 only after the row is written. Processing is asynchronous: a 200 means "accepted", not "acted on". For `user.deleted`, the tombstone and the suppression are written before the event is recorded (section 4).

### Delivery semantics

- The host delivers at least once. The agent applies effects exactly once: it deduplicates by `id` and claims each effect in its effects ledger.
- The host emits with a 3-second timeout. It never retries, never throws and never blocks the user's request. The nightly pull repairs a lost event, not a retry. A host that wants retries runs them from a queue of its own, reusing the same `id`.
- Events older than 7 days by `occurred_at` are accepted and recorded but flagged `late`. They still route.

### Envelope

```json
{
  "id": "evt_01J9ZK3Q8R5T7V2W4X6Y8Z0A1B",
  "version": 1,
  "type": "user.signed_up",
  "occurred_at": "2026-03-01T12:00:00Z",
  "user": { "id": "usr_7f3a", "email": "ada@acme.example", "name": "Ada Lovelace", "role": "owner" },
  "org": { "id": "acc_19c2", "name": "Acme", "domain": "acme.example", "plan_tier": "free" },
  "ref": "ref_q1launch",
  "data": { "plan": "free", "source": "google" }
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `id` | yes | Globally unique and stable across retries, 1 to 128 printable ASCII characters. A ULID or UUID is recommended |
| `version` | yes | `1` |
| `type` | yes | One of the catalogue below, or `custom.<name>` (lowercase letters, digits, `_`, `.` and `-`) |
| `occurred_at` | yes | ISO 8601; the agent stores it as UTC |
| `user` | yes, except on `custom.<name>` | `id` (1 to 128 printable characters) is required. `email` is required except on `user.deleted`. `name` and `role` are optional |
| `org` | yes, or `null` | The host's tenant. `id` and `name` are required when present. `domain` and `plan_tier` are optional. The agent keeps `plan_tier`; it keys the account by the user's own address domain, never by `org.domain` |
| `ref` | optional | The attribution token the host stored at sign-up (see section 3): 1 to 64 letters, digits, `_` or `-`. `null` when none; any other value is ignored |
| `data` | yes | An object: the type-specific payload below. Unknown keys are kept and ignored |

The agent resolves identity in this order:
1. Tombstones first. An erased person is refused (see section 4).
2. An existing linked `user.id`.
3. The attribution `ref` token, when it names the same mailbox.
4. An email match: the same address, or another `+tag` of the same mailbox.
5. The account domain, which means a new person at a known account.
6. Otherwise, a new inbound contact.

### Event catalogue

| Type | When | `data` |
|------|------|--------|
| `user.signed_up` | A user account is created | `{plan, source?}` |
| `org.created` | A tenant is created (may coincide with sign-up) | `{plan}` |
| `user.activated` | The first value event: the first report generated, the first import, whatever "aha" is for the product | `{event, count?}` |
| `usage.limit_reached` | A plan limit is hit | `{limit, used, period}` |
| `billing.subscribed` | A paid subscription starts | `{plan, interval, amount, currency}`; every `amount` in this catalogue is an integer in the currency's minor unit (cents for USD) |
| `billing.subscription_changed` | The plan or status changes. Only real changes count; a renewal that changes nothing is not an event | `{from_plan, to_plan, status}` |
| `billing.subscription_canceled` | A subscription ends or is set to end | `{plan, ends_at, reason?}` |
| `billing.payment_failed` | A payment attempt fails | `{amount, currency, attempt}` |
| `billing.topup_purchased` | A one-off credit pack is bought | `{sku, amount, currency}` |
| `org.api_key_created` | An API key is created, a strong expansion and technical-buyer signal | `{scopes?}` |
| `feedback.submitted` | In-product feedback or a comment | `{text, context?, rating?}`. `text` is required; the agent keeps at most 4,000 characters of it, as full taint |
| `user.deleted` | A user is erased | See section 4. `user` carries only `id` and `email_sha256` |
| `custom.<name>` | Anything else the host wants the agent to know | Free-form, full taint. Recorded only: nothing subscribes to custom events yet |

`billing.*` events can come from the host (recommended, since the host already knows its customers) or from the agent's own billing adapter webhook. Pick one per deployment, so one payment is not counted twice under two event ids.

### Minimal host implementation

```ts
// Node or an edge runtime. No SDK required; the SDK wraps exactly this.
export async function emitProductEvent(event: ProductEvent): Promise<void> {
  const url = process.env.GTM_EVENTS_URL;
  const secret = process.env.PRODUCT_WEBHOOK_SECRET;
  if (!url || !secret) return;                         // not configured: no-op
  try {
    const body = JSON.stringify(event);
    const sig = await hmacSha256Hex(secret, body);
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature": `sha256=${sig}`, "X-Event-Id": event.id },
      body,
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // never throw into the user's request; the nightly pull repairs misses
  }
}
```

`@gtm-agents/sdk` ([packages/sdk](../packages/sdk/README.md)) exports:
- `createProductEmitter({url, secret})`, which behaves exactly like the function above;
- a typed event builder for every catalogue entry, and `eventProblem()`, which says why the agent would refuse an event;
- `createReadHandler()`, `verifyReadRequest()` and `verifyReadSignature()`, for section 2;
- the `gtm_ref` cookie helpers, for section 3.

## 2. Pull: agent to host (reconciliation)

The push does not retry, so the agent reconciles nightly. It reads up to 3 pages of 200 per resource per run, and the whole history once a week. Each read waits at most 10 seconds, accepts at most 2 MiB, does not follow redirects, and counts any status but 200 as a failure. `PRODUCT_APP_URL` must be an `https` URL with no credentials, query or fragment. The host serves three read-only endpoints under it:

| Endpoint | Returns |
|----------|---------|
| `GET /api/internal/gtm/users?since=<iso>&cursor=<id>&limit=200` | Users joined to their org and plan |
| `GET /api/internal/gtm/feedback?since=<iso>&cursor=<id>&limit=200` | Feedback rows with the author's email |
| `GET /api/internal/gtm/deletions?since=<iso>&cursor=<id>&limit=200` | Completed erasures |

### Signing a read

Each read carries two headers:
- `X-Timestamp: <unix seconds>`
- `X-Signature: sha256=<hex HMAC-SHA256(PRODUCT_READ_SECRET, canonical)>`

The canonical string is:

```
canonical = METHOD + "\n" + PATH + "\n" + SORTED_QUERY + "\n" + TIMESTAMP
```

`SORTED_QUERY` is the query string with keys sorted bytewise and values percent-encoded as sent.

The host:
- rejects timestamps more than 5 minutes from now;
- compares signatures in constant time;
- serves these endpoints from a dedicated query or view, limited to the field whitelists below. They are the one deliberately cross-tenant read path in the host, so they must never be reachable with end-user credentials.

### Field whitelists

Anything outside these lists is not returned, however convenient. Widening a list is a change to this contract.

`users`:

```json
{
  "items": [
    {
      "id": "usr_7f3a",
      "email": "ada@acme.example",
      "name": "Ada Lovelace",
      "role": "owner",
      "created_at": "2026-03-01T12:00:00Z",
      "updated_at": "2026-03-04T08:10:00Z",
      "signup_ref": "ref_q1launch",
      "org": { "id": "acc_19c2", "name": "Acme", "domain": "acme.example", "plan_tier": "pro", "usage_this_period": 14, "flags": { "founding": false, "whitelisted": false } }
    }
  ],
  "cursor": "usr_7f3a"
}
```

`feedback`:

```json
{ "items": [ { "id": "fb_01", "created_at": "...", "author_email": "ada@acme.example", "author_name": "Ada Lovelace", "context": "report:rep_9", "text": "...", "rating": 4 } ], "cursor": "fb_01" }
```

`deletions`:

```json
{ "items": [ { "user_id": "usr_7f3a", "email_sha256": "<hex>", "deleted_at": "2026-03-02T09:30:00Z" } ], "cursor": "usr_7f3a" }
```

Pagination: `cursor` is the last item's id; it is omitted when there is no next page. `since` filters on `updated_at` for users, `created_at` for feedback and `deleted_at` for deletions.

## 3. Attribution

- A link the agent puts in outreach may carry `?ref=<token>`. The token identifies the contact and the touch's campaign. It is opaque and it expires: the agent honors it for 90 days after issuing it. The agent does not add tokens to links yet (`outreach:ref_tokens_enabled` is reserved for it), so a host that implements this part is ready for it.
- The host's middleware copies a valid `ref` from the query string into a first-party cookie on the first request: `gtm_ref`, 30 days, `SameSite=Lax`, `Secure`, `HttpOnly`. At sign-up, the host copies the cookie's value to `users.signup_ref`. The host validates only the token's shape (1 to 64 letters, digits, `_` or `-`); the agent resolves it.
- The host sends the token back as `ref` on `user.signed_up` and `org.created`. While `outreach:ref_tokens_enabled` is on, a token the agent issued to the same mailbox identifies the person, and its campaign is recorded as the sign-up's attribution; a token used by anyone else (a forwarded link) still credits its campaign but never decides who the person is.
- Whether or not a token comes back, every sign-up, activation and payment is credited to the contact's latest first touch in the 60 days before it, and to the experiment arm the contact last received. That is how experiments measure conversions, not just replies.

## 4. Erasure

- When the host erases a user, it emits `user.deleted` with `user: {id, email_sha256}`, and no email or name. `email_sha256` is the hex SHA-256 of the lowercased, trimmed address.
- On receipt, the agent:
  1. writes a tombstone holding only the hash, the product user id and the time;
  2. suppresses the hash;
  3. stops the person's sequences and erases every contact that is the person: drafts, inbound mail and its bodies, event payloads, feedback, billing records (down to a marker) and the contact row itself;
  4. records the erasure in its audit log, with counts only.

  It stores the event itself as its id, time, user id and hash only, and carries it out whatever the deployment's flags say. From then on, any event or enrichment result that resolves to a tombstoned hash or user id is refused.
- The host keeps `deletions` readable for at least 90 days. It is the repair path for a missed `user.deleted`, and the agent's nightly pull applies any deletion it has not seen.
- The agent never sends the host a contact's data. Each direction of the bridge is one-way by design.

## 5. Proof of value (optional)

Some products can show a prospect something concrete before a call: a sample report on their own company, a scan, a benchmark. A host that offers this serves:

`POST {PRODUCT_APP_URL}/api/internal/gtm/proof`

- It is signed like a read, except the canonical string uses the raw body in place of the sorted query.
- The request body is `{ "kind": "<proof kind>", "account_domain": "acme.example", "contact_email": "ada@acme.example", "effect_key": "<agent effect key>" }`.
- The host responds either with `{ "url": "https://...", "expires_at": "...", "summary": "one line the agent may quote" }`, or with `202 {"job_id": "..."}` followed later by a `custom.proof_ready` event carrying the same fields.

Sending a proof to a prospect is a permanently human-only action in the agent: the agent prepares the email, and the operator approves the send. The agent does not call this endpoint yet; it is part of the contract so a host can build it ahead of the agent.

## 6. Product usage and privacy

The agent keeps product usage (activation, limits, usage this period, top-ups, API keys) on the user's own lifecycle row, where it moves their lifecycle state and deal. It derives no signals or openers from product events. Two rules apply everywhere:

- Product usage is never used as an opener to a colleague of the user ("I saw your teammate ran three reports"). It may inform account scoring and the operator's view. It does not appear in copy sent to anyone but the user it belongs to.
- Feedback text is full taint. It is sanitized and fenced, never pasted into a prompt as instructions, and never quoted back to anyone outside the account.

## 7. Test vectors

The secrets below are for tests only. `tests/contract/event-vectors.test.ts` recomputes every vector in this section.

Push, with `PRODUCT_WEBHOOK_SECRET = test-secret-do-not-use`. The body is exactly this (344 bytes, no trailing newline):

```
{"id":"evt_01J9ZK3Q8R5T7V2W4X6Y8Z0A1B","version":1,"type":"user.signed_up","occurred_at":"2026-03-01T12:00:00Z","user":{"id":"usr_7f3a","email":"ada@acme.example","name":"Ada Lovelace","role":"owner"},"org":{"id":"acc_19c2","name":"Acme","domain":"acme.example","plan_tier":"free"},"ref":"ref_q1launch","data":{"plan":"free","source":"google"}}
```

`X-Signature: sha256=6c2586c78f28c1b314a9769809173887cdc8a5822fb0239baf948fd84aca0a19`

Erasure, with the same secret. The body is exactly:

```
{"id":"evt_01J9ZK4D2E6F8G0H2J4K6M8N0P","version":1,"type":"user.deleted","occurred_at":"2026-03-02T09:30:00Z","user":{"id":"usr_7f3a","email_sha256":"2a1322415fff1b1aceaebe7855b2c5bd6e9efa5e787d46391f971aea65062ce3"},"org":null,"ref":null,"data":{}}
```

`X-Signature: sha256=8e8880eb7971dcfaa9d3682c40b57e661ad7eafd41d7d146451dc5e370363272`

Here `2a1322...62ce3` is `sha256("ada@acme.example")`: the address `Ada@Acme.example`, lowercased and trimmed.

Read, with `PRODUCT_READ_SECRET = test-read-secret-do-not-use`, for `GET /api/internal/gtm/users?since=2026-03-01T00%3A00%3A00Z&limit=200` with `X-Timestamp: 1772366400`:

```
canonical = "GET\n/api/internal/gtm/users\nlimit=200&since=2026-03-01T00%3A00%3A00Z\n1772366400"
X-Signature: sha256=4e1acd1ab4d0f676df2045bdf5767b49afc849de516b3b3b4dd91898d3aeac7a
```

## 8. Example host

[`examples/host-nextjs/`](../examples/host-nextjs/) maps the contract onto a Next.js app for the fictional company Acme:
- the emitter wired to sign-up, activation and billing webhooks;
- the `gtm_ref` middleware;
- the three read routes, behind the signature check and a whitelist query;
- the proof route, returning a stub.

The app itself is not in the repository yet. [packages/sdk](../packages/sdk/README.md) has each piece as code, and `tests/contract/sdk-host.test.ts` exercises the host side end to end with invented data.
