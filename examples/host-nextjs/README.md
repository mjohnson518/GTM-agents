# Host application example (Next.js)

The host application is the product a GTM-agents deployment sells. This example will show the whole event contract wired into a Next.js app for the fictional company Acme:

- the product event emitter, called on sign-up, activation and billing webhooks;
- the middleware that copies an outreach `?ref=` token into a first-party cookie and onto the user at sign-up;
- the three signed, read-only reconciliation endpoints (users, feedback, deletions), each behind a field whitelist;
- a stub proof-of-value route.

It uses no real data. The example arrives with the lifecycle milestone.
