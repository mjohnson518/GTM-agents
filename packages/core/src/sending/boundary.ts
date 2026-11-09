// GTM-agents: the provider boundary, the one send function for email through the provider.
//
//   const send = createOutreachSender(deps);
//   const outcomes = await send(items);   // one outcome per item, in order; never throws
//
// Every check runs here, inside the send function, for every path, so no caller can skip one.
// Before any of them: the delivery:enabled master switch (off or unreadable refuses every item),
// the configuration a compliant message needs (a provider, the unsubscribe signing key, a public
// https base URL), and a look in the effects ledger for messages already sent. Then, in order:
//   1. the system halt, and the cold kill switch for cold and sequence mail: defer;
//   2. suppression: fail closed, block (checkSendGates runs 1 and 2);
//   3. the content lint: a block refuses the item, a warning proceeds;
//   4. the verification policy for the path: cold needs a deliverable address on the contact;
//      sequence, reply and lifecycle refuse an address known to be undeliverable. The address must
//      be the contact's own;
//   5. when the item carries an approved digest: the draft must be approved, unchanged since, and
//      the item's recipient, subject and body must hash to exactly that digest;
//   6. the recipient-local send window: defer to the next opening;
//   7. the per-domain daily cap and the per-account cap: defer;
//   8. the circuit breaker: defer while it is open.
// Then the items are chunked to the provider's batch limit. Per item: the idempotency key is
// claimed in the effects ledger, the plain-text footer and the unsubscribe and threading headers
// are added, and the message is tagged for webhook correlation. After the provider answers, per
// sent item, each bookkeeping write is caught and counted: the outreach_sends ledger row (with the
// template version and cohort the composer set, when they are well formed), the outreach_log row, the draft marked sent, warmth cold -> contacted, the campaign_contacts row, a
// funnel event and the recipient domain's send count.
//
// Gates fail closed: a gate whose input cannot be read holds the item (a typed refusal, or a
// retryable failure when the read itself failed). Bookkeeping fails open. Refusals read
// "[SEND BLOCKED:<reason>] ...". A state that holds everything until a person fixes it (delivery
// turned off, the provider, signing key or base URL missing) is a retryable failure rather than a
// refusal, so callers keep the message and try again later. Deferred items go to the deferred
// queue (deferred_sends) to be replayed through this same function.
//
// Provider failures: a message the provider definitely did not accept (rate limited, out of
// quota, unavailable before acceptance) has its claim released and is deferred; one it rejected
// (invalid, unauthorized) has its claim released and fails. When acceptance is uncertain (a
// time-out, an unknown error, a thrown call) the claim is kept, the contact's last_contacted_at is
// set (it may have received the message; warmth stays as it was) and the item fails without retry, because sending it again
// could send it twice.
//
// The warm mailbox (deps.mailbox, an InboxProvider): when one is configured, every reply (path
// "reply") goes out through it, on the thread it answers, and never through the email provider;
// cold, sequence and lifecycle mail never goes through it. A mailbox reply passes the same checks
// (halt, suppression, content lint, verification, the approved digest, which it must carry, and the
// exactly-once claim). It is not counted against the sending domain's daily cap or the circuit
// breaker, which belong to the email provider, it is never written to the deferred queue (a held
// reply is reported as deferred and the caller tries again), and a claimed reply whose contact did
// not write in on that thread is refused rather than sent as cold mail. Without a mailbox, replies
// go through the email provider as before. Replies carry the unsubscribe and threading headers but
// no visible footer, so they read like a normal reply (message.ts).
import { PRODUCT_STATES } from "../data/enums.ts";
import { recordCost } from "../budget/cost-ledger.ts";
import type { GtmConfig } from "../config/schema.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import { isSendCohort } from "../metrics/cohort.ts";
import type { EmailProvider, InboxProvider, OutboundMessage, SendOutcome } from "../ports/email.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import type { AdapterErrorCode } from "../ports/types.ts";
import { lintOutbound } from "../quality/lint.ts";
import { draftDigest, verifyApproval, type DraftStatus } from "../security/approval-digest.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { sha256Hex } from "../shared/hash.ts";
import type { KvStore } from "../shared/kv.ts";
import { readBreaker, recordProviderFailure, recordProviderSuccess } from "./breaker.ts";
import { ACCOUNT_CAP_WINDOW_MS, accountSendsSince, capAccount, capAccountId, ledgerAccountKey, sentTodayCount, type CapAccount } from "./caps.ts";
import { DELIVERY_FLAGS, DELIVERY_LIMITS, kvFlags, readCap, readSwitch } from "./flags.ts";
import { SEND_PATHS, checkSendGates, type SendPath } from "./gates.ts";
import { claimSends, claimedKeys, releaseSend, runWrites } from "./ledger.ts";
import { buildOutboundMessage } from "./message.ts";
import { nextUtcMidnight, pageOnce, utcDay } from "./pages.ts";
import { normalizeAddress } from "./suppression.ts";
import { DEFAULT_TIMEZONE, recipientTimezone } from "./timezone.ts";
import type { DeferReason, OutreachItem, OutreachOutcome, SendOutreach, SendRefusal } from "./types.ts";
import { isUsableSigningKey, publicOrigin, signUnsubscribeToken, unsubscribeUrl } from "./unsubscribe-token.ts";
import { isWithinWindow, nextAllowedTime, windowForPath } from "./window.ts";

export interface OutreachSenderOptions {
  /** The zone for a contact with no timezone and a location that is not recognized. */
  defaultTimezone: string;
  /** Messages per provider call. The provider's own batchLimit can only lower it. */
  batchSize: number;
  /** Pause between provider calls, to stay under the provider's request rate. */
  chunkIntervalMs: number;
}

export const DEFAULT_SENDER_OPTIONS: Readonly<OutreachSenderOptions> = Object.freeze({ defaultTimezone: DEFAULT_TIMEZONE, batchSize: 100, chunkIntervalMs: 500 });

