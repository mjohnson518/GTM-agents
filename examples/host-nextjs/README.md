# Host application example (Next.js)

This page is for developers wiring their product (the host application, the product a GTM-agents deployment sells) to its deployment. It maps the event contract ([docs/EVENT-CONTRACT.md](../../docs/EVENT-CONTRACT.md)) onto a Next.js app for the fictional company Acme, piece by piece, with the `@gtm-agents/sdk` function that implements each one ([packages/sdk](../../packages/sdk/README.md)):

| Piece | Where it goes in a Next.js app | SDK |
|---|---|---|
| The product event emitter, called on sign-up, activation, plan limits and billing webhooks | Server code that creates users and handles billing | `createProductEmitter` and the event builders (`userSignedUp`, `userActivated`, `usageLimitReached`, `billingSubscribed` and the rest) |
| The middleware that copies an outreach `?ref=` token into the first-party `gtm_ref` cookie, and onto the user at sign-up | `middleware.ts`, and the sign-up handler | `refCookieToSet`, `refFromCookies` |
| The three signed, read-only reconciliation endpoints (users, feedback, deletions), each cut down to its field whitelist | `app/api/internal/gtm/[resource]/route.ts` | `createReadHandler` |
| A stub proof-of-value route | `app/api/internal/gtm/proof/route.ts` | No helper yet: the call is signed like a read but over the raw body, so check it with `hmacSha256Hex` and `timingSafeEqual` ([section 5](../../docs/EVENT-CONTRACT.md#5-proof-of-value-optional)). The deployment does not make this call yet |

The app itself is not in this folder yet. The SDK README shows each piece as code, and `tests/contract/sdk-host.test.ts` exercises the host side end to end. Everything here is fictional: Acme, `*.example` addresses and invented people, never real data.
