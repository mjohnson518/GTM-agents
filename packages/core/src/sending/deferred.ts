// GTM-agents: the deferred send queue and its replay.
//
// A send that must wait (outside the recipient's window, over a cap, the kill switch, the circuit
// breaker, a provider that refused for now) is written to deferred_sends by the send function, one
// queued row per (contact, campaign, subject, path, step), with the rest of the item in deferred_send_items.
// The replay job:
//   1. picks queued rows that are due, oldest first, up to its row ceiling;
//   2. claims each atomically: a compare-and-set on the attempt count that also pushes the row's
//      next attempt out by a lease, so two overlapping runs never take the same row;
//   3. re-checks the contact before sending: a contact that is gone, opted out, no longer cold (for
//      cold mail), or has replied (any reply recorded on the send ledger, an inbound email since the
//      row was queued, or a campaign status of replied, converted, bounced or opted out) is
//      cancelled instead;
//   4. sends the rest through the same boundary as every other send, so every check runs again,
//      and the idempotency key claimed at send time means a row is never sent twice;
//   5. records the outcome: sent; cancelled (blocked for good, or already sent); or back in the
//      queue with backoff, 1h * 2^(attempts - 1), or later if a check says so. After the fifth
//      attempt a row fails, and the operator is paged once for the run.
import type { OperatorChannel } from "../ports/operator.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import type { KvStore } from "../shared/kv.ts";
import { createDeliveryBoundary, type OutreachSenderDeps } from "./boundary.ts";
import { SEND_PATHS, type SendPath } from "./gates.ts";
import { runWrites } from "./ledger.ts";
import { pageOnce } from "./pages.ts";
import type { OutreachItem, OutreachOutcome } from "./types.ts";

export const DEFERRED_MAX_ATTEMPTS = 5;
/** How long a claimed row is kept from other runs while it is being replayed. */
export const DEFERRED_LEASE_MS = 15 * 60_000;
const HOUR_MS = 3_600_000;
const IN_CHUNK = 90;

/** The wait after the n-th attempt (n from 1): 1h, 2h, 4h, 8h. */
export function deferredBackoffMs(attempts: number): number {
  return HOUR_MS * 2 ** Math.max(0, Math.min(attempts, 10) - 1);
}

interface QueuedRow {
  id: string;
  contact_id: string | null;
  campaign_id: string | null;
  draft_id: string | null;
  experiment_id: string | null;
  experiment_arm: string | null;
  send_path: SendPath;
  recipient_email: string;
  subject: string;
  body: string;
  attempt_count: number;
  idempotency_key: string | null;
  item: string | null;
  created_at: string;
}

export interface ReplayResult {
  due: number;
  claimed: number;
  sent: number;
  requeued: number;
  cancelled: number;
  failed: number;
}

export interface ReplayDeps extends OutreachSenderDeps {
  maxRows: number;
  operator?: OperatorChannel;
  kv: KvStore | undefined | null;
}

function parseItemJson(raw: string | null): Partial<OutreachItem> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** Rebuild the exact item a row was queued with. */
export function itemFromRow(row: QueuedRow): OutreachItem {
  const extra = parseItemJson(row.item);
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const references = Array.isArray(extra.references) ? extra.references.filter((r): r is string => typeof r === "string") : undefined;
  const item: OutreachItem = {
    idempotencyKey: row.idempotency_key ?? str(extra.idempotencyKey) ?? `deferred:${row.id}`,
    path: (SEND_PATHS as readonly string[]).includes(row.send_path) ? row.send_path : "cold",
    contactId: row.contact_id ?? "",
    to: row.recipient_email,
    subject: row.subject,
    body: row.body,
  };
  const optional: Partial<OutreachItem> = {
    toName: str(extra.toName),
    draftId: row.draft_id ?? undefined,
    campaignId: row.campaign_id ?? undefined,
    templateId: str(extra.templateId),
    experimentId: row.experiment_id ?? undefined,
    experimentArm: row.experiment_arm ?? undefined,
    sequenceStep: typeof extra.sequenceStep === "number" && Number.isInteger(extra.sequenceStep) ? extra.sequenceStep : undefined,
    inReplyTo: str(extra.inReplyTo),
    references,
    approvedDigest: str(extra.approvedDigest),
    templateSha256: str(extra.templateSha256),
    cohort: str(extra.cohort),
  };
  for (const [k, v] of Object.entries(optional)) if (v !== undefined) (item as unknown as Record<string, unknown>)[k] = v;
  return item;
}