export interface OutreachSenderDeps {
  db: D1Database;
  /** Holds the halt, the kill switch and the circuit breaker. Missing counts as halted. */
  kv: KvStore | undefined | null;
  /** Flags; reads from `kv` when omitted. */
  flags?: FlagReader;
  /** `sequences` is optional: with it, a cold first touch schedules its follow-up wherever it is sent. */
  config: Pick<GtmConfig, "company" | "sending"> & Partial<Pick<GtmConfig, "sequences">>;
  provider: EmailProvider | undefined;
  /**
   * The warm mailbox. With it, replies go out through the mailbox on their thread and never through
   * `provider`; without it, replies go through `provider`. Cold, sequence and lifecycle mail always
   * use `provider`.
   */
  mailbox?: InboxProvider;
  /** The UNSUBSCRIBE_SIGNING_KEY secret. */
  unsubscribeSigningKey: string | undefined;
  /** AGENT_BASE_URL: the deployment's public https origin, for unsubscribe links. */
  baseUrl: string | undefined;
  /** Where the circuit breaker pages. */
  operator?: OperatorChannel;
  now?: () => Date;
  log?: JobLogger;
  options?: Partial<OutreachSenderOptions>;
}

export interface BoundaryRunOptions {
  /** Write deferred items to the deferred queue. The replay job turns it off and keeps its own rows. */
  persistDeferrals: boolean;
}

