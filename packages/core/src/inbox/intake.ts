// GTM-agents: inbox intake. Every inbound message, from a poll, a sweep, a push wake-up or Email
// Routing, is recorded here, once, and its deterministic side effects applied.
//
// recordInbound(deps, messages), per message:
//   1. skip what cannot be recorded honestly: an id or sender address that does not parse;
//   2. skip mail from us: anything the mailbox sent (isFromUs), and anything from the cold sender,
//      the reply-to mailbox or the sending domain, so our own copies and loops never count;
//   3. skip messages already recorded (provider, provider_message_id is unique);
//   4. match the sender to a contact by exact address hash, then by mailbox hash (the address
//      without a +tag), and take the account key from the contact or the sender's domain. Mail
//      from the company's own domain or the support address is "own mail": recorded with no
//      contact and no account, status ignored, so nothing ever drafts to it or treats it as a
//      prospect;
//   5. classify it structurally (classify.ts), with a database check of whether it answers our
//      mail: In-Reply-To or References naming one of our sends or a message we already hold, or a
//      thread we already know;
//   6. store the body in blob storage, then insert the row with its classification, status new
//      and intent NULL (semantic triage fills intent later). If the blob cannot be written the row
//      is still recorded, with body_key NULL and the [body_not_stored] note, because detection
//      matters more than the archive: the preview is on the row, and the sweep fetches the body
//      again from providers that can (getThread). A body is always written when storage works,
//      even an empty one, so body_key NULL means "not stored", never "no text";
//   7. apply the rules below, then set processed_at.
//
// The rules, each bookkeeping (caught, logged, the row still counts as processed) unless noted:
//   - reply, new_inquiry or unclassified, from a known contact or anyone at a known account: stop
//     sequences now (stopSequences) for the contact and the account, with status replied;
//   - unsubscribe: optOutAddress(sender, opt_out, inbound_unsubscribe). A compliance control: if it
//     throws, processed_at stays NULL, the operator is told once, and the pending pass retries it.
//     The account's other sequences stop too, and the operator gets a notice;
//   - bounce: the failed recipient is read from the report (bounce.ts). Only a permanent failure for
//     an address we actually sent to (a contact with a send in the ledger) is acted on, with
//     optOutAddress(recipient, bounce, inbound_bounce): suppressed, marked undeliverable, sequences
//     stopped, and not opted out. Like an unsubscribe, a failed write leaves the row pending. A
//     report that names no parseable recipient is recorded and skipped, never guessed at;
//   - out_of_office from a known contact: hold their sequences until the day after the return date
//     in their own text, or for 7 days with no usable date (holdSequences). No warmth change;
//   - auto_reply: nothing;
//   - a billing-failure notice, whatever its classification: priority high and a page.
// Own mail gets no side effects, except a bounce, which is judged by its recipient alone.
//
// Every body, subject and name is untrusted text. None of it reaches a prompt here, and none of it
// can choose a side effect beyond these fixed rules: the rules act only on the sender's own address,
// the matched contact and account, or a bounced address the ledger shows we sent to.
import type { GtmConfig } from "../config/schema.ts";
import { accountKey } from "../data/keys.ts";
import type { JobLogger } from "../jobs/registry.ts";
import type { InboundMessage } from "../ports/email.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { holdSequences, stopSequences } from "../sequences/state.ts";
import { optOutAddress } from "../sending/opt-out.ts";
import { pageOnce } from "../sending/pages.ts";
import { addressHash, mailboxOf, normalizeAddress } from "../sending/suppression.ts";
import type { KvStore } from "../shared/kv.ts";
import { inboundPreview, putInboundBody, readInboundBody } from "./body.ts";
import { parseBounce, type BounceInfo } from "./bounce.ts";
import { classifyStructural, isDeliveryReport, ownText, type StructuralClassification } from "./classify.ts";
import { outOfOfficeHoldUntil, parseReturnDate } from "./dates.ts";
import { cleanHeaderValue, messageIdDomain, parseMessageIds } from "./headers.ts";

// D1 binds at most 100 parameters per statement.
const CHUNK = 90;
/** Rows the pending pass leaves alone while intake may still be working on them. */
export const PENDING_GRACE_MS = 2 * 60_000;
/** The headers kept on the row, for threading replies and for the pending pass. */
const STORED_HEADERS = ["message-id", "in-reply-to", "references", "reply-to", "auto-submitted", "precedence", "list-id", "x-autoreply", "x-autorespond", "x-failed-recipients"] as const;
const MAX_STORED_HEADER_CHARS = 1000;

