# Lifecycle: sign-ups, payments, the event spine and billing

This page is for deployers connecting their product and billing to a deployment, for host-application developers wiring the product side, and for contributors changing how product and billing events move contacts and deals. It covers the lifecycle states and what moves them, the event spine, connecting a product (with [EVENT-CONTRACT.md](EVENT-CONTRACT.md) and the SDK in [`packages/sdk/`](../packages/sdk/README.md)), identity resolution, the deal mirror, billing through the port, MRR, erasure, and the flags, jobs and limits involved. The code lives in `packages/core/src/lifecycle/` (`@gtm-agents/core/lifecycle`), `packages/core/src/product-bridge/`, `packages/core/src/billing/`, the spine in `packages/core/src/events/`, and the product metrics in `packages/core/src/metrics/product.ts`.

## What it does

```
host application                         GTM-agents Worker
user signs up, pays, hits a limit  --->  POST /api/webhooks/product   (signed, one attempt)
billing provider                   --->  POST /api/webhooks/billing   (the billing adapter verifies)
                                           record: payload to R2, then the events row (insert-or-ignore)
                                           dispatch: EVENTS_QUEUE, or inline
                                           route: who is it? (tombstones first) -> the lifecycle writer
                                             -> state, cold outreach stopped, deal mirror, funnel event,
                                                warmth, erasure
nightly                            <---  signed GETs: deletions, users, feedback (the repair path)
every 5 minutes                          sweep: unrouted events older than 5 minutes
hourly / daily                           stalled and dormant checks, MRR snapshot, payload retention
```

No model is called anywhere in this path, and nothing here sends mail.

## Lifecycle states

Every contact has at most one lifecycle row (`contact_lifecycle`). Before sign-up a contact is `sighted`, `qualified`, `parked`, `contacted`, `engaged`, `nurturing` or `opted_out`; in the product, `signed_up`, `stalled`, `activated`, `at_wall`, `paying`, `expanding`, `at_risk` or `churned`; `deleted` is terminal. A contact with no row counts as `sighted`. The paying states are `paying`, `expanding` and `at_risk`.

| Event | From | To |
|---|---|---|
| qualified | sighted, parked | qualified |
| parked | sighted, qualified | parked |
| outreach sent | sighted, qualified, parked, nurturing | contacted |
| replied | contacted, nurturing | engaged |
| meeting booked | any state before sign-up but opted_out | engaged |
| sequence exhausted | contacted | nurturing |
| unsubscribed | any state before sign-up | opted_out |
| signed up | any state before sign-up | signed_up |
| first value event | signed_up, stalled | activated |
| stalled check (72 hours without a value event) | signed_up | stalled |
| limit reached | signed_up, stalled, activated | at_wall |
| subscribed | any but deleted | paying |
| subscription changed | paying states | expanding (up) or paying (down) |
| payment failed | paying, expanding | at_risk |
| canceled | paying states | churned |
| dormant (14 days idle) | paying, expanding / activated, at_wall | at_risk / stalled |
| recovered | at_risk | paying |
| user deleted | any | deleted |

Anything else is no move. Opting out ends the lifecycle before sign-up only: a product user stays in their product state, and suppression is what stops mail to them.

**One writer.** `applyLifecycleEvent` in `lifecycle/apply.ts` is the only code that writes `contact_lifecycle` and `lifecycle_transitions`:
- it reads the state, computes the move, and writes with a compare-and-set, retrying when another writer got there first;
- every call names its cause (a product event id, a billing event, a booked meeting), and the write claims that cause in the effects ledger in the same batch, so a cause delivered or routed again never moves anyone a second time, even after the state has moved on;
- `product_user_id`, the attribution (method and campaign) and `signup_ref` keep their first value; `signed_up_at`, `activated_at`, `first_paid_at` and `churned_at` are set once; `last_active_at` only moves forward;
- the transition row is written in the same batch as the state.