export interface DeliveryBoundary {
  run(items: readonly OutreachItem[], options: BoundaryRunOptions): Promise<OutreachOutcome[]>;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const PAUSABLE: ReadonlySet<SendPath> = new Set(["cold", "sequence"]);
/** The provider definitely did not accept these, and a later try may succeed. */
const NOT_ACCEPTED_RETRY: ReadonlySet<AdapterErrorCode> = new Set(["rate_limited", "quota", "unavailable"]);
/** The provider definitely did not accept these, and trying again will not help. */
const NOT_ACCEPTED_FINAL: ReadonlySet<AdapterErrorCode> = new Set(["invalid", "auth", "not_found"]);
/** Failures that say something about the message, not the provider: not counted by the breaker. */
const MESSAGE_FAULTS: ReadonlySet<AdapterErrorCode> = new Set(["invalid", "not_found"]);
const MAX_KEY_LENGTH = 200;
const IN_CHUNK = 90;

interface ContactRow {
  id: string;
  email: string;
  email_sha256: string;
  account_key: string | null;
  timezone: string | null;
  location: string | null;
  verification_status: string | null;
}

interface DraftRow {
  id: string;
  contact_id: string | null;
  status: DraftStatus;
  approved_digest: string | null;
  /** recipient_email, under the name the approval rules read. */
  to: string | null;
  subject: string | null;
  body: string | null;
}

interface Work {
  index: number;
  item: OutreachItem;
  key: string;
  path: SendPath;
  /** A reply going out through the warm mailbox. */
  warm: boolean;
  to?: string;
  contact?: ContactRow;
  timezone?: string;
  account?: CapAccount;
}

const silentLog: JobLogger = { info: () => {}, warn: () => {}, error: () => {} };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function inChunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

const hasLineBreak = (value: string) => /[\r\n]/.test(value);

export function createDeliveryBoundary(deps: OutreachSenderDeps): DeliveryBoundary {
  const options: OutreachSenderOptions = { ...DEFAULT_SENDER_OPTIONS, ...(deps.options ?? {}) };
  const clock = deps.now ?? (() => new Date());
  const log = deps.log ?? silentLog;
  const flags = deps.flags ?? kvFlags(deps.kv);
  const db = deps.db;

  return {
    async run(items, runOptions) {
      const now = clock();
      const outcomes: Array<OutreachOutcome | undefined> = items.map(() => undefined);
      const zones = new Map<number, string>();
      // Items whose path was re-resolved, so the deferred queue keeps the path that was checked.
      const resolved = new Map<number, OutreachItem>();
      // Replies going out through the warm mailbox, which the deferred queue never takes.
      const warmIndexes = new Set<number>();
      const keyOf = (i: number) => {
        const raw = items[i]?.idempotencyKey;
        return typeof raw === "string" ? raw : "";
      };
      const block = (w: { index: number }, reason: SendRefusal, detail: string) => {
        outcomes[w.index] = { idempotencyKey: keyOf(w.index), status: "blocked", reason, message: `[SEND BLOCKED:${reason}] ${detail}` };
      };
      const defer = (w: { index: number }, reason: DeferReason, at: Date) => {
        outcomes[w.index] = { idempotencyKey: keyOf(w.index), status: "deferred", reason, nextAttemptAt: at.toISOString() };
      };
      const fail = (w: { index: number }, retryable: boolean, message: string) => {
        outcomes[w.index] = { idempotencyKey: keyOf(w.index), status: "failed", retryable, message };
      };
      // A cold first touch schedules its follow-up here, so a send replayed from the deferred queue
      // starts the sequence exactly as a direct one does. [sequence_active, next_send_at], or nulls
      // to leave the row's schedule alone.
      const followUp = (item: OutreachItem): [number | null, string | null] => {
        if (item.path !== "cold" || item.sequenceStep !== 1 || !deps.config.sequences) return [null, null];
        const next = deps.config.sequences.cold.steps[1];
        return next ? [1, new Date(now.getTime() + next.delayDays * DAY_MS).toISOString()] : [0, null];
      };
      // An uncertain provider outcome may have delivered the message, so the contact's
      // last_contacted_at is set (warmth is left alone): selection then never gives it a second
      // first touch. Bookkeeping, so it fails open.
      const markMaybeSent = async (ws: readonly Work[]): Promise<void> => {
        const ids = [...new Set(ws.map((w) => w.item.contactId))];
        if (ids.length === 0) return;
        try {
          await db.batch(ids.map((id) => db.prepare("UPDATE contacts SET last_contacted_at = COALESCE(last_contacted_at, ?2), updated_at = ?2 WHERE id = ?1").bind(id, now.toISOString())));
        } catch (error) {
          log.warn("could not mark contacts after an uncertain send", { error: sanitizeErrorMessage(error) });
        }
      };

      // Shape checks, and duplicates within this call.
      let work: Work[] = [];
      const seen = new Set<string>();
      items.forEach((raw, index) => {
        const item = raw as Partial<OutreachItem> | undefined;
        // The key is used exactly as given (claimed, sent as the provider's effect key, queued), so
        // one with surrounding whitespace is refused rather than trimmed into a different key.
        const key = keyOf(index);
        const target = { index };
        if (!item || key.trim().length === 0 || key !== key.trim() || key.length > MAX_KEY_LENGTH) return block(target, "invalid", "an item needs an idempotency key of 1 to 200 characters, with no surrounding whitespace.");
        if (seen.has(key)) {
          outcomes[index] = { idempotencyKey: keyOf(index), status: "duplicate" };
          return;
        }
        seen.add(key);
        if (typeof item.contactId !== "string" || item.contactId.length === 0) return block(target, "invalid", "an item needs a contact id.");
        if (typeof item.to !== "string" || typeof item.subject !== "string" || typeof item.body !== "string") return block(target, "invalid", "an item needs a recipient, a subject and a body.");
        if (hasLineBreak(item.subject)) return block(target, "invalid", "the subject holds a line break.");
        const optionalStrings = [item.campaignId, item.draftId, item.templateId, item.experimentId, item.experimentArm, item.toName, item.approvedDigest, item.inReplyTo, item.threadId];
        if (optionalStrings.some((v) => v !== undefined && typeof v !== "string")) return block(target, "invalid", "an optional id holds something other than text.");
        if (item.sequenceStep !== undefined && !Number.isInteger(item.sequenceStep)) return block(target, "invalid", "the sequence step is not a whole number.");
        if (item.references !== undefined && (!Array.isArray(item.references) || item.references.some((r) => typeof r !== "string"))) return block(target, "invalid", "the references are not a list of message ids.");
        // A draft is sent only on its approval: an item that names a draft must carry the approved digest.
        if (item.draftId !== undefined && item.approvedDigest === undefined) return block(target, "approval_mismatch", "an item that names a draft must carry the draft's approved digest.");
        // An unknown path is treated as cold, the strictest.
        const path: SendPath = (SEND_PATHS as readonly string[]).includes(String(item.path)) ? (item.path as SendPath) : "cold";
        work.push({ index, item: { ...(item as OutreachItem), path }, key, path, warm: false });
      });

      // The master switch, then what a compliant message needs.
      if (work.length > 0 && !(await readSwitch(flags, DELIVERY_FLAGS.enabled))) {
        for (const w of work) fail(w, true, "[SEND BLOCKED:disabled] delivery is turned off (delivery:enabled is off or unreadable); nothing was sent.");
        work = [];
      }
      const origin = publicOrigin(deps.baseUrl);
      const provider = deps.provider;
      const mailbox = deps.mailbox;
      // A reply needs the warm mailbox when one is configured; everything else needs the email provider.
      const viaMailbox = (w: Work) => w.path === "reply" && mailbox !== undefined;
      if (work.length > 0) {
        const shared = [
          ...(isUsableSigningKey(deps.unsubscribeSigningKey) ? [] : ["UNSUBSCRIBE_SIGNING_KEY (at least 32 characters)"]),
          ...(origin ? [] : ["AGENT_BASE_URL (an https origin)"]),
        ];
        work = work.filter((w) => {
          const missing = [...(provider || viaMailbox(w) ? [] : ["an email provider"]), ...shared];
          if (missing.length === 0) return true;
          fail(w, true, `[SEND BLOCKED:not_configured] no message can carry a working unsubscribe link without ${missing.join(", ")}; nothing was sent.`);
          return false;
        });
      }
      if (!origin || work.length === 0) return finish();

      // Messages already sent under the same key. The claim before sending is the real guard; this
      // look only keeps an already-sent item from being deferred or refused instead of reported.
      if (work.length > 0) {
        try {
          const sent = await claimedKeys(db, work.map((w) => w.key));
          work = work.filter((w) => {
            if (!sent.has(w.key)) return true;
            outcomes[w.index] = { idempotencyKey: keyOf(w.index), status: "duplicate" };
            return false;
          });
        } catch {
          // Unreadable: the claim below still refuses a second send.
        }
      }

      // A reply through the warm mailbox is never downgraded: it must name the thread it answers,
      // and the contact must have written in on that thread. Otherwise it is refused, and an
      // unreadable check holds it, so a reply meant for the mailbox never leaves through the email
      // provider, and never starts a new thread without a footer.
      const warmClaims = work.filter(viaMailbox);
      for (const w of warmClaims) {
        if (!w.item.threadId) {
          block(w, "invalid", "a reply from the mailbox needs the thread it answers.");
          continue;
        }
        try {
          const row = await db
            .prepare("SELECT 1 AS hit FROM inbound_emails WHERE contact_id = ?1 AND provider_thread_id = ?2 LIMIT 1")
            .bind(w.item.contactId, w.item.threadId)
            .first<{ hit: number }>();
          if (row) {
            w.warm = true;
            warmIndexes.add(w.index);
          } else block(w, "invalid", "a reply from the mailbox needs an inbound email from the contact, on the thread it answers.");
        } catch {
          fail(w, true, "[SEND BLOCKED:invalid] the inbound mail could not be read to confirm this is a reply; nothing was sent.");
        }
      }
      work = work.filter((w) => outcomes[w.index] === undefined);

      // The path is never taken on trust: a reply needs an inbound email from the contact, and
      // lifecycle mail a lifecycle record for the contact. Anything else, or an unreadable check,
      // is treated as cold, the strictest path.
      const claimed = work.filter((w) => (w.path === "reply" && !w.warm) || w.path === "lifecycle");
      if (claimed.length > 0) {
        let repliers = new Set<string>();
        let customers = new Set<string>();
        try {
          repliers = await idsWith(db, "SELECT DISTINCT contact_id AS id FROM inbound_emails WHERE contact_id IN", claimed.filter((w) => w.path === "reply").map((w) => w.item.contactId));
          // A product user: someone who signed up, or is in a product state. A lifecycle row alone is
          // not enough, because prospects have one too (a booked meeting moves them to engaged).
          customers = await idsWith(
            db,
            `SELECT contact_id AS id FROM contact_lifecycle WHERE (signed_up_at IS NOT NULL OR state IN (${PRODUCT_STATES.map((st) => `'${st}'`).join(", ")})) AND contact_id IN`,
            claimed.filter((w) => w.path === "lifecycle").map((w) => w.item.contactId),
          );
        } catch {
          // Unreadable: everything below is treated as cold.
        }
        for (const w of claimed) {
          const ok = w.path === "reply" ? repliers.has(w.item.contactId) : customers.has(w.item.contactId);
          if (!ok) {
            w.path = "cold";
            w.item = { ...w.item, path: "cold" };
            resolved.set(w.index, w.item);
          }
        }
      }

      // 1 and 2: halt, kill switch and suppression, per path.
      for (const path of SEND_PATHS) {
        const group = work.filter((w) => w.path === path);
        if (group.length === 0) continue;
        const result = await checkSendGates({ kv: deps.kv, db }, { path, recipients: group.map((w) => w.item.to) });
        if (result.ok) {
          for (const w of group) w.to = normalizeAddress(w.item.to) ?? undefined;
          continue;
        }
        if (result.reason === "halted") {
          for (const w of group) defer(w, "halted", new Date(now.getTime() + HOUR_MS));
          continue;
        }
        if (result.reason === "cold_paused") {
          for (const w of group) defer(w, "cold_paused", new Date(now.getTime() + DAY_MS));
          continue;
        }
        const blocked = new Map(result.blocked.map((b) => [b.recipient, b.reason]));
        for (const w of group) {
          const reason = blocked.get(w.item.to);
          if (reason === undefined) w.to = normalizeAddress(w.item.to) ?? undefined;
          else if (reason === "unparseable") block(w, "unparseable", "the recipient is not exactly one valid address.");
          else if (reason === "check_failed") fail(w, true, "[SEND BLOCKED:suppressed] the suppression list could not be read, so the recipient is held; nothing was sent.");
          else block(w, "suppressed", `the recipient may not be emailed (${reason}).`);
        }
      }
      work = work.filter((w) => outcomes[w.index] === undefined && w.to !== undefined);

      // 3: the content lint.
      work = work.filter((w) => {
        const lint = lintOutbound({ subject: w.item.subject, body: w.item.body });
        if (lint.blocks.length === 0) return true;
        block(w, "content_lint", `the content lint blocked it: ${lint.blocks.map((b) => `${b.code} (${b.detail})`).join("; ")}.`);
        return false;
      });

      // 4: the verification policy, against the contact row.
      if (work.length > 0) {
        let contacts: Map<string, ContactRow>;
        let cached: Map<string, string>;
        try {
          contacts = await loadContacts(db, work.map((w) => w.item.contactId));
          const unverified = [...contacts.values()].filter((c) => c.verification_status === null).map((c) => c.email_sha256);
          cached = await loadVerifications(db, unverified);
        } catch {
          for (const w of work) fail(w, true, "[SEND BLOCKED:undeliverable] the contacts could not be read to check verification; nothing was sent.");
          work = [];
          contacts = new Map();
          cached = new Map();
        }
        work = work.filter((w) => {
          const contact = contacts.get(w.item.contactId);
          if (!contact) {
            block(w, "invalid", "the contact does not exist.");
            return false;
          }
          if (contact.email !== w.to) {
            block(w, "invalid", "the recipient is not the contact's address.");
            return false;
          }
          const status = contact.verification_status ?? cached.get(contact.email_sha256) ?? null;
          if (w.path === "cold" && status !== "deliverable") {
            block(w, "undeliverable", `cold mail needs a deliverable address; this one is ${status ?? "unverified"}.`);
            return false;
          }
          if (status === "undeliverable") {
            block(w, "undeliverable", "the address is known to be undeliverable.");
            return false;
          }
          w.contact = contact;
          return true;
        });
      }

      // 5: approvals bound to content. A reply from the mailbox goes out only on its approved draft.
      work = work.filter((w) => {
        if (!w.warm || (w.item.draftId !== undefined && w.item.approvedDigest !== undefined)) return true;
        block(w, "approval_mismatch", "a reply from the mailbox goes out only on its approved draft.");
        return false;
      });
      const needApproval = work.filter((w) => w.item.approvedDigest !== undefined);
      if (needApproval.length > 0) {
        let drafts: Map<string, DraftRow> | null;
        try {
          drafts = await loadDrafts(db, needApproval.map((w) => w.item.draftId).filter((id): id is string => typeof id === "string"));
        } catch {
          drafts = null;
        }
        const refused = new Set<number>();
        for (const w of needApproval) {
          if (!drafts) {
            fail(w, true, "[SEND BLOCKED:approval_mismatch] the approved draft could not be read; nothing was sent.");
            refused.add(w.index);
            continue;
          }
          const draft = w.item.draftId ? drafts.get(w.item.draftId) : undefined;
          const ok =
            draft !== undefined &&
            (draft.contact_id === null || draft.contact_id === w.item.contactId) &&
            draft.approved_digest === w.item.approvedDigest &&
            (await verifyApproval(draft)) &&
            (await draftDigest({ to: w.to, subject: w.item.subject, body: w.item.body })) === w.item.approvedDigest;
          if (!ok) {
            block(w, "approval_mismatch", "the content does not match the approved draft (changed since approval, not approved, or another draft).");
            refused.add(w.index);
          }
        }
        work = work.filter((w) => !refused.has(w.index));
      }

      // 6: the recipient-local send window.
      work = work.filter((w) => {
        const zone = recipientTimezone(w.contact, options.defaultTimezone).timezone;
        w.timezone = zone;
        zones.set(w.index, zone);
        const window = windowForPath(w.path, deps.config.sending);
        if (!window || isWithinWindow(now, zone, window)) return true;
        defer(w, "outside_window", nextAllowedTime(now, zone, window));
        return false;
      });

      // 7: the per-domain daily cap and the per-account cap. Mailbox replies do not go through the
      // sending domain, so neither cap counts or holds them.
      if (work.length > 0) {
        for (const w of work) w.account = capAccount(w.contact?.account_key, w.to as string);
        let sentToday: number;
        let perAccount: Map<string, { count: number; oldest: string }>;
        try {
          sentToday = provider && work.some((w) => !w.warm) ? await sentTodayCount(db, provider.name, now) : 0;
          perAccount = await accountSendsSince(
            db,
            work.filter((w) => PAUSABLE.has(w.path)).map((w) => w.account as CapAccount),
            new Date(now.getTime() - ACCOUNT_CAP_WINDOW_MS),
          );
        } catch {
          for (const w of work) fail(w, true, "[SEND BLOCKED:domain_cap] the send ledger could not be read to check the caps; nothing was sent.");
          work = [];
          sentToday = 0;
          perAccount = new Map();
        }
        const [domainCap, accountCap] = await Promise.all([readCap(flags, DELIVERY_FLAGS.domainDailyCap, DELIVERY_LIMITS.domainDailyCap), readCap(flags, DELIVERY_FLAGS.accountWeeklyCap, DELIVERY_LIMITS.accountWeeklyCap)]);
        let planned = 0;
        const plannedPerAccount = new Map<string, number>();
        work = work.filter((w) => {
          if (w.warm) return true;
          if (sentToday + planned >= domainCap) {
            defer(w, "domain_cap", nextUtcMidnight(now));
            return false;
          }
          if (PAUSABLE.has(w.path)) {
            const id = capAccountId(w.account as CapAccount);
            const prior = perAccount.get(id);
            const used = (prior?.count ?? 0) + (plannedPerAccount.get(id) ?? 0);
            if (used >= accountCap) {
              const frees = prior ? Date.parse(prior.oldest) + ACCOUNT_CAP_WINDOW_MS + 60_000 : now.getTime() + DAY_MS;
              defer(w, "account_cap", new Date(Math.max(frees, now.getTime() + HOUR_MS)));
              return false;
            }
            plannedPerAccount.set(id, (plannedPerAccount.get(id) ?? 0) + 1);
          }
          planned += 1;
          return true;
        });
      }

      // 8: the circuit breaker, then the provider in chunks. The breaker belongs to the email
      // provider; mailbox replies go out one by one after it.
      const warmWork = work.filter((w) => w.warm);
      work = work.filter((w) => !w.warm);
      if (work.length > 0 && (await readBreaker(deps.kv, now)).open) {
        for (const w of work) defer(w, "circuit_open", nextUtcMidnight(now));
        work = [];
      }
      if (work.length > 0 && provider) {
        const chunkSize = Math.max(1, Math.min(options.batchSize, provider.batchLimit ?? options.batchSize));
        const chunks = inChunks(work, chunkSize);
        for (let c = 0; c < chunks.length; c++) {
          const chunk = chunks[c] as Work[];
          if (c > 0 && options.chunkIntervalMs > 0) await sleep(options.chunkIntervalMs);
          if ((await readBreaker(deps.kv, now)).open) {
            for (const w of chunk) defer(w, "circuit_open", nextUtcMidnight(now));
            continue;
          }
          await sendChunk(chunk);
        }
      }
      if (mailbox) for (const w of warmWork) await sendWarm(mailbox, w);

      return finish();

      // One reply through the warm mailbox, on its thread. The same exactly-once claim as the
      // provider path; the provider's breaker and cost ledger are not touched.
      async function sendWarm(box: InboxProvider, w: Work): Promise<void> {
        let claimedNow: boolean;
        try {
          [claimedNow = false] = await claimSends(db, [w.key], now);
        } catch {
          fail(w, true, "the effects ledger could not be written, so nothing was sent.");
          return;
        }
        if (!claimedNow) {
          outcomes[w.index] = { idempotencyKey: keyOf(w.index), status: "duplicate" };
          return;
        }
        let sendId: string;
        let message: OutboundMessage;
        try {
          sendId = crypto.randomUUID();
          const token = await signUnsubscribeToken(w.to as string, deps.unsubscribeSigningKey);
          message = buildOutboundMessage({ item: w.item, to: w.to as string, sendId, link: unsubscribeUrl(origin as string, token), sending: deps.config.sending, channel: "mailbox" });
        } catch (error) {
          await releaseSend(db, w.key);
          fail(w, false, `the message could not be built: ${sanitizeErrorMessage(error)}`);
          return;
        }
        let outcome: SendOutcome;
        try {
          outcome = await box.send({ ...message, ...(w.item.threadId ? { threadId: w.item.threadId } : {}) });
        } catch (error) {
          fail(w, false, `the mailbox send failed and may have sent the message, so it is not retried automatically: ${sanitizeErrorMessage(error)}`);
          await markMaybeSent([w]);
          return;
        }
        if (outcome?.ok === true && typeof outcome.providerMessageId === "string" && outcome.providerMessageId.length > 0) {
          await bookkeep(box.name, [{ w, sendId, providerMessageId: outcome.providerMessageId }]);
          return;
        }
        const code: AdapterErrorCode = outcome && outcome.ok === false ? outcome.code : "unknown";
        const detail = outcome && outcome.ok === false && outcome.detail ? `: ${sanitizeErrorMessage(outcome.detail)}` : "";
        if (outcome && NOT_ACCEPTED_RETRY.has(code)) {
          await releaseSend(db, w.key);
          defer(w, "provider_unavailable", new Date(now.getTime() + HOUR_MS));
        } else if (outcome && NOT_ACCEPTED_FINAL.has(code)) {
          await releaseSend(db, w.key);
          fail(w, false, `[SEND BLOCKED:provider_rejected] the mailbox refused it (${code})${detail}.`);
        } else {
          fail(w, false, `the mailbox's answer (${outcome ? code : "no outcome"}) leaves it unclear whether it was sent, so it is not retried automatically${detail}.`);
          await markMaybeSent([w]);
        }
      }

      async function sendChunk(chunk: Work[]): Promise<void> {
        const p = provider as EmailProvider;
        let claims: boolean[];
        try {
          claims = await claimSends(db, chunk.map((w) => w.key), now);
        } catch {
          for (const w of chunk) fail(w, true, "the effects ledger could not be written, so nothing was sent.");
          return;
        }
        const claimed: Array<{ w: Work; sendId: string; message: OutboundMessage }> = [];
        for (let i = 0; i < chunk.length; i++) {
          const w = chunk[i] as Work;
          if (!claims[i]) {
            outcomes[w.index] = { idempotencyKey: keyOf(w.index), status: "duplicate" };
            continue;
          }
          try {
            const sendId = crypto.randomUUID();
            const token = await signUnsubscribeToken(w.to as string, deps.unsubscribeSigningKey);
            const message = buildOutboundMessage({ item: w.item, to: w.to as string, sendId, link: unsubscribeUrl(origin as string, token), sending: deps.config.sending });
            claimed.push({ w, sendId, message });
          } catch (error) {
            await releaseSend(db, w.key);
            fail(w, false, `the message could not be built: ${sanitizeErrorMessage(error)}`);
          }
        }
        if (claimed.length === 0) return;

        let result: Awaited<ReturnType<EmailProvider["sendBatch"]>>;
        try {
          result = await p.sendBatch(claimed.map((c) => c.message));
        } catch (error) {
          for (const { w } of claimed) fail(w, false, `the provider call failed and may have sent the message, so it is not retried automatically: ${sanitizeErrorMessage(error)}`);
          await markMaybeSent(claimed.map((c) => c.w));
          await providerFailed();
          return;
        }
        const byKey = new Map<string, SendOutcome>();
        for (const o of result.outcomes ?? []) if (o && typeof o.effectKey === "string" && !byKey.has(o.effectKey)) byKey.set(o.effectKey, o);

        const sent: Array<{ w: Work; sendId: string; providerMessageId: string }> = [];
        const uncertain: Work[] = [];
        let providerFault = false;
        for (const { w, sendId } of claimed) {
          const o = byKey.get(w.key);
          if (o?.ok === true && typeof o.providerMessageId === "string" && o.providerMessageId.length > 0) {
            sent.push({ w, sendId, providerMessageId: o.providerMessageId });
            continue;
          }
          const code: AdapterErrorCode = o && o.ok === false ? o.code : "unknown";
          const detail = o && o.ok === false && o.detail ? `: ${sanitizeErrorMessage(o.detail)}` : "";
          if (!MESSAGE_FAULTS.has(code)) providerFault = true;
          if (o && NOT_ACCEPTED_RETRY.has(code)) {
            await releaseSend(db, w.key);
            defer(w, "provider_unavailable", new Date(now.getTime() + HOUR_MS));
          } else if (o && NOT_ACCEPTED_FINAL.has(code)) {
            await releaseSend(db, w.key);
            fail(w, false, `[SEND BLOCKED:provider_rejected] the provider refused it (${code})${detail}.`);
          } else {
            fail(w, false, `the provider's answer (${o ? code : "no outcome"}) leaves it unclear whether it was accepted, so it may have sent and is not retried automatically${detail}.`);
            uncertain.push(w);
          }
        }
        await markMaybeSent(uncertain);
        if (sent.length > 0) await recordProviderSuccess(deps.kv, now);
        else if (providerFault) await providerFailed();

        if (result.cost) {
          const usd = typeof result.cost.usd === "number" && Number.isFinite(result.cost.usd) && result.cost.usd > 0 ? result.cost.usd : 0;
          await recordCost(db, { provider: result.cost.provider || p.name, capability: result.cost.capability || "send", ...(result.cost.units !== undefined ? { units: result.cost.units } : {}), costMicroCents: Math.round(usd * 1_000_000) }, now);
        }
        if (sent.length > 0) await bookkeep(p.name, sent);
      }

      async function providerFailed(): Promise<void> {
        const state = await recordProviderFailure(deps.kv, now);
        if (!state.opened) return;
        log.warn("the provider circuit breaker opened", { consecutive: state.consecutive });
        await pageOnce({
          db,
          kv: deps.kv,
          operator: deps.operator,
          eventId: `delivery:breaker:${utcDay(now)}`,
          effect: "page",
          text: `Email provider circuit breaker opened: ${state.consecutive} consecutive provider failures today (UTC). Sends are deferred to midnight UTC. Check the provider's status and the API key.`,
        });
      }

      async function bookkeep(providerName: string, sent: Array<{ w: Work; sendId: string; providerMessageId: string }>): Promise<void> {
        const at = now.toISOString();
        const rows = await Promise.all(
          sent.map(async (s) => ({ ...s, bodySha: await sha256Hex(s.w.item.body), domain: (s.w.to as string).slice((s.w.to as string).lastIndexOf("@") + 1) })),
        );
        const failed = new Map<number, string[]>();
        const note = (written: boolean[], name: string, owners: number[]) =>
          written.forEach((ok, i) => {
            if (ok) return;
            const owner = owners[i] as number;
            failed.set(owner, [...(failed.get(owner) ?? []), name]);
          });
        const kinds: Array<{ name: string; build: (r: (typeof rows)[number]) => D1PreparedStatement | null }> = [
          {
            name: "outreach_sends",
            build: (r) =>
              db
                .prepare(
                  `INSERT OR IGNORE INTO outreach_sends (id, contact_id, account_key, campaign_id, draft_id, template_id, body_sha256, subject, experiment_id,
                     experiment_arm, sequence_step, send_path, channel, provider, provider_message_id, recipient_domain, sent_at, created_at, template_sha256, cohort)
                   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'email', ?13, ?14, ?15, ?16, ?16, ?17, ?18)`,
                )
                .bind(
                  r.sendId,
                  r.w.item.contactId,
                  ledgerAccountKey(r.w.contact?.account_key, r.w.to as string),
                  r.w.item.campaignId ?? null,
                  r.w.item.draftId ?? null,
                  r.w.item.templateId ?? null,
                  r.bodySha,
                  r.w.item.subject,
                  r.w.item.experimentId ?? null,
                  r.w.item.experimentArm ?? null,
                  Number.isInteger(r.w.item.sequenceStep) ? r.w.item.sequenceStep : null,
                  r.w.path,
                  providerName,
                  r.providerMessageId,
                  r.domain,
                  at,
                  ledgerTemplateSha(r.w.item.templateSha256),
                  ledgerCohort(r.w.item.cohort),
                ),
          },
          {
            name: "outreach_log",
            build: (r) =>
              db
                .prepare(
                  `INSERT INTO outreach_log (id, contact_id, channel, direction, subject, summary, outcome, provider, provider_message_id, created_at)
                   VALUES (?1, ?2, 'email', 'outbound', ?3, ?4, 'sent', ?5, ?6, ?7)`,
                )
                .bind(crypto.randomUUID(), r.w.item.contactId, r.w.item.subject, `${r.w.path} email`, providerName, r.providerMessageId, at),
          },
          {
            name: "draft",
            build: (r) =>
              r.w.item.draftId
                ? db
                    .prepare(
                      "UPDATE drafts SET status = 'sent', sent_at = ?2, updated_at = ?2 WHERE id = ?1 AND (contact_id IS NULL OR contact_id = ?3) AND status = 'approved'",
                    )
                    .bind(r.w.item.draftId, at, r.w.item.contactId)
                : null,
          },
          {
            // The compare-and-set advanceWarmth(db, id, "contacted") makes from cold, batched: it moves
            // only a contact still cold, so it can never move warmth backwards or out of a terminal state.
            name: "warmth",
            build: (r) => db.prepare("UPDATE contacts SET warmth = 'contacted', updated_at = ?2 WHERE id = ?1 AND warmth = 'cold'").bind(r.w.item.contactId, at),
          },
          {
            name: "contact_touch",
            build: (r) => db.prepare("UPDATE contacts SET last_contacted_at = ?2, total_touches = total_touches + 1, updated_at = ?2 WHERE id = ?1").bind(r.w.item.contactId, at),
          },
          {
            name: "campaign_contacts",
            build: (r) =>
              r.w.item.campaignId
                ? db
                    .prepare(
                      `INSERT INTO campaign_contacts (campaign_id, contact_id, draft_id, status, sequence_step, experiment_id, experiment_arm, sequence_active, next_send_at, created_at, updated_at)
                       SELECT ?1, ?2, ?3, 'sent', ?4, ?5, ?6, COALESCE(?8, 0), ?9, ?7, ?7 WHERE EXISTS (SELECT 1 FROM campaigns WHERE id = ?1)
                       ON CONFLICT (campaign_id, contact_id) DO UPDATE SET
                         status = CASE WHEN campaign_contacts.status IN ('pending', 'sent', 'skipped') THEN 'sent' ELSE campaign_contacts.status END,
                         draft_id = COALESCE(excluded.draft_id, campaign_contacts.draft_id),
                         sequence_step = COALESCE(excluded.sequence_step, campaign_contacts.sequence_step),
                         sequence_active = CASE WHEN ?8 IS NOT NULL AND campaign_contacts.status IN ('pending', 'sent', 'skipped') AND campaign_contacts.sequence_paused_at IS NULL THEN ?8 ELSE campaign_contacts.sequence_active END,
                         next_send_at = CASE WHEN ?8 IS NOT NULL AND campaign_contacts.status IN ('pending', 'sent', 'skipped') AND campaign_contacts.sequence_paused_at IS NULL THEN ?9 ELSE campaign_contacts.next_send_at END,
                         updated_at = excluded.updated_at`,
                    )
                    .bind(
                      r.w.item.campaignId,
                      r.w.item.contactId,
                      r.w.item.draftId ?? null,
                      Number.isInteger(r.w.item.sequenceStep) ? r.w.item.sequenceStep : null,
                      r.w.item.experimentId ?? null,
                      r.w.item.experimentArm ?? null,
                      at,
                      ...followUp(r.w.item),
                    )
                : null,
          },
          {
            name: "funnel_event",
            build: (r) =>
              db
                .prepare(
                  `INSERT INTO funnel_events (id, event_type, contact_id, source, campaign_id, experiment_id, metadata, occurred_at, created_at)
                   VALUES (?1, 'outreach_sent', ?2, 'agent', ?3, ?4, ?5, ?6, ?6)`,
                )
                .bind(
                  crypto.randomUUID(),
                  r.w.item.contactId,
                  r.w.item.campaignId ?? null,
                  r.w.item.experimentId ?? null,
                  JSON.stringify({ provider: providerName, provider_message_id: r.providerMessageId, send_id: r.sendId, draft_id: r.w.item.draftId ?? null, variant: r.w.item.experimentArm ?? null, path: r.w.path }),
                  at,
                ),
          },
          {
            name: "domain_delivery",
            build: (r) =>
              db
                .prepare("INSERT INTO domain_delivery (domain, sends, created_at, updated_at) VALUES (?1, 1, ?2, ?2) ON CONFLICT (domain) DO UPDATE SET sends = sends + 1, updated_at = excluded.updated_at")
                .bind(r.domain, at),
          },
        ];
        for (const kind of kinds) {
          const statements: D1PreparedStatement[] = [];
          const owners: number[] = [];
          for (const r of rows) {
            const statement = kind.build(r);
            if (statement) {
              statements.push(statement);
              owners.push(r.w.index);
            }
          }
          note(await runWrites(db, statements), kind.name, owners);
        }
        for (const r of rows) {
          const failedWrites = failed.get(r.w.index);
          if (failedWrites) log.warn("bookkeeping after a send failed; the send stands", { sendId: r.sendId, failedWrites });
          outcomes[r.w.index] = {
            idempotencyKey: keyOf(r.w.index),
            status: "sent",
            providerMessageId: r.providerMessageId,
            sendId: r.sendId,
            ...(failedWrites ? { failedWrites } : {}),
          };
        }
      }

      async function finish(): Promise<OutreachOutcome[]> {
        if (runOptions.persistDeferrals) await persistDeferrals();
        return outcomes.map((o, i) => o ?? { idempotencyKey: keyOf(i), status: "failed", retryable: true, message: "the item was not processed; nothing was sent." });
      }

      async function persistDeferrals(): Promise<void> {
        // A mailbox reply is never queued: the deferred replay sends through the email provider,
        // and a held reply is retried by its caller instead.
        const deferred = outcomes
          .map((o, index) => ({ o, index }))
          .filter((d): d is { o: Extract<OutreachOutcome, { status: "deferred" }>; index: number } => d.o?.status === "deferred" && !warmIndexes.has(d.index));
        if (deferred.length === 0) return;
        const groups = await Promise.all(deferred.map(({ o, index }) => deferStatements(db, resolved.get(index) ?? (items[index] as OutreachItem), o, now, zones.get(index) ?? null)));
        const written = await runGroups(db, groups);
        // A group that ran inserted nothing when the contact does not exist; that needs a check.
        const ids = await existingContacts(db, deferred.map(({ index }) => (items[index] as OutreachItem).contactId)).catch(() => null);
        deferred.forEach(({ index }, i) => {
          const item = items[index] as OutreachItem;
          if (!written[i]) {
            outcomes[index] = { idempotencyKey: keyOf(index), status: "failed", retryable: true, message: "it had to wait, but the deferred queue could not be written; nothing was sent." };
          } else if (ids && !ids.has(item.contactId)) {
            outcomes[index] = { idempotencyKey: keyOf(index), status: "blocked", reason: "invalid", message: "[SEND BLOCKED:invalid] the contact does not exist." };
          }
        });
      }
    },
  };
}

/** The send function for email through the provider. One outcome per item, in order; never throws. */
export function createOutreachSender(deps: OutreachSenderDeps): SendOutreach {
  const boundary = createDeliveryBoundary(deps);
  return async (items) => {
    try {
      return await boundary.run(items, { persistDeferrals: true });
    } catch (error) {
      // Unreachable by design; a defect must still never become a send or an unhandled rejection.
      (deps.log ?? silentLog).error("the send function failed unexpectedly", { error: sanitizeErrorMessage(error) });
      return items.map((item) => ({ idempotencyKey: typeof item?.idempotencyKey === "string" ? item.idempotencyKey : "", status: "failed" as const, retryable: true, message: "the send function failed unexpectedly; see the logs." }));
    }
  };
}

/** The deferred queue's dedup key: one queued row per (contact, campaign, subject, path, sequence step). */
export function deferredDedupKey(item: Pick<OutreachItem, "contactId" | "campaignId" | "subject" | "path" | "sequenceStep">): Promise<string> {
  return sha256Hex(JSON.stringify(["deferred", item.contactId, item.campaignId ?? "", item.subject, String(item.path), item.sequenceStep ?? null]));
}

/** The fields deferred_sends has no column for, kept as JSON so a replay rebuilds the exact item. */
export function deferredItemJson(item: OutreachItem): string {
  return JSON.stringify({
    idempotencyKey: item.idempotencyKey,
    ...(item.toName !== undefined ? { toName: item.toName } : {}),
    ...(item.templateId !== undefined ? { templateId: item.templateId } : {}),
    ...(item.sequenceStep !== undefined ? { sequenceStep: item.sequenceStep } : {}),
    ...(item.inReplyTo !== undefined ? { inReplyTo: item.inReplyTo } : {}),
    ...(item.references !== undefined ? { references: [...item.references] } : {}),
    ...(item.approvedDigest !== undefined ? { approvedDigest: item.approvedDigest } : {}),
    ...(item.templateSha256 !== undefined ? { templateSha256: item.templateSha256 } : {}),
    ...(item.cohort !== undefined ? { cohort: item.cohort } : {}),
  });
}

/** The ledger's template_sha256: a lowercase hex SHA-256, or nothing. Bookkeeping, never a gate. */
function ledgerTemplateSha(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

/** The ledger's cohort: one of metrics/cohort.ts's values, or nothing. Bookkeeping, never a gate. */
function ledgerCohort(value: unknown): string | null {
  return isSendCohort(value) ? value : null;
}

/**
 * The statements that put one item in the deferred queue, in order: update the queued row holding
 * the same dedup key if there is one; otherwise insert a row (only for a contact that exists) and
 * its item record. Run together, they never leave a second queued row for the same message.
 */
async function deferStatements(db: D1Database, item: OutreachItem, outcome: { reason: DeferReason; nextAttemptAt: string }, now: Date, timezone: string | null): Promise<D1PreparedStatement[]> {
  const at = now.toISOString();
  const path: SendPath = (SEND_PATHS as readonly string[]).includes(String(item.path)) ? item.path : "cold";
  const dedup = await deferredDedupKey(item);
  const json = deferredItemJson(item);
  const id = crypto.randomUUID();
  const recipient = normalizeAddress(item.to) ?? item.to;
  return [
    db
      .prepare(
        `UPDATE deferred_sends SET next_attempt_at = ?2, defer_reason = ?3, body = ?4, draft_id = ?5, experiment_id = ?6, experiment_arm = ?7,
           recipient_email = ?8, recipient_timezone = COALESCE(?9, recipient_timezone)
          WHERE status = 'queued' AND id = (SELECT deferred_id FROM deferred_send_items WHERE dedup_key = ?1)`,
      )
      .bind(dedup, outcome.nextAttemptAt, outcome.reason, item.body, item.draftId ?? null, item.experimentId ?? null, item.experimentArm ?? null, recipient, timezone),
    db.prepare("UPDATE deferred_send_items SET idempotency_key = ?2, item = ?3 WHERE dedup_key = ?1").bind(dedup, item.idempotencyKey, json),
    db
      .prepare(
        `INSERT INTO deferred_sends (id, contact_id, campaign_id, draft_id, experiment_id, experiment_arm, send_path, recipient_email, subject, body,
           defer_reason, recipient_timezone, next_attempt_at, attempt_count, status, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, 'queued', ?14
          WHERE EXISTS (SELECT 1 FROM contacts WHERE id = ?2) AND NOT EXISTS (SELECT 1 FROM deferred_send_items WHERE dedup_key = ?15)`,
      )
      .bind(id, item.contactId, item.campaignId ?? null, item.draftId ?? null, item.experimentId ?? null, item.experimentArm ?? null, path, recipient, item.subject, item.body, outcome.reason, timezone, outcome.nextAttemptAt, at, dedup),
    db
      .prepare("INSERT INTO deferred_send_items (deferred_id, idempotency_key, dedup_key, item, created_at) SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM deferred_sends WHERE id = ?1)")
      .bind(id, item.idempotencyKey, dedup, json, at),
  ];
}

/** Run groups of statements: all in one batch, or each group in its own batch if that fails. Never throws. */
async function runGroups(db: D1Database, groups: readonly D1PreparedStatement[][]): Promise<boolean[]> {
  if (groups.length === 0) return [];
  try {
    await db.batch(groups.flat());
    return groups.map(() => true);
  } catch {
    const written: boolean[] = [];
    for (const group of groups) {
      try {
        await db.batch(group);
        written.push(true);
      } catch {
        written.push(false);
      }
    }
    return written;
  }
}

async function idsWith(db: D1Database, prefix: string, ids: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const chunk of inChunks([...new Set(ids)], IN_CHUNK)) {
    const { results } = await db.prepare(`${prefix} (${chunk.map((_, k) => `?${k + 1}`).join(", ")})`).bind(...chunk).all<{ id: string }>();
    for (const row of results) found.add(row.id);
  }
  return found;
}

async function existingContacts(db: D1Database, ids: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const chunk of inChunks([...new Set(ids)], IN_CHUNK)) {
    const { results } = await db.prepare(`SELECT id FROM contacts WHERE id IN (${chunk.map((_, k) => `?${k + 1}`).join(", ")})`).bind(...chunk).all<{ id: string }>();
    for (const row of results) found.add(row.id);
  }
  return found;
}

