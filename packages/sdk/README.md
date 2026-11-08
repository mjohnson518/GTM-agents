# @gtm-agents/sdk

The package a host application installs. The host application is the product being sold. The SDK lets it talk to its GTM-agents deployment over the event contract:

- **Product events (push).** An emitter posts signed events (sign-ups, activation, plan limits, billing changes, feedback, erasures) to the deployment. It never throws into a user's request and never blocks it.
- **Reconciliation reads (pull).** A helper verifies the signature on the deployment's nightly read requests, so the host can serve its users, feedback and deletions endpoints safely.
- **Typed event builders**, one for each event in the catalogue.

The SDK has no Cloudflare dependency. It runs in Node, edge runtimes, Bun and Deno. Lint enforces this.

## Status

This package is a scaffold. The emitter, the signature helpers and their test vectors arrive with the lifecycle milestone.
