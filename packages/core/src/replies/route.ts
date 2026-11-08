// GTM-agents: what happens after triage: the side effects of each intent, and whether a draft may
// be written.
//
// Every effect is claimed in the effects ledger under the message's event id (reply:<inbound id>),
// so a re-run never repeats one. Bookkeeping fails open: a failed write is logged and dropped. The
// one exception is the opt-out, a compliance control: when it fails, routing is incomplete and the
// next run retries it (the other effects stay claimed and do not repeat).
//
//   opt_out at 0.8+             suppress the sender's address and opt their contacts out
//                               (optOutAddress); no draft; archived
//   interested, question or
//   objection at 0.7+           advance the open deal one stage, never past demo_scheduled
//   not_a_fit or opt_out 0.8+   close the open deal lost, with a reason
//   not_a_fit 0.8+, no opt-out
//   wording                     hold the account for 90 days (contacts.declined_at, read by cold
//                               selection); a short closed decline is archived without a draft
//   positive at 0.7+            clears an earlier decline hold
//   referral at 0.7+            add up to 3 colleagues from the message's To and Cc headers, at
//                               the sender's account, as warming contacts (never cold); suppressed
//                               and erased addresses are skipped
//   objection                   filed for curation; a second objection from the same contact
//                               gets no draft
//   spam, auto_reply, noise 0.8+ no draft; archived
//   any human reply             warmth forward only (advanceWarmth), the send ledger credited,
//                               sequences stopped again (stopSequences is idempotent)
// Addresses come only from the row (the sender) and the mailbox's headers (colleagues). Nothing the
// model returned chooses an address.
import type { GtmConfig } from "../config/schema.ts";
import { advanceWarmth, contactEmailFields } from "../data/contacts.ts";
import { transitionDeal } from "../data/deals.ts";
import { DEAL_STAGES, type DealStage, type Warmth } from "../data/enums.ts";
import { accountKey } from "../data/keys.ts";
import { claimEffect, runOnce } from "../events/effects.ts";
import type { JobLogger } from "../jobs/registry.ts";
import { countsAsReply, isPositiveIntent, type ReplyIntent } from "../metrics/positive-reply.ts";
import type { InboxProvider, InboundMessage } from "../ports/email.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { optOutAddress } from "../sending/opt-out.ts";
import { checkSuppression, normalizeAddress } from "../sending/suppression.ts";
import { stopSequences } from "../sequences/state.ts";
import { REPLY_THRESHOLDS } from "./flags.ts";
import { creditReply } from "./ledger.ts";
import { fileObjection, hadEarlierObjection, matchBrainObjections, type BrainObjection } from "./objections.ts";
import { replyEventId, type ContactRow, type InboundRow, type StoredTriage } from "./rows.ts";
import { hasOptOutWording, wordCount } from "./text.ts";

export const MAX_REFERRALS = 3;
/** A decline this short, with no question in it, is archived without a draft. */
export const SHORT_DECLINE_WORDS = 40;
const DEAL_ADVANCE_CAP: DealStage = "demo_scheduled";
const NO_DRAFT_INTENTS: readonly ReplyIntent[] = ["opt_out", "spam", "auto_reply", "noise", "unclear"];
const ROUTED = "routed";

export interface RouteDeps {
  db: D1Database;
  config: Pick<GtmConfig, "company" | "sending">;
  /** The warm mailbox, for the To and Cc headers of a referral. Without it referrals add nobody. */
  inbox?: InboxProvider;
  /** The brain's objection items, for filing an objection under its pattern. */
  objections: readonly BrainObjection[];
  now: Date;
  log: JobLogger;
}

export interface RouteResult {
  /** False when the opt-out could not be written: routing runs again next time. */
  complete: boolean;
  archived: boolean;
  /** Null when a draft may be written; otherwise why not. */
  noDraft: string | null;
  applied: string[];
  failures: string[];
}

/** True for an address of the deployment's own: the company domain, the sending domain, or a configured mailbox. */
export function isOwnAddress(config: Pick<GtmConfig, "company" | "sending">, address: string | null | undefined): boolean {
  const normalized = normalizeAddress(address);
  if (!normalized) return true;
  const own = [config.sending.replyTo, config.sending.supportAddress, config.sending.from.email].map((a) => a.toLowerCase());
  if (own.includes(normalized)) return true;
  const key = accountKey(normalized);
  const domain = normalized.slice(normalized.lastIndexOf("@") + 1);
  return key === config.company.domain || domain === config.company.domain || domain.endsWith(`.${config.company.domain}`) || domain === config.sending.domain;
}