export interface InboxIntakeDeps {
  db: D1Database;
  /** Blob storage for bodies (the BUCKET binding). Without it, rows are recorded with no body. */
  bucket?: Pick<R2Bucket, "put" | "delete" | "get"> | null | undefined;
  config: Pick<GtmConfig, "company" | "sending">;
  /** The inbox provider's name, kept on every row: with the provider message id, the dedup key. */
  provider: string;
  operator?: OperatorChannel | undefined;
  kv?: KvStore | null | undefined;
  now: Date;
  log?: JobLogger | undefined;
}

export interface IntakeResult {
  received: number;
  recorded: number;
  duplicates: number;
  /** Mail the mailbox or the deployment sent itself. */
  fromUs: number;
  /** Messages skipped because their id or sender address does not parse. */
  unparseable: number;
  /** Rows that could not be written. A caller that lists from a cursor does not move past them. */
  failed: number;
  /** Recorded rows whose rules ran to the end. */
  processed: number;
  /** Recorded rows left for the pending pass, because a compliance write failed. */
  pending: number;
  /** The ids of the rows recorded. */
  ids: string[];
}

/** What the rules need about one recorded row. */
interface RuleInput {
  id: string;
  classification: StructuralClassification | "unclassified";
  contactId: string | null;
  accountKey: string | null;
  sender: string;
  ownMail: boolean;
  text: string;
  billingAlert: boolean;
  /** Parsed at intake; null on a retry, which uses the stored recipient hashes instead. */
  bounce: BounceInfo | null;
  /** Each permanently failed recipient's exact and mailbox hash, as stored on the row. */
  failedRecipients: Array<{ exact: string; mailbox: string }>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** One line, no control characters, capped: for names and subjects stored on the row. */
function oneLine(value: unknown, max: number): string {
  return typeof value === "string" ? cleanHeaderValue(value).slice(0, max) : "";
}

/** The most failed recipients of one report that are acted on. */
const MAX_ACTED_RECIPIENTS = 5;

async function recipientHashes(addresses: readonly string[]): Promise<Array<{ exact: string; mailbox: string }>> {
  return Promise.all(addresses.map(async (a) => ({ exact: await addressHash(a), mailbox: await addressHash(mailboxOf(a)) })));
}

/** The recipient hashes stored on a row: a flat JSON list, exact then mailbox hash for each. */
function storedRecipients(raw: string | null): Array<{ exact: string; mailbox: string }> {
  if (!raw) return [];
  try {
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const hashes = list.filter((h): h is string => typeof h === "string" && /^[0-9a-f]{64}$/.test(h));
    const out: Array<{ exact: string; mailbox: string }> = [];
    for (let i = 0; i + 1 < hashes.length; i += 2) out.push({ exact: hashes[i] as string, mailbox: hashes[i + 1] as string });
    return out;
  } catch {
    return [];
  }
}

const domainOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1);
const within = (domain: string, root: string): boolean => domain === root || domain.endsWith(`.${root}`);

/**
 * Whose address this is: "self" for the deployment's own sending addresses (the cold sender, the
 * reply-to mailbox, anything on the sending domain), "own" for the rest of the company's domain
 * and the support address, null for everyone else.
 */
export function ownAddressKind(config: Pick<GtmConfig, "company" | "sending">, address: string): "self" | "own" | null {
  const sender = address.toLowerCase();
  const domain = domainOf(sender);
  const sending = config.sending;
  if (sender === sending.from.email.toLowerCase() || sender === sending.replyTo.toLowerCase() || within(domain, sending.domain.toLowerCase())) return "self";
  if (sender === sending.supportAddress.toLowerCase() || within(domain, config.company.domain.toLowerCase())) return "own";
  return null;
}

/** A provider message id worth keying on: 1 to 512 printable characters. */
function validMessageId(value: unknown): value is string {
  // eslint-disable-next-line no-control-regex -- control characters are what this rejects
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
}

function receivedAtOf(value: unknown, now: Date): string {
  if (typeof value === "string" && value.length <= 64) {
    const at = Date.parse(value);
    // A date more than a day in the future is not believed.
    if (Number.isFinite(at) && at <= now.getTime() + 86_400_000) return new Date(at).toISOString();
  }
  return now.toISOString();
}

