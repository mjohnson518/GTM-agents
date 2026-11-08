// GTM-agents: detection. Reading new mail from an InboxProvider and recording it through intake.
//
//   - pollInbox: lists from the stored cursor (the mailbox's history position), records what is
//     new, then stores the cursor the provider returned. The cursor moves only after every listed
//     message was recorded or skipped, so a database failure means the next poll lists the same
//     messages again (and dedup skips the ones already in). With no cursor, or an expired one, the
//     provider lists a recent window instead. A quiet mailbox costs one provider call, one cursor
//     read and no database query for mail; the cursor is rewritten when it moves with new mail, or
//     at most once an hour otherwise, so KV writes stay low.
//   - sweepInbox: a safety net under the poll. It lists the last few days without a cursor and
//     records only messages the database does not hold (the provider is told which ids are known
//     before it fetches anything). It leaves the poll's cursor alone. It also fetches again, from
//     providers that can, the bodies of recent rows whose body could not be stored.
// The cursor lives in KV: it is a cache of the mailbox position, rebuilt by the window fallback.
// Neither function calls a model.
import type { InboundMessage, InboxProvider } from "../ports/email.ts";
import { AdapterError } from "../ports/types.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import type { KvStore } from "../shared/kv.ts";
import { putInboundBody } from "./body.ts";
import { knownMessageIds, processPendingInbound, recordInbound, type InboxIntakeDeps, type IntakeResult } from "./intake.ts";

/** The KV key holding a provider's cursor. */
export const cursorKey = (provider: string): string => `inbox:cursor:${provider}`;
/** How long an unchanged cursor goes without being rewritten. */
export const CURSOR_REFRESH_MS = 60 * 60_000;
/** The window a poll lists when it has no usable cursor. */
export const BOOTSTRAP_WINDOW_MS = 24 * 60 * 60_000;
/** The window the sweep lists. */
export const SWEEP_WINDOW_MS = 3 * 24 * 60 * 60_000;

export interface StoredCursor {
  cursor: string;
  at: string;
}

/** The stored cursor, or null when there is none or it cannot be read (the poll then lists a window). */
export async function readCursor(kv: Pick<KvStore, "get"> | null | undefined, provider: string): Promise<StoredCursor | null> {
  if (!kv) return null;
  try {
    const raw = await kv.get(cursorKey(provider));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof (parsed as StoredCursor).cursor === "string" && typeof (parsed as StoredCursor).at === "string") return parsed as StoredCursor;
  } catch {
    // Unreadable or malformed: list a window instead.
  }
  return null;
}

async function writeCursor(kv: KvStore | null | undefined, provider: string, cursor: string, now: Date): Promise<boolean> {
  if (!kv) return false;
  try {
    await kv.put(cursorKey(provider), JSON.stringify({ cursor, at: now.toISOString() } satisfies StoredCursor));
    return true;
  } catch {
    return false;
  }
}

export interface PollDeps extends InboxIntakeDeps {
  inbox: InboxProvider;
  /** Messages listed per call. */
  limit: number;
  /** Calls per poll while the provider says more is waiting. */
  maxPages?: number;
  /** Pending rows retried per poll. */
  pendingLimit?: number;
}

export interface PollResult {
  pages: number;
  intake: IntakeResult;
  /** True when the provider's cursor was stored. */
  cursorStored: boolean;
  /** True when the listing fell back to the window because there was no usable cursor. */
  reset: boolean;
  /** True when listing is not something this provider does (an inbound-only adapter). */
  unsupported: boolean;
  pending: { attempted: number; processed: number; pending: number };
}

const emptyIntake = (): IntakeResult => ({ received: 0, recorded: 0, duplicates: 0, fromUs: 0, unparseable: 0, failed: 0, processed: 0, pending: 0, ids: [] });

function add(total: IntakeResult, part: IntakeResult): void {
  total.received += part.received;
  total.recorded += part.recorded;
  total.duplicates += part.duplicates;
  total.fromUs += part.fromUs;
  total.unparseable += part.unparseable;
  total.failed += part.failed;
  total.processed += part.processed;
  total.pending += part.pending;
  total.ids.push(...part.ids);
}

/** True when the provider refused because it does not list mail (an inbound-only adapter). */
export function isUnsupported(error: unknown): boolean {
  return error instanceof AdapterError && error.code === "invalid" && !error.retryable;
}

/**
 * One bounded poll: pending rows first, then up to maxPages listings from the cursor. Throws when
 * the provider fails (the job records the failure); a database failure during intake stops the
 * cursor from moving instead.
 */