/** The open deal a reply moves: the row's own, else the contact's, else (only when advancing) the account's most recent. */
async function openDeal(db: D1Database, row: InboundRow, contact: ContactRow | null, accountFallback: boolean): Promise<{ id: string; stage: DealStage } | null> {
  return db
    .prepare(
      `SELECT id, stage FROM deals
        WHERE stage NOT IN ('closed_won', 'closed_lost')
          AND (id = ?1 OR contact_id = ?2 OR (?3 IS NOT NULL AND account_key = ?3))
        ORDER BY (id = ?1) DESC, (contact_id = ?2) DESC, updated_at DESC LIMIT 1`,
    )
    .bind(row.deal_id ?? "", contact?.id ?? row.contact_id ?? "", accountFallback ? (contact?.account_key ?? null) : null)
    .first<{ id: string; stage: DealStage }>();
}

/** The next stage one step on, or null when the deal is already at or past the cap. */
export function nextDealStage(stage: DealStage): DealStage | null {
  const at = DEAL_STAGES.indexOf(stage);
  const cap = DEAL_STAGES.indexOf(DEAL_ADVANCE_CAP);
  if (at < 0 || at >= cap) return null;
  return DEAL_STAGES[at + 1] ?? null;
}

/** The warmth a human reply moves a contact to (forward only), or null. */
export function warmthFor(intent: ReplyIntent): Warmth | null {
  if (isPositiveIntent(intent)) return "engaged";
  if (intent === "warm" || intent === "objection") return "warming";
  return null;
}

/** The To and Cc addresses of the recorded message, from the mailbox. Throws when the mailbox cannot be read. */
async function messageRecipients(inbox: InboxProvider, row: InboundRow): Promise<string[]> {
  if (!row.provider_thread_id) return [];
  const thread: InboundMessage[] = await inbox.getThread(row.provider_thread_id);
  const message = thread.find((m) => m.providerMessageId === row.provider_message_id);
  if (!message) return [];
  return [...(message.to ?? []), ...(message.cc ?? [])];
}