function storedHeaders(message: InboundMessage): string | null {
  const headers = isRecord(message.headers) ? message.headers : {};
  const out: Record<string, string> = {};
  for (const name of STORED_HEADERS) {
    const value = headers[name];
    if (typeof value === "string" && value.length > 0) out[name] = cleanHeaderValue(value).slice(0, MAX_STORED_HEADER_CHARS);
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

/** The ids of messages already recorded for this provider. Bookkeeping read: an error returns none. */
export async function knownMessageIds(db: D1Database, provider: string, ids: readonly string[]): Promise<Set<string>> {
  const known = new Set<string>();
  const unique = [...new Set(ids.filter(validMessageId))];
  try {
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK);
      const { results } = await db
        .prepare(`SELECT provider_message_id AS id FROM inbound_emails WHERE provider = ?1 AND provider_message_id IN (${chunk.map((_, k) => `?${k + 2}`).join(", ")})`)
        .bind(provider, ...chunk)
        .all<{ id: string }>();
      for (const row of results) known.add(row.id);
    }
  } catch {
    // The insert's uniqueness check still keeps a message from being recorded twice.
  }
  return known;
}

async function matchContact(db: D1Database, address: string): Promise<{ id: string; account_key: string | null } | null> {
  const exact = await addressHash(address);
  const mailbox = await addressHash(mailboxOf(address));
  return db
    .prepare("SELECT id, account_key FROM contacts WHERE email_sha256 = ?1 OR mailbox_sha256 = ?2 ORDER BY (email_sha256 = ?1) DESC, created_at LIMIT 1")
    .bind(exact, mailbox)
    .first<{ id: string; account_key: string | null }>();
}

/**
 * Whether the message answers mail. `ours`: a message id in In-Reply-To or References is on one of
 * our domains or matches a send in the ledger (its Message-ID, or its provider id in full or as the
 * id's local part). `knownThread`: it references a message already recorded, or its thread already
 * holds one. Bookkeeping read: an error answers false for both, and the subject rules still apply.
 */
export async function answersOurMail(
  db: D1Database,
  input: { provider: string; threadId: string | null; ids: readonly string[]; ourDomains: readonly string[] },
): Promise<{ ours: boolean; knownThread: boolean }> {
  const ids = [...new Set(input.ids)].slice(-20);
  if (ids.some((id) => {
    const domain = messageIdDomain(id);
    return domain !== null && input.ourDomains.some((root) => within(domain, root));
  })) return { ours: true, knownThread: false };
  let knownThread = false;
  try {
    if (ids.length > 0) {
      // Ids are compared as sent (an In-Reply-To copies the Message-ID exactly), so the indexes apply.
      const bare = ids.map((id) => id.replace(/^<|>$/g, ""));
      const locals = bare.map((k) => k.slice(0, k.lastIndexOf("@")));
      const sendIds = [...new Set([...bare, ...locals])].filter((k) => k.length > 0);
      // The send ledger keeps the provider's own id and, once looked up, the RFC 5322 Message-ID.
      const send = await db
        .prepare(
          `SELECT 1 AS hit FROM outreach_sends WHERE provider_message_id IN (SELECT value FROM json_each(?1))
           UNION ALL SELECT 1 FROM outreach_sends WHERE message_id IN (SELECT value FROM json_each(?2)) LIMIT 1`,
        )
        .bind(JSON.stringify(sendIds), JSON.stringify(ids))
        .first();
      if (send) return { ours: true, knownThread: false };
      const recorded = await db.prepare("SELECT 1 AS hit FROM inbound_emails WHERE message_id IN (SELECT value FROM json_each(?1)) LIMIT 1").bind(JSON.stringify(ids)).first();
      knownThread = recorded !== null;
    }
    if (!knownThread && input.threadId) {
      const known = await db.prepare("SELECT 1 AS hit FROM inbound_emails WHERE provider = ?1 AND provider_thread_id = ?2 LIMIT 1").bind(input.provider, input.threadId).first();
      knownThread = known !== null;
    }
  } catch {
    return { ours: false, knownThread };
  }
  return { ours: false, knownThread };
}