export async function pollInbox(deps: PollDeps): Promise<PollResult> {
  const intake = emptyIntake();
  const pending = await processPendingInbound(deps, { limit: deps.pendingLimit ?? 10 });
  const result: PollResult = { pages: 0, intake, cursorStored: false, reset: false, unsupported: false, pending };
  const known = (ids: readonly string[]) => knownMessageIds(deps.db, deps.provider, ids);
  const stored = await readCursor(deps.kv, deps.provider);
  let cursor = stored?.cursor;
  const since = new Date(deps.now.getTime() - BOOTSTRAP_WINDOW_MS).toISOString();
  const maxPages = Math.max(1, Math.min(deps.maxPages ?? 2, 5));
  for (let page = 0; page < maxPages; page++) {
    let listed: Awaited<ReturnType<InboxProvider["listNew"]>>;
    try {
      listed = await deps.inbox.listNew({ ...(cursor ? { cursor } : {}), since, limit: deps.limit, known });
    } catch (error) {
      if (isUnsupported(error)) {
        result.unsupported = true;
        return result;
      }
      throw error;
    }
    result.pages += 1;
    if (listed.reset) result.reset = true;
    const part = await recordInbound(deps, Array.isArray(listed.items) ? listed.items : []);
    add(intake, part);
    // A row that could not be written must be listed again: keep the cursor where it was.
    if (part.failed > 0) break;
    if (typeof listed.cursor === "string" && listed.cursor.length > 0 && listed.cursor.length <= 512) cursor = listed.cursor;
    if (!listed.more) break;
  }
  // Store a moved cursor when it carried new mail, replaced a missing or expired one, or the stored
  // one is over an hour old. A cursor that moved only past mailbox changes that are not new mail
  // (labels, reads) can wait: listing from the older position again costs one call and no fetches.
  if (intake.failed === 0 && cursor && cursor !== stored?.cursor) {
    const stale = !stored || !(deps.now.getTime() - Date.parse(stored.at) < CURSOR_REFRESH_MS);
    if (intake.received > 0 || result.reset || stale) result.cursorStored = await writeCursor(deps.kv, deps.provider, cursor, deps.now);
  }
  return result;
}

export interface SweepDeps extends InboxIntakeDeps {
  inbox: InboxProvider;
  /** Messages fetched per sweep. */
  limit: number;
  /** Rows whose body is fetched again per sweep. */
  repairLimit?: number;
}

export interface SweepResult {
  intake: IntakeResult;
  unsupported: boolean;
  repaired: number;
}

/** The safety-net sweep over the last SWEEP_WINDOW_MS. Throws when the provider fails. */
export async function sweepInbox(deps: SweepDeps): Promise<SweepResult> {
  const since = new Date(deps.now.getTime() - SWEEP_WINDOW_MS).toISOString();
  let items: InboundMessage[];
  try {
    const listed = await deps.inbox.listNew({ since, limit: deps.limit, known: (ids) => knownMessageIds(deps.db, deps.provider, ids) });
    items = Array.isArray(listed.items) ? listed.items : [];
  } catch (error) {
    if (isUnsupported(error)) return { intake: emptyIntake(), unsupported: true, repaired: 0 };
    throw error;
  }
  const intake = await recordInbound(deps, items);
  const repaired = await repairBodies(deps, deps.repairLimit ?? 5);
  return { intake, unsupported: false, repaired };
}

/**
 * Fetch again the bodies intake could not store, for recent rows from this provider. A message the
 * provider no longer has is marked [body_unrecoverable] so it is not asked for again. Bookkeeping:
 * never throws.
 */
export async function repairBodies(deps: SweepDeps, limit: number): Promise<number> {
  if (!deps.bucket || limit <= 0) return 0;
  let repaired = 0;
  try {
    const { results } = await deps.db
      .prepare(
        `SELECT id, provider_message_id, provider_thread_id, notes FROM inbound_emails
          WHERE provider = ?1 AND body_key IS NULL AND provider_thread_id IS NOT NULL AND created_at >= ?2
            AND (notes IS NULL OR instr(notes, '[body_unrecoverable]') = 0)
          ORDER BY created_at DESC LIMIT ?3`,
      )
      .bind(deps.provider, new Date(deps.now.getTime() - SWEEP_WINDOW_MS).toISOString(), limit)
      .all<{ id: string; provider_message_id: string; provider_thread_id: string; notes: string | null }>();
    for (const row of results) {
      let message: InboundMessage | undefined;
      try {
        message = (await deps.inbox.getThread(row.provider_thread_id)).find((m) => m.providerMessageId === row.provider_message_id);
      } catch (error) {
        if (isUnsupported(error)) return repaired;
        if (!(error instanceof AdapterError && error.code === "not_found")) continue;
      }
      if (!message) {
        const notes = [row.notes, "[body_unrecoverable]"].filter(Boolean).join(" ");
        await deps.db.prepare("UPDATE inbound_emails SET notes = ?2, updated_at = ?3 WHERE id = ?1").bind(row.id, notes, deps.now.toISOString()).run();
        continue;
      }
      const key = await putInboundBody(deps.bucket, row.id, typeof message.text === "string" ? message.text : "");
      const notes = (row.notes ?? "").replace("[body_not_stored]", "").replace(/\s+/g, " ").trim() || null;
      await deps.db.prepare("UPDATE inbound_emails SET body_key = ?2, notes = ?3, updated_at = ?4 WHERE id = ?1 AND body_key IS NULL").bind(row.id, key, notes, deps.now.toISOString()).run();
      repaired += 1;
    }
  } catch (error) {
    deps.log?.warn("inbound bodies could not be repaired", { error: sanitizeErrorMessage(error) });
  }
  return repaired;
}