**What a move does.** Each side effect is claimed under the transition's id and released if it fails, so a retry runs only what did not finish:
- **stop:** entering a product state from before sign-up (or opting out) ends the contact's cold sequences, cancels their queued cold and sequence sends and rejects their open cold and follow-up drafts;
- **deal:** the deal mirror (below);
- **funnel:** a `funnel_events` row for the conversion report and the product metrics: `signed_up`, `activated` and `subscribed` at most once per contact ever, `limit_reached` and `churned` per move. Each row records the first touch it is credited to and the experiment arm the contact last received, if any;
- **warmth:** the state's warmth summary, forward only (`advanceWarmth`): hot from sign-up, customer from paying, churned on churn;
- **erase:** entering `deleted` runs the erasure (below).

A booked meeting (calendar sync, [CONVERT.md](CONVERT.md)) moves each attributed contact who has not signed up to `engaged` through the same writer, under the meeting's key.

## The event spine

Every product and billing event takes the same path ([ARCHITECTURE.md](ARCHITECTURE.md#the-event-spine)):

1. **Record.** The raw payload goes to R2 under `events/<source>/`, then the `events` row is inserted with insert-or-ignore, keyed by source and the provider's event id. A redelivery is a duplicate and is not dispatched again. A billing payload is stored with the customer's address replaced by its hashes.
2. **Dispatch** to `EVENTS_QUEUE`, carrying only the row id, or route inline after the response when no queue is bound. A failed dispatch is repaired by the sweep.
3. **Route** under a lease that goes stale after 10 minutes, only while the source's flags are on (an unreadable flag leaves the event waiting without spending an attempt). Erasures need no flag. After 5 failed attempts the event is parked, never picked up again, and audited (`event_parked`). A parked or long-unrouted product event holds product conclusions in measurement health ([MEASUREMENT.md](MEASUREMENT.md#measurement-health)).
4. **Sweep** every 5 minutes: unrouted events older than 5 minutes are routed again.

Each row carries a taint level: feedback and custom events are `full`, everything else `structured`. Payloads of routed and parked events are deleted from R2 after 90 days; the rows stay. An erasure's payload holds only its id, time, user id and address hash.

## Connecting a product

The wire contract is [EVENT-CONTRACT.md](EVENT-CONTRACT.md). The host installs `@gtm-agents/sdk` ([its README](../packages/sdk/README.md)) or implements the contract by hand.

1. Set the secrets on the deployment, two different values:

   ```bash
   npx wrangler secret put PRODUCT_WEBHOOK_SECRET   # the host signs pushes with it
   npx wrangler secret put PRODUCT_READ_SECRET      # the agent signs nightly reads with it
   ```

   and `PRODUCT_APP_URL` (an `https` URL with no credentials or query) as a var in `wrangler.jsonc`. Give the host the same two secrets and the agent's webhook URL, `{AGENT_BASE_URL}/api/webhooks/product`.
2. Wire the lifecycle in `apps/worker/src/index.ts` (below), deploy, then turn it on:

   ```bash
   npx gtm flags set lifecycle:enabled true
   npx gtm flags set lifecycle:reconcile_enabled true   # once the host serves the read endpoints
   ```

**The push.** `POST /api/webhooks/product` checks, in order: the secret is set (else 503); `X-Signature` is the HMAC of the raw body, compared in constant time (else 401); the body is JSON and `X-Event-Id` equals `body.id` (else 400 or 401); the envelope has the contract's shape (else 400); `lifecycle:enabled` is on (else 503, recording nothing). A `user.deleted` is the exception: an erasure is a compliance action and never waits on an opt-in flag, so whatever the flags its tombstone and suppression are written at once, and the event is recorded and routed to the full erasure (below). Then it records and dispatches, and answers `200 {"ok":true,"duplicate":false}`, or `duplicate: true` for an id it already holds. An event more than 7 days old is recorded, flagged late (`"late": true` in the answer and on the stored payload) and still routed.

**What each event does.**

| Event | Lifecycle | Fields |
|---|---|---|
| `user.signed_up` | signed up, with the attribution | plan, product user and org |
| `org.created` | none | org and plan |
| `user.activated` | activated (recovered, for an at-risk customer whose subscription is still active) | activation event and count, last active |
| `usage.limit_reached` | at the wall (likewise recovered) | the limit, how much was used, the period |
| `billing.subscribed` | paying | plan, status active, MRR from `amount` (minor units) and `interval`, else the plan's list price |
| `billing.subscription_changed` | canceled, payment failed or recovered when the status says so; otherwise expanding or paying by list price | plan, status, MRR from the list price |
| `billing.subscription_canceled` | churned | status canceled, MRR 0; the reason is kept as an enum only |
| `billing.payment_failed` | at risk | status past due |
| `billing.topup_purchased`, `org.api_key_created` | none | usage fields |
| `feedback.submitted` | none | filed for the ship loop (below) |
| `user.deleted` | deleted | the erasure (below) |
| `custom.<name>` | none | recorded; nothing subscribes to custom events yet |

Any of these but `user.signed_up` proves the person has an account, so a contact still before sign-up is signed up first: events can arrive out of order, and users can predate the bridge.

**Feedback** is full taint. Its text is stored in `feedback_items` (source `product`) and nowhere else: not in a contact, an audit row or an operator message. Whatever reads it later fences it as untrusted data. The same feedback arriving by push and by the nightly pull is filed once.

**Product usage stays with its user.** Usage fields live on that person's own lifecycle row. Nothing in the lifecycle writes copy, and product usage is never used as an opener to a colleague.

**The pull** (`lifecycle_reconcile`, nightly) reads the host's three endpoints with signed GETs: deletions first, so nothing after can touch a person erased in the product; a deletion row that fails stops the pull for the night, so it is read again before anything moves past it, and nothing after deletions runs that night; then users (a sign-up the push missed is applied with its `signup_ref`; an org showing usage this period activates a user still signed up or stalled; org and plan are kept); then feedback, filed only when its author is an existing contact, so an erasure always finds it. Each resource keeps its place in KV (`lifecycle:pull:<resource>`): a pass reads from the last completed pass's high-water mark, follows the host's cursor, saves its place after every page, and continues the next night when it hits the per-run cap of 3 pages of 200. The mark only advances when a pass finishes. Once a week a pass starts from nothing, because a host may change a row without moving `updated_at`. The pull repairs sign-ups, activation, plans and erasures; billing state comes from billing events.

## Identity resolution

Who an event is about, in order, with erasure checked first:

1. **Tombstones.** A person erased by product user id, by address, or by another `+tag` of the same mailbox is refused. Nothing is written, and the event's payload is deleted.
2. **Linked.** A lifecycle row already carries this product user id.
3. **Attribution token.** The event's `ref` is a token the agent issued (in `ref_tokens`, at most 90 days old) whose contact is this same mailbox. A token used by anyone else, such as a forwarded link, still credits its campaign but never decides who the person is. Read only while `outreach:ref_tokens_enabled` is on.
4. **Email.** A contact with this address, or another `+tag` of the same mailbox.
5. **Domain.** The address's domain is a known account: a new contact at that account.
6. **Inbound.** Anyone else: a new contact.

The account is always the sign-up address's own domain, never the org's self-declared `domain`, and a personal mailbox is never an account. A new contact's name is reduced to plain name characters. An address that does not parse is skipped. Contacts are created here and never updated. The agent trusts the identities the host signs, so the host should send events only for addresses it has verified.

## The deal mirror

| State | Deal stage |
|---|---|
| signed_up | trial |
| at_wall | proposal |
| paying, expanding | closed_won |
| churned | closed_lost, loss reason `churned` |

The contact's open deal steps one stage at a time through `transitionDeal`, so every step writes a `deal_stage_history` row, and never moves backwards. With no open deal, one is created for every target but a loss, claimed per contact so two moves racing cannot create two: the mirror creates at most one deal per contact, ever. The insert checks for an open deal and creates one in a single statement, and calendar sync's deal creation does the same, so a booked meeting and a sign-up racing on one contact leave one open deal; each writer reads the stage again before every step. A contact who already has a won deal never gets another, and a churn does not close their other deals: the sale happened, and churn lives in the lifecycle.

## Billing

Billing is a port, `BillingProvider` ([INTERFACES.md](INTERFACES.md#billingprovider)); core holds no vendor code. `POST /api/webhooks/billing` hands the request to the adapter's `parseWebhook`, which must verify the signature (5-minute tolerance, constant time) before reading anything else and throw an `AdapterError`: `auth` for a missing, bad or stale signature (the route answers 401), `invalid` for a payload it cannot map (400), `unavailable` when its secret is unset (503). With `billing:enabled` or `lifecycle:enabled` off the route answers 503 and records nothing. An event the adapter maps to `ignored` is acknowledged and not recorded.

An adapter maps vendor events to `BillingEvent`:
- `checkout_completed`, `subscription_created`, `subscription_updated`, `subscription_canceled`, `payment_failed`, or `ignored`;
- amounts as integers in the currency's minor unit, with `interval` (`day`, `week`, `month` or `year`);
- `email` when the vendor's payload carries it;
- `providerEventId`, the vendor's stable event id.

Routing, claimed under the event's id:
1. **Who.** The billing customer row for (provider, customer id) names the contact once linked; otherwise the address hashes find an existing contact. Billing resolves contacts and never creates one; an unknown customer is recorded without a contact.
2. **Erased people are refused**, by the event's address, the customer row's address hash, or the contact's own address. Nothing is written about them, and the payload is deleted.
3. **What it means**, against the customer row as it was before (only real status changes count, and an event older than the last one seen changes no status). Any billing event signs a contact up first if they had not; then:
   - `checkout_completed`: nothing more;
   - `subscription_created` when active, or `subscription_updated` turning active from trialing or incomplete: subscribed;
   - active after past due: recovered;
   - past due or unpaid: payment failed;
   - canceled: churned;
   - still active with a different MRR: expanding or paying.

   An erasure reduces the person's billing customer record to a marker (the provider and a hash of the customer id), so a later event for that customer is refused even when it carries no address.

   MRR comes from the amount by its interval, else the plan's list price.

Creating a checkout link is an offer, so it is permanently human-only: core never calls `createCheckoutLink`. Pick one source of `billing.*` events per deployment, the host or the billing adapter, so one payment is not reported twice under two event ids.

## MRR

A contact's MRR is `contact_lifecycle.mrr_cents`. Monthly recurring revenue is the sum over contacts in a paying state, and paying customers is how many there are (`currentMrr`, the one definition). `mrr_snapshot` writes one `mrr_snapshots` row per UTC day; a rerun the same day replaces it. MRR assumes the deployment bills in one currency.

## Measurement

Sign-ups, activations and new paying customers each have one definition (`metrics/product.ts`): the funnel events above, from the product bridge or billing only, at most once per contact. Each is credited to the contact's latest first touch sent in the 60 days before it, the same rule as replies, recorded when the outcome is written so the credit survives an erasure. The daily scorecard shows them week to date and over 30 days, with how many came from outreach, once the product bridge has delivered an event; until then those lines say "not measured yet". Holdout lift's sign-up rate counts the same sign-ups ([MEASUREMENT.md](MEASUREMENT.md)).

## Erasure

A product erasure (`user.deleted`, or a row from the deletions pull):
1. writes the tombstone first, with the address hash and the product user id, so every later event, pull row and billing event naming the person is refused (a route that was resolving the person while the erasure arrived checks again when it finishes, and erases what it wrote);
2. suppresses the hash (no address is kept);
3. moves every contact that is the person (linked by user id, or holding the hash as address or mailbox) to `deleted`, which stops their sequences and runs the erasure ([DATA-MODEL.md](DATA-MODEL.md#erasure)): drafts, inbound mail and bodies, event payloads about them, feedback filed under their product user id, the contact row itself, and their billing customer records down to a marker;
4. with no such contact, erases by hash alone;
5. writes an audit row with counts only.

Running it again changes nothing. None of it waits on `lifecycle:enabled`: the webhook, the sweep and the pull's deletions carry out an erasure whatever that flag says.

## Turning it on

In `apps/worker/src/index.ts`:

```ts
import { createLifecycle } from "@gtm-agents/core/lifecycle";

const lifecycle = createLifecycle<Env>({
  // Monthly list price in cents per plan: the MRR fallback, and what makes a plan change an upgrade.
  prices: { free: 0, pro: 4900, team: 19900 },
  // The EVENTS_QUEUE names from wrangler.jsonc, one per environment.
  eventsQueue: ["gtm-agent-events", "gtm-agent-staging-events"],
  // billing: (env) => createBillingAdapter(context(env, "billing-<vendor>")),   // when you have one
});

export default createWorker(config, {
  jobs: [/* the other jobs */ ...lifecycle.jobs],
  lifecycle,
  // ...
});
```

Without `lifecycle` both webhooks answer 503. Without `billing` the billing route answers 503.

## Flags

| Flag | Default | What it turns on |
|---|---|---|
| `lifecycle:enabled` | off | The product webhook, routing, the lifecycle writer's moves from product and billing events, and the lifecycle jobs. Erasures are carried out whatever it says |
| `lifecycle:reconcile_enabled` | off | The nightly pull (needs `PRODUCT_APP_URL` and `PRODUCT_READ_SECRET`; with `lifecycle:enabled` off it reads deletions only) |
| `billing:enabled` | off | The billing webhook and routing billing events (also needs `lifecycle:enabled`) |
| `outreach:ref_tokens_enabled` | off | Attribution tokens: identity resolution reads them only while it is on |

An unreadable flag counts as off. `lifecycle:pull:<resource>` holds the pull's place: a rebuildable cache.

## Jobs

| Job | Schedule (UTC) | Flag | Ceilings |
|---|---|---|---|
| `event_sweep` | every 5 minutes | none: each source's own flags decide what routes, so with `lifecycle:enabled` off only erasures do | 100 events, 2 minutes |
| `lifecycle_checks` | hourly at :20 | `lifecycle:enabled` | 200 stalled and 200 dormant, 2 minutes |
| `lifecycle_reconcile` | 03:15 daily | `lifecycle:reconcile_enabled` | 3 pages of 200 per resource, 10 minutes |
| `mrr_snapshot` | 23:55 daily | `lifecycle:enabled` | one row, 30 seconds |
| `event_retention` | 03:50 daily | `lifecycle:enabled` | 500 payloads, 2 minutes |

None calls a model or spends, and each is safe to rerun. Change a schedule with `createLifecycle({ schedules: { ... } })`.

## Limits

- **Stripe is the one billing adapter** (`billing-stripe`: signed webhooks, customer and subscription reads). Another provider is one folder under `packages/adapters`, behind the same port.
- **No attribution tokens are issued yet.** Identity resolution reads `ref_tokens`; putting `?ref=` on outreach links belongs to the composer, behind `outreach:ref_tokens_enabled`.
- **Lifecycle follow-ups** (first-use nudges, a usefulness check, re-engage, at-risk check-ins) come from approved `lifecycle` templates, under `lifecycle:followups_enabled`, with gaps, a monthly cap and each kind's autonomy class; upgrade and win-back offers are always drafts a person approves. No lifecycle templates ship; write your own.
- **The pull cannot see billing state.** The users endpoint has no subscription status, so a missed payment event is repaired only by the billing provider's own redelivery.
- **A cancellation counts when it arrives**, even when the subscription runs to the end of its period.
- **Pre-sign-up moves other than a booked meeting** (qualified, outreach sent, replied, sequence exhausted, unsubscribed) are in the table, but nothing calls them yet.