function priorityOf(classification: StructuralClassification, billingAlert: boolean, contactId: string | null): "high" | "normal" | "low" {
  if (billingAlert) return "high";
  if (classification === "bounce" || classification === "auto_reply" || classification === "out_of_office") return "low";
  if (contactId && (classification === "reply" || classification === "new_inquiry")) return "high";
  return "normal";
}

/** Record new inbound mail and apply its rules. Never throws; see IntakeResult. */
export async function recordInbound(deps: InboxIntakeDeps, messages: readonly InboundMessage[]): Promise<IntakeResult> {
  const result: IntakeResult = { received: messages.length, recorded: 0, duplicates: 0, fromUs: 0, unparseable: 0, failed: 0, processed: 0, pending: 0, ids: [] };
  if (messages.length === 0) return result;
  const { db, config, now } = deps;
  const at = now.toISOString();
  const ourDomains = [config.company.domain.toLowerCase(), config.sending.domain.toLowerCase()];
  const known = await knownMessageIds(db, deps.provider, messages.map((m) => (isRecord(m) ? m.providerMessageId : "")));
  const seen = new Set<string>();

  for (const message of messages) {
    if (!isRecord(message) || !validMessageId(message.providerMessageId)) {
      result.unparseable += 1;
      continue;
    }
    if (known.has(message.providerMessageId) || seen.has(message.providerMessageId)) {
      result.duplicates += 1;
      continue;
    }
    seen.add(message.providerMessageId);
    if (message.isFromUs === true) {
      result.fromUs += 1;
      continue;
    }
    const sender = normalizeAddress(isRecord(message.from) ? message.from.email : undefined);
    if (!sender) {
      result.unparseable += 1;
      deps.log?.warn("an inbound message names no usable sender address, so it was skipped", { provider: deps.provider });
      continue;
    }
    const kind = ownAddressKind(config, sender);
    if (kind === "self") {
      result.fromUs += 1;
      continue;
    }
    const ownMail = kind === "own";
    const headers: Record<string, string> = isRecord(message.headers) ? Object.fromEntries(Object.entries(message.headers).filter((e): e is [string, string] => typeof e[1] === "string").map(([k, v]) => [k.toLowerCase(), v])) : {};
    const subject = oneLine(message.subject, 500);
    const text = typeof message.text === "string" ? message.text : "";
    const deliveryReport = typeof message.deliveryReport === "string" ? message.deliveryReport : undefined;
    const threadId = validMessageId(message.threadId) ? message.threadId : null;
    const messageIds = parseMessageIds(headers["message-id"]);
    // The same message can reach two intake paths (routed mail forwarded into a polled mailbox).
    // Recorded once: a message from the same sender with the same Message-ID under another provider
    // is a duplicate, so it is never triaged, drafted or approved twice.
    if (messageIds[0]) {
      try {
        const twin = await db
          .prepare("SELECT 1 AS one FROM inbound_emails WHERE message_id = ?1 AND sender_email = ?2 AND provider <> ?3 LIMIT 1")
          .bind(messageIds[0], sender, deps.provider)
          .first<{ one: number }>();
        if (twin) {
          // The polled copy knows the mailbox thread the routed copy could not; keep it, so a reply
          // from the mailbox can answer on that thread.
          if (threadId) {
            try {
              await db
                .prepare("UPDATE inbound_emails SET provider_thread_id = ?3, updated_at = ?4 WHERE message_id = ?1 AND sender_email = ?2 AND provider_thread_id IS NULL")
                .bind(messageIds[0], sender, threadId, at)
                .run();
            } catch (error) {
              deps.log?.warn("could not copy the mailbox thread onto the message's first record", { error: sanitizeErrorMessage(error) });
            }
          }
          result.duplicates += 1;
          continue;
        }
      } catch (error) {
        deps.log?.warn("could not check for the same message under another provider; recording it", { error: sanitizeErrorMessage(error) });
      }
    }
    const parents = [
      ...(typeof message.inReplyTo === "string" ? parseMessageIds(message.inReplyTo) : []),
      ...(Array.isArray(message.references) ? message.references.flatMap((r) => (typeof r === "string" ? parseMessageIds(r) : [])) : []),
      ...parseMessageIds(headers["in-reply-to"]),
      ...parseMessageIds(headers.references),
    ];

    let contact: { id: string; account_key: string | null } | null = null;
    if (!ownMail) {
      try {
        contact = await matchContact(db, sender);
      } catch (error) {
        deps.log?.warn("the sender could not be matched to a contact", { error: sanitizeErrorMessage(error) });
      }
    }
    const account = ownMail ? null : (contact?.account_key ?? accountKey(sender));
    const answers = await answersOurMail(db, { provider: deps.provider, threadId, ids: parents, ourDomains });
    const structural = classifyStructural({ from: sender, subject, text, headers, ...(deliveryReport ? { deliveryReport } : {}), repliesToUs: answers.ours, knownThread: answers.knownThread });
    // X-Failed-Recipients is read only on a message shaped like a delivery report, not on any mail
    // that adds the header (even from a mailer-daemon address). A shape check is not authentication,
    // so what a report can do stays narrow: suppress an address we actually sent to, nothing more.
    const bounce = structural.classification === "bounce" ? parseBounce({ headers, deliveryReport, trustFailedHeader: Boolean(deliveryReport) || isDeliveryReport(headers) }) : null;
    const failedRecipients = bounce ? await recipientHashes(bounce.permanent.slice(0, MAX_ACTED_RECIPIENTS)) : [];
    const senderExact = await addressHash(sender);
    const senderMailbox = await addressHash(mailboxOf(sender));

    const id = crypto.randomUUID();
    const tags: string[] = [];
    if (ownMail) tags.push("[own_mail]");
    if (structural.billingAlert) tags.push("[billing_alert]");
    let bodyKey: string | null = null;
    if (deps.bucket) {
      try {
        bodyKey = await putInboundBody(deps.bucket, id, text);
      } catch (error) {
        deps.log?.warn("an inbound body could not be stored; the row is recorded without it", { error: sanitizeErrorMessage(error) });
      }
    }
    if (!bodyKey) tags.push("[body_not_stored]");

    let inserted = false;
    let threw = false;
    try {
      const write = await db
        .prepare(
          `INSERT INTO inbound_emails (id, provider, provider_message_id, provider_thread_id, sender_email, sender_name, subject, body_preview, body_key, received_at,
             classification, contact_id, account_key, message_id, headers, failed_recipients, status, priority, notes, sender_sha256, sender_mailbox_sha256, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?21, ?22, ?20, ?20)
           ON CONFLICT (provider, provider_message_id) DO NOTHING`,
        )
        .bind(
          id,
          deps.provider,
          message.providerMessageId,
          threadId,
          sender,
          oneLine(isRecord(message.from) ? message.from.name : undefined, 200) || null,
          subject || null,
          inboundPreview(text) || null,
          bodyKey,
          receivedAtOf(message.receivedAt, now),
          structural.classification,
          contact?.id ?? null,
          account,
          messageIds[0] ?? null,
          storedHeaders({ ...message, headers }),
          failedRecipients.length > 0 ? JSON.stringify(failedRecipients.flatMap((h) => [h.exact, h.mailbox])) : null,
          ownMail ? "ignored" : "new",
          priorityOf(structural.classification, structural.billingAlert, contact?.id ?? null),
          tags.length > 0 ? tags.join(" ") : null,
          at,
          senderExact,
          senderMailbox,
        )
        .run();
      inserted = (write.meta.changes ?? 0) > 0;
    } catch (error) {
      threw = true;
      deps.log?.error("an inbound message could not be recorded", { error: sanitizeErrorMessage(error) });
    }
    if (!inserted) {
      // Either the insert failed, or another intake path recorded the message first. The blob
      // written for this attempt belongs to no row, so it goes.
      if (bodyKey && deps.bucket) await deps.bucket.delete(bodyKey).catch(() => undefined);
      if (threw) result.failed += 1;
      else result.duplicates += 1;
      continue;
    }
    result.recorded += 1;
    result.ids.push(id);

    const outcome = await applyInboundRules(deps, {
      id,
      classification: structural.classification,
      contactId: contact?.id ?? null,
      accountKey: account,
      sender,
      ownMail,
      text,
      billingAlert: structural.billingAlert,
      bounce,
      failedRecipients,
    });
    if (await finish(deps, id, outcome, tags)) result.processed += 1;
    else result.pending += 1;
  }
  return result;
}