const placeholders = (n: number, start = 1) => Array.from({ length: n }, (_, i) => `?${start + i}`).join(", ");

function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) out.push(values.slice(i, i + IN_CHUNK));
  return out;
}

const REPLIED_WARMTH = new Set(["warming", "engaged", "hot", "customer", "churned"]);
const STOPPED_CAMPAIGN = new Set(["replied", "converted", "bounced", "opted_out"]);

/** Why a row should be cancelled rather than sent, or null to send it. Throws on a database error. */
async function cancellations(db: D1Database, rows: readonly QueuedRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.contact_id).filter((id): id is string => typeof id === "string" && id.length > 0))];
  const warmth = new Map<string, string>();
  const replied = new Set<string>();
  const lastInbound = new Map<string, string>();
  const campaignStatus = new Map<string, string>();
  for (const chunk of chunks(ids)) {
    const p = placeholders(chunk.length);
    const contacts = await db.prepare(`SELECT id, warmth FROM contacts WHERE id IN (${p})`).bind(...chunk).all<{ id: string; warmth: string }>();
    for (const row of contacts.results) warmth.set(row.id, row.warmth);
    const sends = await db.prepare(`SELECT DISTINCT contact_id FROM outreach_sends WHERE replied_at IS NOT NULL AND contact_id IN (${p})`).bind(...chunk).all<{ contact_id: string }>();
    for (const row of sends.results) replied.add(row.contact_id);
    const inbound = await db.prepare(`SELECT contact_id, MAX(received_at) AS at FROM inbound_emails WHERE contact_id IN (${p}) GROUP BY contact_id`).bind(...chunk).all<{ contact_id: string; at: string }>();
    for (const row of inbound.results) lastInbound.set(row.contact_id, row.at);
    const campaigns = await db.prepare(`SELECT campaign_id, contact_id, status FROM campaign_contacts WHERE contact_id IN (${p})`).bind(...chunk).all<{ campaign_id: string; contact_id: string; status: string }>();
    for (const row of campaigns.results) campaignStatus.set(`${row.campaign_id}:${row.contact_id}`, row.status);
  }
  const reasons = new Map<string, string>();
  for (const row of rows) {
    const id = row.contact_id ?? "";
    const w = warmth.get(id);
    if (!w) reasons.set(row.id, "the contact no longer exists");
    else if (w === "opted_out") reasons.set(row.id, "the contact opted out");
    else if (row.send_path === "cold" && w !== "cold") reasons.set(row.id, `the contact was contacted since it was queued (warmth ${w})`);
    else if ((row.send_path === "cold" || row.send_path === "sequence") && (REPLIED_WARMTH.has(w) || replied.has(id) || (lastInbound.get(id) ?? "") > row.created_at)) {
      reasons.set(row.id, "the contact replied since it was queued");
    } else if (row.send_path === "sequence" && row.campaign_id && STOPPED_CAMPAIGN.has(campaignStatus.get(`${row.campaign_id}:${id}`) ?? "")) {
      reasons.set(row.id, `the campaign stopped for this contact (${campaignStatus.get(`${row.campaign_id}:${id}`)})`);
    }
  }
  return reasons;
}

