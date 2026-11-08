# @gtm-agents/adapters

Vendor integrations. Each adapter implements one or more ports defined in `@gtm-agents/core` and is published as a subpath of this package, for example `@gtm-agents/adapters/email-resend`.

## Layout of an adapter

```
packages/adapters/<name>/
  manifest.json      name, ports, required secrets, flags, per-tool taint and gate, cost table, limits
  index.ts           exports createAdapter(ctx)
  contract.test.ts   runs the shared contract for each port the adapter claims
```

## Rules

- **Adapters translate. They never decide.** Suppression, send windows, caps, the kill switch, budgets, retries and verification policy all live in core. An adapter that checks suppression itself creates a second source of truth.
- **Every paid call reports its cost.** The manifest declares the price table, so core can check the budget before the call and record the spend after it.
- **Every tool is classified.** Each agent-facing tool declares the taint its output carries and the taint level at which it is blocked. An unclassified tool is treated as fully tainted.
- **Fetch is injected.** Use `ctx.fetch`, never the global `fetch`. That keeps contract tests hermetic and lets core apply timeouts, SSRF checks and logging.
- **Idempotency keys come from core.** Side-effecting calls receive an `effectKey` that core has already claimed. Pass it to the vendor as the idempotency key when the vendor supports one.

## Adapters

| Adapter | Ports |
|---|---|
| `email-resend` | EmailProvider |
| `email-gmail` | EmailProvider (warm mailbox sends) |
| `email-cloudflare` | InboxProvider (inbound routing only) |
| `inbox-gmail` | InboxProvider |
| `operator-telegram` | OperatorChannel |
| `data-exa` | DiscoverySource |
| `data-alexandria` | PeopleProvider, CompanyProvider, ContactFinder, SignalSource |
| `data-hunter` | ContactFinder, EmailVerifier, PeopleProvider |
| `data-xai` | SignalSource |
| `calendar-google` | CalendarProvider |
| `billing-stripe` | BillingProvider |
| `llm-gateway` | ModelGateway |

## Status

Available now: `operator-telegram`, `llm-gateway` (Anthropic), `data-exa` (search) and `data-hunter` (finder, verifier and people at a domain). The others are planned; [docs/INTERFACES.md](../../docs/INTERFACES.md#v1-adapters) has the details.

`_contract/` holds the shared contract runners (one per port), `recordedFetch` for hermetic tests and `testContext`. Each adapter's `contract.test.ts` runs in `npm test` with recorded responses; nothing reaches the network.