/** Write the rule outcome: notes always, processed_at only when the rules completed. */
async function finish(deps: InboxIntakeDeps, id: string, outcome: { complete: boolean; tags: string[] }, baseTags: readonly string[]): Promise<boolean> {
  const notes = [...new Set([...baseTags, ...outcome.tags])].join(" ") || null;
  try {
    await deps.db
      .prepare("UPDATE inbound_emails SET notes = ?2, processed_at = CASE WHEN ?3 = 1 THEN ?4 ELSE processed_at END, updated_at = ?4 WHERE id = ?1")
      .bind(id, notes, outcome.complete ? 1 : 0, deps.now.toISOString())
      .run();
  } catch (error) {
    // The row stays unprocessed and the pending pass runs its (idempotent) rules again.
    deps.log?.warn("an inbound row could not be marked processed", { error: sanitizeErrorMessage(error) });
    return false;
  }
  return outcome.complete;
}

/** Was this address sent to? The contact holding it (exact or mailbox hash) with a send in the ledger. */
async function sentContact(db: D1Database, hashes: { exact: string; mailbox: string }): Promise<{ id: string; email: string } | null> {
  return db
    .prepare(
      `SELECT c.id, c.email FROM contacts c
        WHERE (c.email_sha256 IN (?1, ?2) OR c.mailbox_sha256 = ?2)
          AND EXISTS (SELECT 1 FROM outreach_sends s WHERE s.contact_id = c.id)
        ORDER BY (c.email_sha256 = ?1) DESC LIMIT 1`,
    )
    .bind(hashes.exact, hashes.mailbox)
    .first<{ id: string; email: string }>();
}