/** Replay due deferred sends. Throws only when the queue itself cannot be read or claimed. */
export async function replayDeferred(deps: ReplayDeps): Promise<ReplayResult> {
  const now = (deps.now ?? (() => new Date()))();
  const db = deps.db;
  const result: ReplayResult = { due: 0, claimed: 0, sent: 0, requeued: 0, cancelled: 0, failed: 0 };
  const limit = Math.max(0, Math.min(Math.floor(deps.maxRows), 1000));
  if (limit === 0) return result;

  const { results: due } = await db
    .prepare(
      `SELECT d.id, d.contact_id, d.campaign_id, d.draft_id, d.experiment_id, d.experiment_arm, d.send_path, d.recipient_email, d.subject, d.body,
              d.attempt_count, i.idempotency_key, i.item, d.created_at
         FROM deferred_sends d LEFT JOIN deferred_send_items i ON i.deferred_id = d.id
        WHERE d.status = 'queued' AND d.next_attempt_at <= ?1 ORDER BY d.next_attempt_at LIMIT ?2`,
    )
    .bind(now.toISOString(), limit)
    .all<QueuedRow>();
  result.due = due.length;
  if (due.length === 0) return result;

  const lease = new Date(now.getTime() + DEFERRED_LEASE_MS).toISOString();
  const claim = db.prepare(
    "UPDATE deferred_sends SET attempt_count = attempt_count + 1, next_attempt_at = ?2 WHERE id = ?1 AND status = 'queued' AND attempt_count = ?3 AND next_attempt_at <= ?4",
  );
  const claims = await db.batch(due.map((row) => claim.bind(row.id, lease, row.attempt_count, now.toISOString())));
  const claimed = due.filter((_, i) => (claims[i]?.meta.changes ?? 0) > 0).map((row) => ({ ...row, attempt_count: row.attempt_count + 1 }));
  result.claimed = claimed.length;
  if (claimed.length === 0) return result;

  const cancel = await cancellations(db, claimed);
  const toSend = claimed.filter((row) => !cancel.has(row.id));
  const outcomes = toSend.length > 0 ? await createDeliveryBoundary(deps).run(toSend.map(itemFromRow), { persistDeferrals: false }) : [];

  const at = now.toISOString();
  const statements: D1PreparedStatement[] = [];
  const newlyFailed: string[] = [];
  const cancelRow = (row: QueuedRow, why: string) => {
    result.cancelled += 1;
    statements.push(db.prepare("UPDATE deferred_sends SET status = 'cancelled', last_error = ?2 WHERE id = ?1").bind(row.id, why.slice(0, 500)));
  };
  const retryOrFail = (row: QueuedRow, why: string, notBefore: number, reason?: string) => {
    if (row.attempt_count >= DEFERRED_MAX_ATTEMPTS) {
      result.failed += 1;
      newlyFailed.push(why);
      statements.push(db.prepare("UPDATE deferred_sends SET status = 'failed', last_error = ?2 WHERE id = ?1").bind(row.id, `after ${row.attempt_count} attempts: ${why}`.slice(0, 500)));
      return;
    }
    result.requeued += 1;
    const next = new Date(Math.max(notBefore, now.getTime() + deferredBackoffMs(row.attempt_count))).toISOString();
    statements.push(
      db.prepare("UPDATE deferred_sends SET next_attempt_at = ?2, defer_reason = COALESCE(?3, defer_reason), last_error = ?4 WHERE id = ?1").bind(row.id, next, reason ?? null, why.slice(0, 500)),
    );
  };

  for (const row of claimed) {
    const why = cancel.get(row.id);
    if (why) cancelRow(row, `cancelled at replay: ${why}`);
  }
  toSend.forEach((row, i) => {
    const o = outcomes[i] as OutreachOutcome;
    switch (o.status) {
      case "sent":
        result.sent += 1;
        statements.push(db.prepare("UPDATE deferred_sends SET status = 'sent', sent_at = ?2, provider_message_id = ?3, last_error = NULL WHERE id = ?1").bind(row.id, at, o.providerMessageId));
        break;
      case "duplicate":
        cancelRow(row, "already sent under the same idempotency key");
        break;
      case "blocked":
        cancelRow(row, o.message);
        break;
      case "deferred":
        retryOrFail(row, `deferred again: ${o.reason}`, Date.parse(o.nextAttemptAt), o.reason);
        break;
      case "failed":
        if (o.retryable) retryOrFail(row, o.message, 0);
        else {
          result.failed += 1;
          newlyFailed.push(o.message);
          statements.push(db.prepare("UPDATE deferred_sends SET status = 'failed', last_error = ?2 WHERE id = ?1").bind(row.id, o.message.slice(0, 500)));
        }
        break;
    }
  });

  const written = await runWrites(db, statements);
  const unwritten = written.filter((ok) => !ok).length;
  if (unwritten > 0) deps.log?.warn("some deferred rows could not be updated after replay; their lease expires and the next run sees them again", { unwritten });

  if (newlyFailed.length > 0) {
    await pageOnce({
      db,
      kv: deps.kv,
      operator: deps.operator,
      eventId: `delivery:deferred:${at.slice(0, 13)}`,
      effect: "failed_page",
      text: `Deferred sends failed: ${newlyFailed.length} message(s) were given up on in this replay run. First reason: ${sanitizeErrorMessage(newlyFailed[0] ?? "")}`,
    });
  }
  return result;
}