/** Add colleagues named in the headers as warming contacts. Returns the addresses added or warmed. */
async function addColleagues(deps: RouteDeps, row: InboundRow, contact: ContactRow | null): Promise<string[]> {
  if (!deps.inbox) return [];
  const sender = normalizeAddress(row.sender_email);
  const account = contact?.account_key ?? accountKey(sender);
  if (!sender || !account) return [];
  const seen = new Set<string>([sender]);
  const colleagues: string[] = [];
  for (const raw of await messageRecipients(deps.inbox, row)) {
    const address = normalizeAddress(raw);
    if (!address || seen.has(address) || isOwnAddress(deps.config, address) || accountKey(address) !== account) continue;
    seen.add(address);
    colleagues.push(address);
    if (colleagues.length >= MAX_REFERRALS) break;
  }
  if (colleagues.length === 0) return [];
  const suppression = await checkSuppression(deps.db, colleagues);
  const blocked = new Set(suppression.blocked.map((b) => normalizeAddress(b.recipient) ?? b.recipient));
  if (suppression.blocked.some((b) => b.reason === "check_failed")) return [];
  const at = deps.now.toISOString();
  const added: string[] = [];
  for (const address of colleagues) {
    if (blocked.has(address)) continue;
    const fields = await contactEmailFields(address);
    if (!fields) continue;
    const inserted = await deps.db
      .prepare(
        `INSERT OR IGNORE INTO contacts (id, email, email_sha256, mailbox_sha256, account_key, source, warmth, notes, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'referral', 'warming', 'Added from the headers of a reply that brought them in', ?6, ?6)`,
      )
      .bind(`ct_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, fields.email, fields.email_sha256, fields.mailbox_sha256, account, at)
      .run();
    if ((inserted.meta.changes ?? 0) > 0) {
      added.push(address);
      continue;
    }
    // Already a contact: make sure they are out of cold selection.
    const existing = await deps.db.prepare("SELECT id FROM contacts WHERE email = ?1").bind(fields.email).first<{ id: string }>();
    if (existing && (await advanceWarmth(deps.db, existing.id, "warming", deps.now)).changed) added.push(address);
  }
  return added;
}

/** Apply the side effects of one triaged message. Never throws. */
export async function routeReply(deps: RouteDeps, row: InboundRow, triage: StoredTriage, sender: string, contact: ContactRow | null): Promise<RouteResult> {
  const { db, now, log } = deps;
  const eventId = replyEventId(row.id);
  const intent = triage.intent;
  const confident = triage.confidence >= REPLY_THRESHOLDS.confident;
  const advancing = triage.confidence >= REPLY_THRESHOLDS.dealAdvance;
  const result: RouteResult = { complete: true, archived: false, noDraft: null, applied: [], failures: [] };

  // Each bookkeeping effect: claimed once, released if it throws, and dropped after logging.
  const effect = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      const outcome = await runOnce(db, eventId, name, fn);
      if (outcome.ran) result.applied.push(name);
    } catch (error) {
      result.failures.push(name);
      log.warn("a reply side effect failed; it was dropped", { inboundId: row.id, effect: name, error: sanitizeErrorMessage(error) });
    }
  };

  // 1. The opt-out, the compliance control. A failure leaves routing incomplete, so it is retried.
  // Opt-out wording in the sender's own text is a backstop: a removal request read as a decline,
  // as unclear, or as a low-confidence opt-out is still honored.
  const optOut = optOutApplies(triage, sender);
  if (optOut && !normalizeAddress(row.sender_email)) {
    // Not an address that can be suppressed, and not one any send would accept.
    log.warn("an opt-out came from an address that does not parse; nothing to suppress", { inboundId: row.id });
  } else if (optOut) {
    try {
      const outcome = await runOnce(db, eventId, "opt_out", () => optOutAddress(db, row.sender_email, { reason: "opt_out", source: "reply_triage", notes: `triage ${triage.confidence.toFixed(2)}`, now }));
      if (outcome.ran) result.applied.push("opt_out");
    } catch (error) {
      result.complete = false;
      result.failures.push("opt_out");
      log.error("an opt-out from a reply could not be written; it will be retried", { inboundId: row.id, error: sanitizeErrorMessage(error) });
    }
  }

  // 2. The deal.
  const closes = (intent === "not_a_fit" || intent === "opt_out") && confident;
  const advances = (intent === "interested" || intent === "question" || intent === "objection") && advancing;
  if (closes || advances) {
    await effect(closes ? "deal_lost" : "deal_advance", async () => {
      // Closing touches only this message's or this contact's own deal; a colleague's decline never closes it.
      const deal = await openDeal(db, row, contact, !closes);
      if (!deal) return;
      const reason = `reply triaged as ${intent} (${triage.confidence.toFixed(2)})`;
      if (closes) {
        const moved = await transitionDeal(db, deal.id, "closed_lost", { reason, actor: "replies", now });
        if (moved.changed) {
          await db
            .prepare("UPDATE deals SET loss_reason = COALESCE(loss_reason, ?2), updated_at = ?3 WHERE id = ?1 AND stage = 'closed_lost'")
            .bind(deal.id, intent === "opt_out" ? "other" : "no_need", now.toISOString())
            .run();
        }
        return;
      }
      const next = nextDealStage(deal.stage);
      if (next) await transitionDeal(db, deal.id, next, { reason, actor: "replies", now });
    });
  }

  // 3. A confident decline holds the account; a positive reply lifts an earlier hold.
  const decline = intent === "not_a_fit" && confident && !hasOptOutWording(sender);
  if (decline && contact) {
    await effect("decline_hold", () =>
      db.prepare("UPDATE contacts SET declined_at = ?2, updated_at = ?3 WHERE id = ?1 AND (declined_at IS NULL OR declined_at < ?2)").bind(contact.id, row.received_at, now.toISOString()).run(),
    );
  }
  if (isPositiveIntent(intent) && advancing && contact) {
    await effect("decline_clear", () =>
      db.prepare("UPDATE contacts SET declined_at = NULL, updated_at = ?3 WHERE id = ?1 AND declined_at IS NOT NULL AND declined_at <= ?2").bind(contact.id, row.received_at, now.toISOString()).run(),
    );
  }

  // 4. A referral brings colleagues in from the headers.
  if (intent === "referral" && advancing) {
    await effect("referrals", async () => {
      const added = await addColleagues(deps, row, contact);
      if (added.length > 0) log.info("referred colleagues added as warming contacts", { inboundId: row.id, count: added.length });
    });
  }

  // 5. An objection is filed for curation.
  if (intent === "objection") {
    await effect("objection_filed", () => {
      const pattern = matchBrainObjections(sender, deps.objections, 1)[0]?.id ?? "unmatched";
      return fileObjection(db, { inboundId: row.id, pattern, example: triage.quote, now });
    });
  }

  // 6. Warmth, the ledger and sequences, for a human reply from a known contact.
  const human = countsAsReply({ intent, classification: row.classification });
  if (contact && human) {
    const target = warmthFor(intent);
    if (target) await effect("warmth", () => advanceWarmth(db, contact.id, target, now));
    await effect("ledger", () => creditReply(db, { contactId: contact.id, intent, classification: row.classification, receivedAt: row.received_at }));
    await effect("sequences", () =>
      stopSequences(db, { contactIds: [contact.id], ...(contact.account_key ? { accountKey: contact.account_key } : {}) }, { reason: `replied (${intent})`, status: "replied", now }),
    );
  }

  // 7. Archive what needs no answer.
  const shortClosed = decline && wordCount(sender) <= SHORT_DECLINE_WORDS && !sender.includes("?");
  const archive = optOut || (["spam", "auto_reply", "noise"].includes(intent) && confident) || shortClosed;
  if (archive) {
    try {
      await db.prepare("UPDATE inbound_emails SET status = 'archived', updated_at = ?2 WHERE id = ?1 AND status IN ('new', 'notified')").bind(row.id, now.toISOString()).run();
      result.archived = true;
    } catch (error) {
      result.failures.push("archive");
      log.warn("a reply could not be archived", { inboundId: row.id, error: sanitizeErrorMessage(error) });
    }
  }

  // 8. Whether a draft may be written.
  result.noDraft = await noDraftReason(deps, row, triage, contact, sender);

  if (result.complete) {
    try {
      await claimEffect(db, eventId, ROUTED);
    } catch (error) {
      log.warn("a routed reply could not be marked; its claimed effects will not repeat", { inboundId: row.id, error: sanitizeErrorMessage(error) });
    }
  }
  return result;
}

/**
 * Why no draft may be written for a triaged message, or null when one may: archived intents and
 * short closed declines need no answer, an unknown sender or one of the deployment's own addresses
 * gets none, opt-outs, spam, automatic replies, noise and unclear mail are left to a person, and a
 * contact's second objection gets none (one answer per contact).
 */
/** True when the reply must be treated as an opt-out: a confident opt-out, or opt-out wording with a declining, unclear or opt-out intent. */
export function optOutApplies(triage: Pick<StoredTriage, "intent" | "confidence">, sender: string): boolean {
  if (triage.intent === "opt_out" && triage.confidence >= REPLY_THRESHOLDS.confident) return true;
  return hasOptOutWording(sender) && (triage.intent === "opt_out" || triage.intent === "not_a_fit" || triage.intent === "unclear");
}

export async function noDraftReason(
  deps: Pick<RouteDeps, "db" | "config">,
  row: InboundRow,
  triage: StoredTriage,
  contact: ContactRow | null,
  sender: string,
): Promise<string | null> {
  const intent = triage.intent;
  const confident = triage.confidence >= REPLY_THRESHOLDS.confident;
  if (hasOptOutWording(sender)) return "the message asks to stop receiving mail; a person decides any answer";
  if (intent === "not_a_fit" && confident && !hasOptOutWording(sender) && wordCount(sender) <= SHORT_DECLINE_WORDS && !sender.includes("?")) return "a short, closed decline needs no answer";
  if (["opt_out", "spam", "auto_reply", "noise"].includes(intent) && confident) return `${intent} needs no answer`;
  if (!contact) return "the sender is not a known contact";
  if (isOwnAddress(deps.config, contact.email)) return "the sender is one of this deployment's own addresses";
  if (NO_DRAFT_INTENTS.includes(intent)) return `${intent} is left to a person`;
  if (intent === "objection") {
    try {
      if (await hadEarlierObjection(deps.db, contact.id, row)) return "the contact's earlier objection already had its one answer";
    } catch {
      return "earlier objections could not be read";
    }
  }
  return null;
}

/** The SQL condition "this message has been routed", for an inbound_emails row aliased `i`. */
export const ROUTED_SQL = `EXISTS (SELECT 1 FROM event_effects ee WHERE ee.event_id = 'reply:' || i.id AND ee.effect = '${ROUTED}')`;
