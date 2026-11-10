# @gtm-agents/adapters

Vendor integrations. This page is for contributors adding or changing an adapter, and for deployers choosing which adapters to enable. Each adapter implements one or more ports defined in `@gtm-agents/core` ([docs/INTERFACES.md](../../docs/INTERFACES.md)) and is published as a subpath of this package, for example `@gtm-agents/adapters/email-resend`.

## Layout of an adapter

```
packages/adapters/<name>/
  manifest.json      name, ports, capabilities, secrets, flags, per-tool taint and gate, cost table, limits
  index.ts           exports createAdapter(ctx)
  contract.test.ts   runs the shared contract for each port the adapter claims
```

## Rules

- **Adapters translate. They never decide.** Suppression, send windows, caps, the kill switch, budgets, retries and verification policy all live in core. An adapter that checks suppression itself creates a second source of truth.
- **Every paid call reports its cost.** Each result carries `cost`, estimated from the manifest's price table when the vendor reports none. Core checks the budget before the call and records the cost after it.
- **Every tool is classified.** Each tool in the manifest declares the taint its output carries and the taint level at which it is refused. An unclassified tool is treated as fully tainted.
- **Fetch is injected.** Use `ctx.fetch`, never the global `fetch`. That keeps contract tests hermetic and lets core apply a timeout and outbound logging to every call.
- **Idempotency keys come from core.** Side-effecting calls receive an `effectKey` that core has already claimed. Pass it to the vendor as the idempotency key when the vendor supports one.

## Adapters

| Adapter | Ports | What it does |
|---|---|---|
| `operator-telegram` | OperatorChannel | The operator chat over the Telegram Bot API: secret-token webhook, inline approval buttons bound to a digest |
| `llm-gateway` | ModelGateway | Anthropic's Messages API, optionally through Cloudflare AI Gateway, with streaming and tools. It has no embeddings |
| `data-exa` | DiscoverySource | Account and people search, websets, dated news, find-similar and signed search monitor deliveries |
| `data-hunter` | ContactFinder, EmailVerifier, PeopleProvider | Finding and verifying work addresses, and people at a domain |
| `data-jobboards` | SignalSource | Open roles on public Greenhouse, Lever and Ashby boards, as role-kind counts; no key |
| `email-resend` | EmailProvider | Cold and follow-up sends, signed delivery and bounce webhooks, Message-ID lookup for threading |
| `inbox-gmail` | InboxProvider | Reading the reply mailbox, mirroring reply drafts, sending approved replies and push, through the shared `_google-auth` helper |
| `email-cloudflare` | InboxProvider (receive only) | Mail that Cloudflare Email Routing delivers to the Worker |
| `calendar-google` | CalendarProvider | Read-only calendar events with privacy-limited fields |
| `billing-stripe` | BillingProvider | Signed billing webhooks, customer and subscription reads, and checkout links only through the human-only offers path |
| `code-github` | CodeHost | For the optional ship module: one commit per task on the target repository or a fork, pull requests, deploy detection through commit comparison, and signed webhooks; it never merges |
| `sandbox-cloudflare` | CodingSandbox | For the optional ship module: a coding agent in a Cloudflare Container with no credentials, with the profiles `claude-code` and `opencode` |

Each has a hermetic contract test, and none has yet been run against its live provider. `email-gmail` (sends from the warm mailbox), `data-alexandria` (several data providers behind one gateway) and `data-xai` (public-post signals) are planned; [docs/INTERFACES.md](../../docs/INTERFACES.md#adapters) lists every adapter with its details.

`sandbox-cloudflare` also ships the container images under `images/` and the Durable Object and egress classes a deployment exports from its Worker entry ([docs/SHIP.md](../../docs/SHIP.md)), and it is the one adapter with a runtime dependency on a Cloudflare package (`@cloudflare/sandbox`).

`_contract/` holds the shared contract runners (one per port that has one), `recordedFetch` for hermetic tests and `testContext`. Each adapter's `contract.test.ts` runs in `npm test` with recorded responses; nothing reaches the network.
