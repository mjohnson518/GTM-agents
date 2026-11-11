# Ports and adapters

This page is for contributors writing an adapter, and for the coding agents they use: it is the contract between `packages/core` and everything that talks to a third party. Core depends only on the interfaces below, which `packages/core/src/ports/` publishes (`@gtm-agents/core/ports`). Each vendor integration is an adapter in `packages/adapters/<name>/`. An adapter implements one or more ports, ships a `manifest.json`, and passes the shared contract test for each port it claims.

[ARCHITECTURE.md](ARCHITECTURE.md) describes the behavior these interfaces carry: the send function, webhook handling, the email waterfall, operator approvals and the safety controls.

## Rules

1. **Core never imports a vendor SDK.** Not an email provider's, not a payment provider's, not an AI SDK. `packages/core/package.json` has no vendor dependency, and a lint rule (`no-restricted-imports`) enforces it.
2. **Adapters never make decisions.** An adapter translates a port call into a vendor request, and a vendor response or webhook into typed records. Every policy lives in core: suppression, send windows, caps, the kill switch, verification policy, budgets, circuit breakers and retries. An adapter that checks suppression itself is a bug, because then two places can disagree.
3. **Every call is accounted for.** A port method that can cost money or credits returns `cost` in its result, and the adapter's manifest declares the price table it estimates from. Core's budget gate checks the job's budget before the call and records the reported cost in the cost ledger after it.
4. **Every tool is classified.** An adapter that contributes agent tools declares, for each tool, the taint its output carries and the taint level at which the tool is refused. An unclassified tool is treated as fully tainted and refused once anything untrusted has been read. Raw web content, inbound email bodies and product feedback are always `full`.
5. **Idempotency comes from core.** Side-effecting calls receive an `effectKey` that core has already claimed in the effects ledger. The adapter passes it to the vendor as the idempotency key when the vendor supports one, and otherwise ignores it.
6. **Fetch is injected.** Adapters use `ctx.fetch`, never the global `fetch`. That keeps contract tests hermetic, and lets core wrap every outbound call with a timeout (20 seconds by default, plus the caller's abort signal) and logging of the method, host and status, never headers or bodies. A URL an agent tool is given is checked by the action gate before the call ([SECURITY-MODEL.md](SECURITY-MODEL.md)).
7. **Interfaces change additively.** New optional fields and new optional methods are fine. Renaming or removing anything is a major version of `@gtm-agents/core`, recorded in [DECISIONS.md](DECISIONS.md).

## Shared types

```ts
export type TaintLevel = "none" | "metadata" | "structured" | "full";

export interface AdapterContext {
  /** Named secret from the Worker environment; throws when it is missing, so a call never goes out half-authenticated. */
  secret(name: string): string;
  /** Optional secret; undefined when unset. */
  optionalSecret(name: string): string | undefined;
  /** Injected fetch. Core wraps it with timeouts and outbound logging. */
  fetch: typeof fetch;
  now(): Date;
  logger: {
    debug(msg: string, data?: Record<string, unknown>): void;
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
  };
  /** Non-secret adapter options from gtm.config.ts (`adapters.<name>.options`). */
  options: Record<string, unknown>;
}

export interface Cost {
  provider: string;
  capability: string;
  credits?: number;
  usd?: number;
  units?: number;            // rows, tokens, emails: whatever the price table counts
}

export type AdapterErrorCode =
  | "auth" | "rate_limited" | "quota" | "not_found" | "invalid"
  | "unavailable" | "timeout" | "unknown";

/** Tokens a vendor billed for a call that then failed. */
export interface BilledUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly usage: BilledUsage | undefined;  // what the vendor billed before the call failed, so core still records its cost

  constructor(
    message: string,
    code: AdapterErrorCode,
    retryable: boolean,
    options: { retryAfterMs?: number; cause?: unknown; usage?: BilledUsage } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AdapterError";
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = options.retryAfterMs;
    this.usage = options.usage;
  }
}

export interface Page<T> {
  items: T[];
  cursor?: string;            // undefined when there is no next page
  cost?: Cost;
}

export interface Evidence {
  url?: string;
  quote?: string;             // short; core sanitizes it before storage
  provider: string;
  retrievedAt: string;        // ISO 8601
}
```

Every record an adapter returns is raw data to core. Core sanitizes strings, assigns taint, deduplicates and decides what to store. Adapters do not sanitize.

## Adapter manifest

`packages/adapters/<name>/manifest.json` is validated by the manifest schema in core (`manifestSchema` in `packages/core/src/ports/manifest-schema.ts`) and checked by `gtm doctor`. The `inbox-gmail` manifest, as it ships:

```json
{
  "name": "inbox-gmail",
  "version": "0.1.0",
  "ports": ["InboxProvider"],
  "capabilities": ["list", "threads", "drafts", "send", "watch"],
  "requiredSecrets": ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"],
  "optionalSecrets": ["GMAIL_PUBSUB_TOPIC", "MAIL_PUSH_SECRET"],
  "flags": ["inbox:enabled"],
  "tools": {
    "gmail_thread_read": { "taint": "full", "gate": "never", "rateCategory": "mail" },
    "gmail_draft_write": { "taint": "none", "gate": "full", "rateCategory": "mail" },
    "gmail_reply_send": { "taint": "none", "gate": "metadata", "rateCategory": "mail" }
  },
  "costs": {
    "read": { "usd": 0, "per": "API request (Gmail API quota units, no per-call price)" },
    "send": { "usd": 0, "per": "email sent from the mailbox" }
  },
  "limits": { "perSecond": 5 },
  "webhook": { "path": "/api/webhooks/mail", "signature": "shared-secret" },
  "contract": "./contract.test.ts"
}
```

| Field | Meaning |
|---|---|
| `name`, `version` | The adapter's kebab-case name, as in `gtm.config.ts` (`adapters.<name>`), and a semantic version. Required |
| `ports` | The ports it implements, at least one. Required |
| `capabilities` | The optional methods and features it supports. A contract runner checks them against what the adapter actually implements |
| `requiredSecrets`, `optionalSecrets` | Worker secret names. `gtm setup` and `gtm doctor` ask for the required ones while the adapter is enabled in `gtm.config.ts` |
| `flags` | The flags that gate the jobs using the adapter. `gtm doctor` lists them |
| `tools.<name>.taint` | The taint the tool's output gives the session: `none`, `metadata`, `structured` or `full`. Required |
| `tools.<name>.gate` | The lowest session taint at which the tool is refused: `never` for read-only tools, then `metadata`, `structured` or `full`. Omitted means `metadata`, so the tool is refused as soon as anything untrusted has been read. A threshold can only block more as taint rises, so gates never loosen |
| `tools.<name>.egress` | `url` if the tool fetches a URL it is given, `query` if it sends free text to a search service. Every URL is checked against internal and reserved addresses. Once the session has read anything from outside (metadata taint and up), core refuses URLs that carry data out (an email address, an encoded blob, a long query string, an oversized hostname) and any input that carries an email address or an encoded blob. An egress tool must declare a `rateCategory` |
| `tools.<name>.humanOnly` | The action gate refuses the call unless it carries an approval whose digest matches the exact input |
| `tools.<name>.rateCategory` | The rate-limit bucket the call counts against. It also marks the tool as a paid third-party call, which the budget gate checks before it runs |
| `costs` | The price table: what each capability costs, per unit. The adapter estimates a call's `cost` from it when the vendor does not report one |
| `limits` | `batchSize` (the most items one call takes; core chunks to it) and `perSecond` |
| `webhook` | The adapter's inbound webhook route, under `/api/webhooks/`, and its signature scheme |
| `contract` | The adapter's contract test file. Required |

An adapter with no `tools` is called only by core's jobs and routes.

## Ports

### DiscoverySource

Finds accounts and people from the open web or a data provider, for the sourcing stage. Capabilities are optional and declared in the manifest under `capabilities`.

```ts
export interface DiscoveryQuery {
  kind: "account" | "person";
  text: string;                       // natural-language or keyword query
  segment?: string;                   // brain segment id, for attribution
  domains?: string[];                 // restrict to these domains when supported
  excludeDomains?: string[];
  limit: number;
}

export interface Candidate {
  kind: "account" | "person";
  name: string;
  domain?: string;                    // lowercased registrable domain when known
  url?: string;
  title?: string;                     // person only
  accountName?: string;               // person only
  summary?: string;
  evidence: Evidence[];
  providerRef: string;                // provider's own id, for dedup and later lookups
}

export interface ResearchDossier {
  subject: { kind: "account" | "person"; name: string; domain?: string };
  facts: Array<{ field: string; value: string; evidence: Evidence[] }>;
  rawTextRefs: string[];              // blob keys core wrote; raw pages are never inlined
  cost?: Cost;
}

export interface WatchHandle { id: string; provider: string; createdAt: string }

export interface DiscoverySource {
  readonly name: string;
  search(q: DiscoveryQuery): Promise<Page<Candidate>>;
  /** Deep research on one subject. Optional capability "research". */
  research?(subject: { kind: "account" | "person"; name: string; domain?: string; urls?: string[] }): Promise<ResearchDossier>;
  /** Standing queries (websets, monitors). Optional capability "watch". */
  createWatch?(q: DiscoveryQuery): Promise<WatchHandle>;
  pollWatch?(handle: WatchHandle, since?: string): Promise<Page<Candidate>>;
  deleteWatch?(handle: WatchHandle): Promise<void>;
}
```

### SignalSource

Produces time-stamped events about accounts or people: a job change, hiring, funding, a public post, news. Signals give a first touch its dated reason ([SIGNALS.md](SIGNALS.md)). In this release the signal jobs read their sources through `DiscoverySource` capabilities (websets, news, find-similar, monitors) and the `HiringBoardSource` interface in `@gtm-agents/core/signals`; `poll` is declared for sources that produce events directly, and no core job calls it yet.

```ts
export type SignalType =
  | "job_change" | "hiring" | "funding" | "launch" | "post" | "news"
  | "filing" | "product_usage" | "custom";

export interface Signal {
  type: SignalType;
  accountDomain?: string;
  personRef?: { name: string; url?: string; email?: string };
  occurredAt: string;
  summary: string;                    // provider text; core sanitizes it and taints it as full
  url?: string;
  evidence: Evidence[];
  providerRef: string;
}

export interface SignalSource {
  readonly name: string;
  poll(args: { since: string; accountDomains?: string[]; limit: number }): Promise<Page<Signal>>;
}
```

### PeopleProvider and CompanyProvider

Structured B2B data: people search and match, and firmographics. Many vendors can sit behind one gateway adapter. Spend limits belong to core, not to the adapter: every call goes through the calling job's spend gate and daily cap. Enrichment uses `searchPeople` to find people at an account's domain (`data-hunter` implements it). `CompanyProvider` has no adapter and no caller in this release; it is declared so a firmographics source has one shape.

```ts
export interface PersonFilters {
  titles?: string[];
  seniority?: string[];
  accountDomains?: string[];
  locations?: string[];
  keywords?: string[];
  limit: number;
}

export interface PersonRecord {
  firstName?: string;
  lastName?: string;
  fullName: string;
  title?: string;
  seniority?: string;
  accountName?: string;
  accountDomain?: string;
  location?: string;
  profileUrl?: string;
  email?: string;                      // only when the provider returned one; unverified
  attributes: Record<string, unknown>; // provider-specific extras, stored under contacts.attributes
  evidence: Evidence[];
  providerRef: string;
}

export interface CompanyRecord {
  name: string;
  domain: string;
  description?: string;
  industry?: string;
  employeeRange?: string;
  foundedYear?: number;
  location?: string;
  fundingStage?: string;
  attributes: Record<string, unknown>;
  evidence: Evidence[];
  providerRef: string;
}

export interface PeopleProvider {
  readonly name: string;
  searchPeople(filters: PersonFilters, cursor?: string): Promise<Page<PersonRecord>>;
  matchPerson(identity: { fullName?: string; accountDomain?: string; profileUrl?: string; email?: string }): Promise<{ record: PersonRecord | null; cost?: Cost }>;
}

export interface CompanyProvider {
  readonly name: string;
  enrichCompany(domain: string): Promise<{ record: CompanyRecord | null; cost?: Cost }>;
}
```

### CompanyResearchSource

Asynchronous company research, beside the ports in `packages/core/src/ports/discovery.ts` (optional capability `company_research`; `data-exa` implements it). The account research job starts a run in one job run and reads it in a later one ([SOURCING.md](SOURCING.md#account-research)). The adapter owns the output schema and the citation rule: it keeps a field only when the provider cites an http or https source for it at medium or high confidence and the value is valid, puts every kept value in `attributes` under its field name, gives each kept field exactly one `FieldEvidence`, and names every other field the provider returned in `dropped`. The request names only the company's domain. Core cleans every value again before storage and stores nothing without a source URL.

```ts
export const RESEARCH_FIELDS = ["employee_range", "employees_count", "hq_country", "founded_year", "industry", "sector",
  "company_type", "funding_stage", "last_round_date", "raised_usd", "technologies", "hiring_functions"] as const;
export type ResearchField = (typeof RESEARCH_FIELDS)[number];

export interface FieldEvidence extends Evidence {
  field: ResearchField;
  url: string;                           // http or https
}

export interface CompanyResearchRecord extends CompanyRecord {
  evidence: FieldEvidence[];             // one per kept field
  verdict: "found" | "not_found" | "cannot_verify";
}

export type CompanyResearchRead =
  | { status: "pending" }
  | { status: "failed"; reason: string; cost?: Cost }
  | { status: "done"; record: CompanyResearchRecord | null; dropped: ResearchField[]; cost: Cost };

export interface CompanyResearchSource {
  readonly name: string;
  startCompanyResearch(args: { domain: string; name?: string }): Promise<{ runId: string; cost: Cost }>;
  readCompanyResearch(runId: string): Promise<CompanyResearchRead>;
  startCost(): Cost;                      // what one start is expected to bill
}
```

`startCost` is what core records when a start fails in a way that may still have created a run (a timeout, a 5xx, an unreadable reply). `startCompanyResearch` reports the cost the run is expected to bill (a fixed price the job can reserve); `readCompanyResearch` reports the run's actual cost when the provider gives one, and core records only what exceeds what the start recorded. A 429 is a retryable `AdapterError` with code `rate_limited`, and a run the provider no longer has is `not_found`.

### ContactFinder and EmailVerifier

The email waterfall calls finders in the configured order until one returns a usable address (the second and later finders only while `discovery:email_waterfall_enabled` is on), then verifies it ([SOURCING.md](SOURCING.md)). Verification semantics (cache lifetimes, confidence grades, the cold floor) belong to core. The adapter maps the vendor's vocabulary onto four statuses and nothing else.

```ts
export interface ContactFinder {
  readonly name: string;
  findWorkEmail(args: { firstName: string; lastName: string; domain: string; profileUrl?: string }):
    Promise<{ email: string; confidence: number; sources: Evidence[]; cost?: Cost } | { email: null; cost?: Cost }>;
}

export type VerificationStatus = "deliverable" | "risky" | "undeliverable" | "unknown";

export interface EmailVerifier {
  readonly name: string;
  verify(email: string): Promise<{
    status: VerificationStatus;
    score?: number;                    // 0 to 100 when the vendor gives one
    reason?: string;                   // vendor code, for the audit row
    acceptAll?: boolean;
    disposable?: boolean;
    cost?: Cost;
  }>;
}
```

### EmailProvider

Outbound email. The send function in core runs every check first (the halt flag, the kill switch, suppression, the content lint, the verification policy, the send window, the caps and the circuit breaker), then calls `sendBatch` in chunks of at most 100 messages, or the adapter's `batchLimit` when that is lower. The adapter sends and parses webhooks. It decides nothing.

```ts
export interface OutboundMessage {
  effectKey: string;                   // claimed by core; the vendor idempotency key where supported
  from: { email: string; name?: string };
  to: { email: string; name?: string };
  replyTo?: string;
  subject: string;
  text: string;                        // plain text only; core has already appended the footer
  headers: Record<string, string>;     // List-Unsubscribe, List-Unsubscribe-Post, In-Reply-To, References
  tags: Record<string, string>;        // contact_id, campaign_id, draft_id, experiment_id, variant_id, seed
  scheduledAt?: string;
}

export type SendOutcome =
  | { effectKey: string; ok: true; providerMessageId: string }
  | { effectKey: string; ok: false; code: AdapterErrorCode; retryable: boolean; detail?: string };

export type EmailEvent =
  | { type: "delivered"; providerMessageId: string; tags: Record<string, string>; to: string; at: string }
  | { type: "bounced"; providerMessageId: string; tags: Record<string, string>; to: string; at: string; hard: boolean; reason?: string }
  | { type: "complained"; providerMessageId: string; tags: Record<string, string>; to: string; at: string }
  | { type: "failed"; providerMessageId: string; tags: Record<string, string>; to: string; at: string; reason?: string }
  | { type: "unsubscribed"; to: string; at: string; tags?: Record<string, string> }
  | { type: "opened" | "clicked"; providerMessageId: string; at: string };   // ignored by core: plain text, no tracking

export interface EmailProvider {
  readonly name: string;
  readonly batchLimit?: number;          // the most messages one sendBatch call takes (the manifest's limits.batchSize); core chunks to it
  sendBatch(messages: OutboundMessage[]): Promise<{ outcomes: SendOutcome[]; cost?: Cost }>;
  /**
   * Verify the webhook signature (vendor scheme, 5-minute replay window) and return typed events.
   * Throws AdapterError("auth") on a bad signature. Core returns 200 only after this resolves.
   */
  parseWebhook(request: Request): Promise<EmailEvent[]>;
  /** Optional: delivery state for reconciliation. */
  getDelivery?(providerMessageId: string): Promise<{ state: "queued" | "delivered" | "bounced" | "complained" | "unknown"; at?: string }>;
  /**
   * Optional: the RFC 5322 Message-ID the provider gave a sent message, in angle brackets, or null
   * when it has none (yet). Follow-ups thread under it; core stores it on the send ledger, so it is
   * asked once per send. Without this method, follow-up steps cannot be threaded and the sweep holds them.
   */
  getMessageId?(providerMessageId: string): Promise<string | null>;
}
```

### InboxProvider

A warm mailbox that receives replies and sends approved replies on their thread, through the send function. Cold, sequence and lifecycle mail never goes through it. Reply drafts are mirrored into it so the operator can review and send them from their own mail client. The system then learns from what was actually sent.

```ts
export interface InboundMessage {
  providerMessageId: string;
  threadId: string;
  from: { email: string; name?: string };
  to: string[];
  cc?: string[];
  subject: string;
  text: string;                        // the body; full taint
  receivedAt: string;
  inReplyTo?: string;
  references?: string[];
  headers: Record<string, string>;     // lowercase keys: auto-submitted, precedence, list-id, message-id...; untrusted
  isFromUs: boolean;                   // a sent copy, a draft, or mail from the mailbox's own address
  isDraft?: boolean;                   // an unsent draft; left out when the adapter cannot tell
  deliveryReport?: string;             // a bounce's machine-readable parts, so core can read the failed recipient
}

export interface InboxListArgs {
  since?: string;                      // used when there is no cursor or it expired
  cursor?: string;
  limit: number;
  known?: (ids: readonly string[]) => Promise<ReadonlySet<string>>;   // lets the adapter skip mail core already holds
}

export interface InboxPage extends Page<InboundMessage> {
  more?: boolean;                      // more messages wait past `limit`
  reset?: boolean;                     // the cursor had expired and the listing fell back to `since`
}

export interface InboxProvider {
  readonly name: string;
  /** Each is true unless set false; an inbound-only adapter sets all three false and core skips them. */
  readonly capabilities?: Partial<Record<"threads" | "drafts" | "send", boolean>>;
  listNew(args: InboxListArgs): Promise<InboxPage>;
  draftExists?(draftId: string): Promise<boolean>;
  getThread(threadId: string): Promise<InboundMessage[]>;
  createDraft(draft: { threadId?: string; to: string; subject: string; text: string; inReplyTo?: string; references?: string[] }): Promise<{ draftId: string }>;
  updateDraft(draftId: string, text: string): Promise<void>;
  deleteDraft(draftId: string): Promise<void>;
  /** Send a reply from the mailbox. effectKey is claimed by core. */
  send(message: OutboundMessage & { threadId?: string }): Promise<SendOutcome>;
  /** Optional push notifications, so new replies arrive within a minute. */
  watch?(): Promise<{ expiresAt: string }>;
}
```

### OperatorChannel

The chat surface the operator uses to approve, edit and command. Approval requests carry the content digest, and button callbacks return it, so core can refuse an approval of content that has since changed.

```ts
export interface OperatorMessage {
  text: string;                        // plain text or the channel's minimal markup
  buttons?: Array<Array<{ label: string; action: string; payload: string }>>;   // rows of buttons
  threadKey?: string;                  // groups related messages when the channel supports it
  silent?: boolean;
  chatId?: string;                     // the chat to send to; the adapter's default chat when omitted
}

export interface ApprovalRequest {
  approvalId: string;
  chatId?: string;
  kind: "send" | "sequence" | "learning" | "config" | "pr" | "custom";
  digest: string;                      // sha256 of the exact content being approved
  summary: string;
  preview: string;
  actions: Array<"approve" | "edit" | "skip" | "snooze" | "reject">;
}

export type OperatorUpdate =
  | { type: "command"; chatId: string; userId: string; text: string; messageId: string }
  | { type: "callback"; chatId: string; userId: string; action: string; payload: string; messageId: string; callbackId: string }
  | { type: "ignored"; reason: string };

export interface OperatorChannel {
  readonly name: string;
  notify(message: OperatorMessage): Promise<{ messageId: string }>;
  requestApproval(req: ApprovalRequest): Promise<{ messageId: string }>;
  editMessage(messageId: string, message: OperatorMessage): Promise<void>;
  acknowledgeCallback(callbackId: string, text?: string): Promise<void>;
  /** Verify the inbound webhook (for example a secret-token header) and normalize the update. */
  parseUpdate(request: Request): Promise<OperatorUpdate>;
  /** Register the webhook URL with the vendor. A deployment calls it once after deploying. */
  registerWebhook(url: string): Promise<void>;
}
```

An approval button's callback payload is `<approvalId>.<the first 32 hex characters of the digest>`. Core re-reads the item, recomputes its digest and refuses the tap when they differ, so an approval never covers content the operator did not see. [OPERATOR.md](OPERATOR.md) covers setting up the operator chat.

Authorization, meaning which chat and user ids may command the agent, belongs to core and comes from `gtm.config.ts`. The adapter only reports ids.

### CalendarProvider

Booking detection reads the calendar with privacy-limited fields only: an adapter asks the vendor for ids, status, times, attendees and organizer, and never returns a title, description, location, conferencing link or attendee name.

```ts
export interface CalendarAttendee {
  email: string;
  self: boolean;
  responseStatus: "accepted" | "declined" | "tentative" | "needsAction";
}

export interface CalendarEventSummary {
  id: string;
  status: "confirmed" | "tentative" | "cancelled";
  start: string | null;                // ISO 8601 UTC; null for all-day or an undescribed cancellation
  end: string | null;
  allDay: boolean;
  seriesId: string | null;             // the recurring series, or null for a one-off
  organizer: { email: string; self: boolean } | null;
  attendees: CalendarAttendee[];
}

export interface CalendarEvent {       // for writing events, which a read-only adapter refuses
  id?: string;
  title: string;
  start: string;
  end: string;
  attendees: Array<{ email: string; name?: string }>;
  description?: string;
  conferencing?: "auto" | "none";
  location?: string;
}

export interface CalendarProvider {
  readonly name: string;
  readonly capabilities?: Partial<Record<"list" | "freeBusy" | "write", boolean>>;
  freeBusy(args: { start: string; end: string }): Promise<Array<{ start: string; end: string }>>;
  listEvents(args: { start: string; end: string }): Promise<CalendarEventSummary[]>;
  createEvent(event: CalendarEvent, effectKey: string): Promise<{ id: string; htmlLink?: string }>;
  updateEvent(id: string, patch: Partial<CalendarEvent>): Promise<void>;
  cancelEvent(id: string): Promise<void>;
}
```

For booking detection, core asks only for the fields it needs: id, status, times, attendees and their responses, and organizer. It never asks for event titles or descriptions.

### BillingProvider

Reads subscription state and parses billing webhooks. Anything that creates an offer (a checkout link, a coupon, a discount) is a permanently human-only action class. The port exposes it, and core refuses to call it without a person's approval.

Amounts are integers in the currency's minor unit (cents). `email` is the customer's address when the vendor's payload carries it: core resolves an existing contact by it, never creates one, and refuses an erased person. `livemode` is true only for a live event. Core acknowledges and drops any other event, from the vendor's test mode or left unmarked, unless `billing:accept_test_events` is on, so an adapter for a vendor with no test mode sets it to true on every event. The billing contract test requires the field. [LIFECYCLE.md](LIFECYCLE.md) covers what each event does.

```ts
export type BillingInterval = "day" | "week" | "month" | "year";

export type BillingEvent =
  | { type: "checkout_completed"; customerId: string; email?: string; plan?: string; amount?: number; currency?: string; interval?: BillingInterval; at: string; providerEventId: string; livemode?: boolean }
  | { type: "subscription_created" | "subscription_updated" | "subscription_canceled"; customerId: string; subscriptionId: string; status: string; email?: string; plan?: string; amount?: number; currency?: string; interval?: BillingInterval; at: string; providerEventId: string; livemode?: boolean }
  | { type: "payment_failed"; customerId: string; subscriptionId?: string; email?: string; amount?: number; currency?: string; at: string; providerEventId: string; livemode?: boolean }
  | { type: "ignored"; providerEventId: string; reason: string };

export interface BillingProvider {
  readonly name: string;
  parseWebhook(request: Request): Promise<BillingEvent>;     // verifies the signature, 5-minute tolerance
  getCustomerByEmail(email: string): Promise<{ customerId: string; plan?: string; status?: string } | null>;
  listSubscriptions(customerId: string): Promise<Array<{ subscriptionId: string; plan: string; status: string; amount?: number; currency?: string; renewsAt?: string }>>;
  /** Human-only (action class "offers"). */
  createCheckoutLink?(args: { plan: string; email: string; effectKey: string }): Promise<{ url: string; expiresAt?: string }>;
}
```

### ModelGateway

All model calls go through this port. Core asks for roles, not model ids. `gtm.config.ts` maps roles to models, and the adapter routes to the vendor, optionally through Cloudflare AI Gateway. Usage comes back on every call so core can write the cost ledger.

```ts
export type ModelRole = "strategist" | "worker" | "writer" | "judge" | "triage" | "classifier" | "coder" | "embedding";

// Blocks core writes into messages during a tool loop; the adapter maps them to its vendor's shapes.
export type ModelContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean };

export interface CompletionRequest {
  role: ModelRole;
  model?: string;                         // the model id gtm.config.ts maps the role to; core prices by it
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string | Array<Record<string, unknown>> }>;
  tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  jsonSchema?: Record<string, unknown>;   // structured output when the vendor supports it
  maxTokens: number;
  temperature?: number;
  metadata?: Record<string, string>;      // run id, job, contact id: for gateway logs, never prompt content
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  stopReason: "end" | "tool_use" | "max_tokens" | "other";
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  model: string;
  content?: Array<Record<string, unknown>>;  // the vendor's assistant turn, sent back unchanged to continue a tool loop
  cost?: Cost;
}

export interface ModelGateway {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  /**
   * Optional: complete(), streamed. Same request, same result once the vendor finishes (usage
   * included, so core prices it the same way); the answer's text goes to onText as it arrives, and
   * req.signal stops it. Core uses it only where a person watches the answer (the dashboard chat)
   * and calls complete() on a gateway without it.
   */
  stream?(req: CompletionRequest, handlers: { onText(text: string): void }): Promise<CompletionResult>;
  embed(texts: string[], role?: "embedding"): Promise<{ vectors: number[][]; model: string; cost?: Cost }>;
  /** Optional cheap classifier tier: a small model returning a probability per label. */
  classify?(args: { labels: string[]; text: string; role?: "classifier" }): Promise<{ probabilities: Record<string, number>; model: string; cost?: Cost }>;
}
```

### CrmSink (optional)

Mirrors contacts, accounts and activity into an external CRM. The database in this system is the truth; the sink is one-way and tolerates failure.

```ts
export interface CrmSink {
  readonly name: string;
  upsertAccount(account: { key: string; name: string; domain: string; attributes: Record<string, unknown> }): Promise<{ externalId: string }>;
  upsertContact(contact: { id: string; email?: string; firstName?: string; lastName?: string; title?: string; accountKey?: string; warmth: string; attributes: Record<string, unknown> }): Promise<{ externalId: string }>;
  logActivity(activity: { contactId: string; type: "email_sent" | "reply" | "meeting" | "note"; at: string; summary: string }): Promise<void>;
}
```

### Sandbox (modules only)

Single commands in an isolated environment, for optional modules such as the planned `code-mode` module. Nothing in this release uses it, and it is not part of the core contract; it is declared here so module authors share one shape. The ship module runs its builds through `CodingSandbox` instead.

```ts
export interface Sandbox {
  exec(args: { cmd: string; cwd?: string; timeoutMs: number; env?: Record<string, string> }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  destroy(): Promise<void>;
}
```

### CodeHost (ship module)

Holds the repositories the ship loop works on: reads a file, makes one commit per task, opens a pull request, reads pull request and check state, compares commits, and verifies its own webhooks. [SHIP.md](SHIP.md) describes the build that uses it. It is declared in core (`packages/core/src/ports/code.ts`) so that a code host for another vendor is one more adapter.

- **Nothing in the port merges.** Merging code is a permanently human action class (`merge_code`), and an adapter must not add a way to do it.
- **Every method checks the allowlist.** A repository outside `allowedRepos()` is refused with a non-retryable `invalid` error before any request, so the adapter's token can only touch the repositories its options list.
- **`pushRefusal` says, without a request, why the host would not push a ship branch**, or null. The build reads it before it starts, so a build whose branch could never be pushed spends nothing. The reason names what the deployer must do or confirm, such as the CI isolation for the mode in use or a missing credential.
- **`commit` is one commit, idempotent, and never forces.** It writes to `ship/<taskId>` (`shipBranch(taskId)`), with the base commit as the only parent. A retry that finds the branch at a commit with the same tree and parent returns it with `created: false`. A branch holding anything else is refused; the base branch is never written.
- **A host may commit through a fork.** It then puts `ship/<taskId>` in a fork of the target and writes nothing in the target; `CommitResult.repo` names the repository the branch is in. In the fork it may only fast-forward its copy of `baseBranch` until the base commit is reachable, and refuses when it cannot. The pull request is still opened in the target, and webhooks still come from the target.
- **`openPullRequest` is idempotent** per task branch: an existing pull request comes back with `created: false`.
- **`contains` answers whether a commit is in another's history**, for deploy detection: true for a descendant and for the same commit, false when the descendant does not have the ancestor (including unrelated or unknown commits). A comparison the host fails throws; it is never reported as an answer.
- **`verifyWebhook` checks the signature in constant time before it reads the body**, then maps the payload. Every event carries the vendor's delivery id so a redelivery can be recognized.
- **Repository text is untrusted.** A file from `readFile` is full taint; check names and environment names are short third-party text (metadata taint).

```ts
export function shipBranch(taskId: string): string;           // "ship/<taskId>"

export interface ChangedFile {                                // one file exactly as it would be committed
  path: string;
  change: "added" | "modified" | "deleted" | "renamed";
  previousPath?: string;                                      // for a rename
  additions: number;
  deletions: number;
  mode: string;                                               // "100644", "100755", "120000" (symlink), "160000" (submodule)
  binary: boolean;
  content: { encoding: "utf-8" | "base64"; data: string } | null;   // null when deleted
}

export interface RepoFile { size: number; encoding: "utf-8" | "base64"; data: string | null }   // data null: larger than maxBytes

export type CodeHostEvent =
  | { type: "ping"; deliveryId: string }
  | { type: "pull_request"; deliveryId: string; repo: string; number: number; action: "opened" | "closed" | "reopened" | "synchronize" | "other"; merged: boolean; mergeCommitSha: string | null; headSha: string; headBranch: string; baseBranch: string }
  | { type: "check"; deliveryId: string; repo: string; headSha: string; name: string; conclusion: "success" | "failure" | "pending" | "neutral"; pullRequests: number[] }
  | { type: "deployment"; deliveryId: string; repo: string; sha: string; environment: string; productionEnvironment: boolean | null; state: "success" | "failure" | "pending" | "inactive" | "other" }
  | { type: "ignored"; deliveryId: string; reason: string };

export interface CodeHost {
  readonly name: string;
  allowedRepos(): readonly string[];                          // lowercase owner/name
  pushRefusal(): string | null;                               // why no ship branch would be pushed; no request
  branchHead(repo: string, branch: string): Promise<string | null>;
  readFile(args: { repo: string; path: string; ref: string; maxBytes?: number }): Promise<RepoFile | null>;
  pathKind(args: { repo: string; path: string; ref: string }): Promise<"missing" | "file" | "symlink" | "directory" | "submodule">;
  commit(req: { repo: string; taskId: string; baseSha: string; baseBranch: string; message: string; files: readonly ChangedFile[] }): Promise<{ repo: string; branch: string; commitSha: string; treeSha: string; created: boolean }>;   // repo: where the branch is (the target or its fork)
  openPullRequest(req: { repo: string; taskId: string; base: string; title: string; body: string; draft?: boolean }): Promise<{ number: number; url: string; headSha: string; created: boolean }>;   // always in the target
  pullRequest(repo: string, number: number): Promise<{ number: number; url: string; state: "open" | "closed"; merged: boolean; mergeCommitSha: string | null; headSha: string; headBranch: string; baseBranch: string } | null>;
  checks(repo: string, sha: string): Promise<{ state: "pending" | "success" | "failure" | "none"; failing: string[] }>;
  contains(repo: string, ancestorSha: string, descendantSha: string): Promise<boolean>;   // throws when the comparison fails
  verifyWebhook(request: Request): Promise<CodeHostEvent>;    // "auth", "invalid" or "unavailable" AdapterError
}
```

### CodingSandbox (ship module)

Runs a coding agent on a read-only clone, in a container that holds no credentials, one build step at a time. A step is started and then polled, so a durable caller (the ship build's Workflow) never holds a long call open. The `Sandbox` port above runs single commands for other modules; this one runs a whole build.

- **Steps.** `prepare` starts a fresh container, clones the base branch and runs the install command; `agent` runs the coding agent on the approved spec; `checks` runs the repository's checks; `repair` runs the agent once more after failed checks. The spec is the only description of the request the agent is given.
- **`start` is idempotent per step id** and refuses a second step while one runs (`reason: "busy"`).
- **`status` never carries the container's own text**: only a state, an exit code, whether the step hit its time limit, the base commit the clone recorded, and a fixed description of a failure.
- **`collect` returns the changed files against the recorded base commit**, within `limits`, or the limit that was hit. The adapter validates what its container reports; everything that comes out is full taint all the same.
- **`limits`** are at most 2 MB of changed content and 80 model requests per task; an adapter's options can only lower them.

```ts
export type CodingStep =
  | { kind: "prepare"; repo: string; baseBranch: string; install: readonly string[] | null }
  | { kind: "agent"; spec: string }
  | { kind: "checks"; command: readonly string[] }
  | { kind: "repair"; spec: string };

export interface CodingStatus {
  stepId: string | null;
  kind: "prepare" | "agent" | "checks" | "repair" | null;
  state: "idle" | "running" | "succeeded" | "failed" | "lost";   // lost: the container stopped before the step ended
  exitCode: number | null;
  timedOut: boolean;
  baseSha: string | null;
  detail: string | null;
}

export type CodingCollectResult =
  | { ok: true; files: ChangedFile[]; diffBytes: number; log: string }
  | { ok: false; reason: "not_ready" | "too_many_files" | "file_too_large" | "diff_too_large" | "invalid_output"; detail: string; log: string };

export interface CodingSandbox {
  readonly name: string;
  readonly limits: { maxDiffBytes: number; maxFileBytes: number; maxFiles: number; maxModelTurns: number };
  start(taskId: string, stepId: string, step: CodingStep): Promise<{ accepted: boolean; reason?: string }>;
  status(taskId: string): Promise<CodingStatus>;
  collect(taskId: string): Promise<CodingCollectResult>;
  destroy(taskId: string): Promise<void>;                     // safe to call more than once
}
```

## How adapters become tools

The tool registry (`createToolRegistry` in `@gtm-agents/core/security`) merges each manifest's `tools` entries with core's own tool classes, and the dispatcher applies each entry's class to every call of that name:

- **its taint.** Results from `full` tools are sanitized, fenced and raise the session's taint. `metadata` tools return ids, counts and short snippets only.
- **its gate.** The action gate refuses the call when the session's taint is at or above the threshold.
- **its egress class**, which the data-carrying-URL and email-in-query checks apply from metadata taint up.
- **the `humanOnly` flag.** The action gate refuses the call without a matching approval digest.
- **its rate category.** The call counts against that rate limit, and the budget gate checks before it runs; the cost the adapter reports is recorded after it.

A name declared by two sources is refused when the registry is built. Classifying a tool does not offer it to a model: an agent sees only the tools core or a module wires a handler for (the hub agent's are listed in [OPERATOR.md](OPERATOR.md)). In this release no adapter tool is offered to an agent; the classifications keep each adapter call under the security contract for when one is.

The security contract runs over every registered tool, including adapter tools, in CI. It checks that every tool is classified, that gates never loosen as taint rises, that refused calls never reach their handler, that every taint source is fenced, and that every egress tool declares a rate category. Run it in your adapter's tests with `runSecurityContract` from `@gtm-agents/core/testing` and `createToolRegistry` from `@gtm-agents/core/security`: `await runSecurityContract(createToolRegistry({ manifests: [manifest] }))`. [SECURITY-MODEL.md](SECURITY-MODEL.md) explains how to choose `taint`, `gate` and `egress` for a tool.

## Contract tests

`packages/adapters/_contract/` holds one runner per port, plus `recordedFetch` (a fetch that answers only recorded routes and fails on anything else) and `testContext` (an AdapterContext for tests):

```ts
runDiscoverySourceContract(create: (ctx: AdapterContext) => DiscoverySource, fixtures)   // _contract/discovery-source.ts
runContactFinderContract(create, fixtures)        // _contract/contact-finder.ts; confidence runs 0 to 100
runEmailVerifierContract(create, fixtures)        // _contract/email-verifier.ts; every vendor code maps to one of four statuses
runEmailProviderContract(create, fixtures)        // _contract/email-provider.ts; a signed and a tampered webhook
runOperatorChannelContract(create, fixtures)      // _contract/operator-channel.ts; a tampered webhook, a stale approval digest
runModelGatewayContract(create, fixtures)         // _contract/model-gateway.ts; usage is populated, tool calls round-trip, stream() matches complete()
runInboxProviderContract(create, fixtures)        // _contract/inbox-provider.ts; capability-limited adapters declare what they cannot do
runBillingProviderContract(create, fixtures)      // _contract/billing-provider.ts; signed, tampered, stale and multi-signature webhooks
runCalendarProviderContract(create, fixtures)     // _contract/calendar-provider.ts; the request asks for no title or description
runCodeHostContract(create, fixtures)             // _contract/code-host.ts; one idempotent commit, never the base branch, a force or a merge; path kinds, containment, push refusal
runCodingSandboxContract(fixtures)                // _contract/coding-sandbox.ts; a fake container: internet off, no secret inside, limits enforced
// SignalSource, PeopleProvider, CompanyProvider, CompanyResearchSource and CrmSink have no shared runner: an adapter tests
// them in its own contract.test.ts, with the same recordedFetch and testContext.
```

Each adapter's `contract.test.ts` calls the runner with a recorded-response `fetch`. Contract tests are hermetic and run in `npm test`. No test in the repository uses a real key or reaches the network; an adapter that adds a live test must keep it out of `npm test` and CI.

## Adapters

The adapters in `packages/adapters/`, each with a hermetic contract test, and the ones planned. None has yet been run against its live provider.

| Adapter | Ports | Notes |
|---|---|---|
| `email-resend` | EmailProvider | Batch send, Svix-style webhook, tags for correlation, Message-ID lookup for threading. Available |
| `email-gmail` | EmailProvider (non-cold sends from the warm mailbox) | Planned. Shares Google auth with the other Google adapters. Approved replies already go out from the warm mailbox through `inbox-gmail` |
| `inbox-gmail` | InboxProvider | Reading, draft mirroring, approved reply sends, push watch when configured. Available |
| `email-cloudflare` | InboxProvider (inbound routing only) | Receives mail sent to the agent's domain through Cloudflare Email Routing and normalizes it; no sending. Available |
| `operator-telegram` | OperatorChannel | Secret-token webhook, inline keyboards, callback digests. Available |
| `data-exa` | DiscoverySource | `search`, `watch` (websets), search monitors (signed deliveries), `find_similar`, dated news and `company_research` (CompanyResearchSource, through the Agent API). Available |
| `data-jobboards` | SignalSource, and `HiringBoardSource` from `@gtm-agents/core/signals` | Public Greenhouse, Lever and Ashby board JSON from their documented hosts only; returns role-kind counts, never titles. No key. Available |
| `data-alexandria` | PeopleProvider, CompanyProvider, ContactFinder, SignalSource | Planned. Many providers behind one gateway, with spend bounded by core's budget gate |
| `data-hunter` | ContactFinder, EmailVerifier, PeopleProvider | Finder, verifier, and people at a domain. Available |
| `data-xai` | SignalSource | Planned. Public-post signals with live search |
| `calendar-google` | CalendarProvider | Read-only: lists the primary calendar's events with privacy-limited fields, over the shared Google OAuth. Available |
| `billing-stripe` | BillingProvider | `t=,v1=` signature verified before parsing, 5-minute tolerance; checkout links only through the human-only offers path. Available |
| `code-github` | CodeHost | GitHub over plain fetch, for the ship module: one commit per task through the git data API on `ship/<task>`, in the target repository or a configured fork, idempotent pull requests, commit comparison for deploy detection, `X-Hub-Signature-256` verified in constant time before parsing. It cannot merge. Available |
| `sandbox-cloudflare` | CodingSandbox | A Cloudflare Container per ship task with internet access off and no credentials; the Worker lets through a read-only clone, package reads and the coder model only. Agent profiles `claude-code` (default) and `opencode`. Needs a plan with Containers. Available |
| `llm-gateway` | ModelGateway | Anthropic's Messages API, with streaming, tools and structured output; Cloudflare AI Gateway optional. `embed()` is refused, because the Messages API has no embeddings endpoint. Available; OpenAI and Workers AI are planned |

To request a new adapter, open an adapter request issue with:
- the port or ports it implements;
- the vendor's auth model, price table, rate limits and webhook signature scheme;
- whether any capability must be human-only.