/**
 * Apply the deterministic rules to one recorded row. Idempotent, so the pending pass can run it
 * again. `complete` is false when a compliance write (an unsubscribe's or a matched bounce's
 * suppression) failed.
 */
export async function applyInboundRules(deps: InboxIntakeDeps, row: RuleInput): Promise<{ complete: boolean; tags: string[] }> {
  const { db, now } = deps;
  const tags: string[] = [];
  let complete = true;
  const bookkeeping = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      deps.log?.warn("an inbox side effect failed; it is dropped", { write: name, error: sanitizeErrorMessage(error) });
    }
  };
  const page = (eventId: string, effect: string, text: string) => bookkeeping("page", () => pageOnce({ db, kv: deps.kv, operator: deps.operator, eventId, effect, text }));
  const scope = { ...(row.contactId ? { contactIds: [row.contactId] } : {}), ...(row.accountKey ? { accountKey: row.accountKey } : {}) };
  const stopForReply = (reason: string) =>
    row.contactId || row.accountKey ? bookkeeping("sequences.stop", () => stopSequences(db, scope, { reason, status: "replied", now })) : Promise.resolve();

  if (row.billingAlert) {
    await page(`inbox:billing:${row.id}`, "notice", `A billing problem notice arrived from ${row.sender}. Check the account it refers to; nothing was changed automatically.`);
  }
  if (row.ownMail && row.classification !== "bounce") return { complete, tags };

  switch (row.classification) {
    case "reply":
    case "new_inquiry":
    case "unclassified":
      await stopForReply(`inbound ${row.classification}`);
      break;
    case "unsubscribe": {
      try {
        await optOutAddress(db, row.sender, { reason: "opt_out", source: "inbound_unsubscribe", notes: `inbound ${row.id}`, now });
        tags.push("[unsubscribed]");
        await page(`inbox:unsubscribe:${row.id}`, "notice", `Unsubscribed by email: ${row.sender}. Suppressed, opted out, sequences stopped.`);
      } catch (error) {
        complete = false;
        deps.log?.error("an unsubscribe could not be recorded; it will be retried", { error: sanitizeErrorMessage(error) });
        await page(`inbox:unsubscribe-failed:${row.id}`, "page", `An unsubscribe from ${row.sender} could not be recorded yet. It is retried every minute; until it lands, check that nothing is sent to this address.`);
        // Stopping only ever sends less, so the sender's own sequences stop now, as an opt-out.
        if (row.contactId) await bookkeeping("sequences.stop", () => stopSequences(db, { contactIds: [row.contactId as string] }, { reason: "inbound unsubscribe", status: "opted_out", now }));
      }
      // The rest of the account stops as it would for any reply.
      if (row.accountKey) await bookkeeping("sequences.stop", () => stopSequences(db, { accountKey: row.accountKey as string }, { reason: "inbound unsubscribe from the account", status: "replied", now }));
      break;
    }
    case "bounce": {
      const targets: Array<{ exact: string; mailbox: string }> = [];
      targets.push(...row.failedRecipients);
      if (targets.length === 0) tags.push(row.bounce && row.bounce.temporary.length > 0 ? "[bounce:temporary]" : "[bounce:unparsed]");
      for (const target of targets) {
        try {
          const contact = await sentContact(db, target);
          if (!contact) {
            tags.push("[bounce:not_ours]");
            continue;
          }
          await optOutAddress(db, contact.email, { reason: "bounce", source: "inbound_bounce", notes: `inbound ${row.id}`, now });
          tags.push("[bounce:suppressed]");
        } catch (error) {
          complete = false;
          deps.log?.error("a bounced address could not be suppressed; it will be retried", { error: sanitizeErrorMessage(error) });
        }
      }
      break;
    }
    case "out_of_office": {
      if (!row.contactId) break;
      const back = parseReturnDate(ownText(row.text), now);
      const until = outOfOfficeHoldUntil(back, now);
      tags.push(`[ooo:until=${until.toISOString().slice(0, 10)}]`);
      await bookkeeping("sequences.hold", () => holdSequences(db, { contactIds: [row.contactId as string] }, { until, reason: `out of office until ${until.toISOString().slice(0, 10)}`, now }));
      break;
    }
    case "auto_reply":
      break;
  }
  return { complete, tags };
}