async function loadContacts(db: D1Database, ids: readonly string[]): Promise<Map<string, ContactRow>> {
  const out = new Map<string, ContactRow>();
  for (const chunk of inChunks([...new Set(ids)], IN_CHUNK)) {
    const { results } = await db
      .prepare(`SELECT id, email, email_sha256, account_key, timezone, location, verification_status FROM contacts WHERE id IN (${chunk.map((_, k) => `?${k + 1}`).join(", ")})`)
      .bind(...chunk)
      .all<ContactRow>();
    for (const row of results) out.set(row.id, row);
  }
  return out;
}

async function loadVerifications(db: D1Database, hashes: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const chunk of inChunks([...new Set(hashes)], IN_CHUNK)) {
    const { results } = await db
      .prepare(`SELECT email_sha256, status FROM email_verifications WHERE email_sha256 IN (${chunk.map((_, k) => `?${k + 1}`).join(", ")})`)
      .bind(...chunk)
      .all<{ email_sha256: string; status: string }>();
    for (const row of results) out.set(row.email_sha256, row.status);
  }
  return out;
}

async function loadDrafts(db: D1Database, ids: readonly string[]): Promise<Map<string, DraftRow>> {
  const out = new Map<string, DraftRow>();
  for (const chunk of inChunks([...new Set(ids)], IN_CHUNK)) {
    const { results } = await db
      .prepare(`SELECT id, contact_id, status, approved_digest, recipient_email AS "to", subject, body FROM drafts WHERE id IN (${chunk.map((_, k) => `?${k + 1}`).join(", ")})`)
      .bind(...chunk)
      .all<DraftRow>();
    for (const row of results) out.set(row.id, row);
  }
  return out;
}