interface PendingRow {
  id: string;
  classification: string | null;
  contact_id: string | null;
  account_key: string | null;
  sender_email: string;
  body_preview: string | null;
  body_key: string | null;
  failed_recipients: string | null;
  status: string;
  notes: string | null;
}

const CLASSIFICATIONS: ReadonlySet<string> = new Set(["bounce", "out_of_office", "auto_reply", "unsubscribe", "reply", "new_inquiry"]);

/**
 * Run the rules again for rows intake recorded but could not finish (a compliance write failed, or
 * the run stopped part way). Rows older than PENDING_GRACE_MS, with no age limit (an opt-out is never abandoned),
 * oldest first. Never throws.
 */
export async function processPendingInbound(deps: InboxIntakeDeps, options: { limit: number }): Promise<{ attempted: number; processed: number; pending: number }> {
  const out = { attempted: 0, processed: 0, pending: 0 };
  if (!(options.limit > 0)) return out;
  let rows: PendingRow[];
  try {
    const { results } = await deps.db
      .prepare(
        `SELECT id, classification, contact_id, account_key, sender_email, body_preview, body_key, failed_recipients, status, notes
           FROM inbound_emails WHERE processed_at IS NULL AND created_at <= ?1 ORDER BY created_at LIMIT ?2`,
      )
      .bind(new Date(deps.now.getTime() - PENDING_GRACE_MS).toISOString(), Math.max(1, Math.min(options.limit, 100)))
      .all<PendingRow>();
    rows = results;
  } catch (error) {
    deps.log?.warn("pending inbound rows could not be read", { error: sanitizeErrorMessage(error) });
    return out;
  }
  for (const row of rows) {
    out.attempted += 1;
    const sender = normalizeAddress(row.sender_email);
    if (!sender) {
      // Nothing can be done for an address that does not parse; mark it so it is not retried.
      if (await finish(deps, row.id, { complete: true, tags: ["[sender_unparseable]"] }, (row.notes ?? "").split(" ").filter(Boolean))) out.processed += 1;
      continue;
    }
    let text = row.body_preview ?? "";
    if (row.body_key && deps.bucket) {
      try {
        text = (await readInboundBody(deps.bucket, row.body_key)) ?? text;
      } catch {
        // The preview is enough for the rules that read text (a return date).
      }
    }
    const notes = row.notes ?? "";
    const outcome = await applyInboundRules(deps, {
      id: row.id,
      classification: row.classification && CLASSIFICATIONS.has(row.classification) ? (row.classification as StructuralClassification) : "unclassified",
      contactId: row.contact_id,
      accountKey: row.account_key,
      sender,
      ownMail: row.status === "ignored" && notes.includes("[own_mail]"),
      text,
      billingAlert: notes.includes("[billing_alert]"),
      bounce: null,
      failedRecipients: storedRecipients(row.failed_recipients),
    });
    if (await finish(deps, row.id, outcome, notes.split(" ").filter(Boolean))) out.processed += 1;
    else out.pending += 1;
  }
  return out;
}
