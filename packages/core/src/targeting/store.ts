// GTM-agents: the targeting_drafts table (migration 0035): drafts of the product description and
// the ICP, and the operator's saved edits. Nothing here is ever served; see docs/TARGETING.md.
//
// Status runs running -> ready | failed, and any row may end discarded. Every move out of running is
// a compare-and-set, so a late finish never overwrites a discard. A running row older than
// DRAFT_STUCK_MS reads as failed. Page text is never stored, only each page's URL, title, size and
// hash. Every function throws on a database error.
import type { BrainItemInput } from "../learning/brain-edit.ts";
import type { DraftItem, DroppedItem, TargetingComponent } from "./draft.ts";

/** A draft still running after this long has failed: the work that ran it ended. */
export const DRAFT_STUCK_MS = 5 * 60 * 1000;

export type DraftStatus = "running" | "ready" | "failed" | "discarded";
export type DraftSource = "url" | "text" | "manual";

export interface DraftPage {
  url: string;
  title: string;
  bytes: number;
  sha256: string;
}

export interface WorkingCopy {
  product?: BrainItemInput[];
  icp?: BrainItemInput[];
}

export interface TargetingDraft {
  id: string;
  status: DraftStatus;
  source: DraftSource;
  url: string | null;
  reason: string | null;
  pages: DraftPage[];
  skipped: Array<{ url: string; reason: string }>;
  draft: { product: DraftItem[]; icp: DraftItem[] } | null;
  dropped: DroppedItem[];
  working: WorkingCopy | null;
  requestedBy: string | null;
  model: string | null;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
}

interface Row {
  id: string;
  status: DraftStatus;
  source: DraftSource;
  url: string | null;
  reason: string | null;
  pages: string;
  draft: string | null;
  dropped: string;
  working: string | null;
  requested_by: string | null;
  model: string | null;
  started_at: string;
  finished_at: string | null;
  updated_at: string;
}

const COLUMNS = "id, status, source, url, reason, pages, draft, dropped, working, requested_by, model, started_at, finished_at, updated_at";

function json<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function fromRow(r: Row, now: Date): TargetingDraft {
  const pagesField = json<{ pages?: DraftPage[]; skipped?: Array<{ url: string; reason: string }> } | DraftPage[]>(r.pages, []);
  const pages = Array.isArray(pagesField) ? pagesField : (pagesField.pages ?? []);
  const skipped = Array.isArray(pagesField) ? [] : (pagesField.skipped ?? []);
  const stuck = r.status === "running" && now.getTime() - Date.parse(r.started_at) > DRAFT_STUCK_MS;
  return {
    id: r.id,
    status: stuck ? "failed" : r.status,
    source: r.source,
    url: r.url,
    reason: stuck ? "the draft did not finish within five minutes; start it again" : r.reason,
    pages,
    skipped,
    draft: json(r.draft, null),
    dropped: json(r.dropped, []),
    working: json(r.working, null),
    requestedBy: r.requested_by,
    model: r.model,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    updatedAt: r.updated_at,
  };
}

export function newDraftId(): string {
  return `td_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** The newest row that is not discarded, or null. */
export async function latestDraft(db: D1Database, now: Date): Promise<TargetingDraft | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM targeting_drafts WHERE status <> 'discarded' ORDER BY started_at DESC, id DESC LIMIT 1`).first<Row>();
  return row ? fromRow(row, now) : null;
}

export async function loadDraft(db: D1Database, id: string, now: Date): Promise<TargetingDraft | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM targeting_drafts WHERE id = ?1`).bind(id).first<Row>();
  return row ? fromRow(row, now) : null;
}

/** AI drafts started on the UTC day of `now` (manual working copies do not count). */
export async function draftsStartedOn(db: D1Database, now: Date): Promise<number> {
  const day = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const row = await db.prepare("SELECT COUNT(*) AS n FROM targeting_drafts WHERE source IN ('url', 'text') AND started_at >= ?1").bind(day).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** True when a draft is running and not yet stuck. */
export async function draftRunning(db: D1Database, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - DRAFT_STUCK_MS).toISOString();
  const row = await db.prepare("SELECT COUNT(*) AS n FROM targeting_drafts WHERE status = 'running' AND started_at > ?1").bind(since).first<{ n: number }>();
  return Number(row?.n ?? 0) > 0;
}

export async function insertDraft(db: D1Database, row: { id: string; status: "running" | "ready"; source: DraftSource; url: string | null; requestedBy: string; working?: WorkingCopy }, now: Date): Promise<void> {
  const at = now.toISOString();
  await db
    .prepare(
      `INSERT INTO targeting_drafts (id, status, source, url, working, requested_by, started_at, finished_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?7, ?7)`,
    )
    .bind(row.id, row.status, row.source, row.url, row.working ? JSON.stringify(row.working) : null, row.requestedBy.slice(0, 120), at, row.status === "ready" ? at : null)
    .run();
}

/** Finish a running draft as ready. False when it is no longer running (discarded meanwhile). */
export async function completeDraft(
  db: D1Database,
  id: string,
  done: { pages: DraftPage[]; skipped: Array<{ url: string; reason: string }>; draft: { product: DraftItem[]; icp: DraftItem[] }; dropped: DroppedItem[]; working: WorkingCopy; model: string },
  now: Date,
): Promise<boolean> {
  const at = now.toISOString();
  const r = await db
    .prepare(
      `UPDATE targeting_drafts SET status = 'ready', pages = ?2, draft = ?3, dropped = ?4, working = ?5, model = ?6, finished_at = ?7, updated_at = ?7
        WHERE id = ?1 AND status = 'running'`,
    )
    .bind(id, JSON.stringify({ pages: done.pages, skipped: done.skipped }), JSON.stringify(done.draft), JSON.stringify(done.dropped), JSON.stringify(done.working), done.model, at)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** Finish a running draft as failed, with a plain reason. */
export async function failDraft(db: D1Database, id: string, failure: { reason: string; pages?: DraftPage[]; dropped?: DroppedItem[]; model?: string | null }, now: Date): Promise<boolean> {
  const at = now.toISOString();
  const r = await db
    .prepare(
      `UPDATE targeting_drafts SET status = 'failed', reason = ?2, pages = ?3, dropped = ?4, model = ?5, finished_at = ?6, updated_at = ?6
        WHERE id = ?1 AND status = 'running'`,
    )
    .bind(id, failure.reason.slice(0, 300), JSON.stringify({ pages: failure.pages ?? [], skipped: [] }), JSON.stringify(failure.dropped ?? []), failure.model ?? null, at)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** Save the operator's edits of one component on a ready row. False when the row is not ready. */
export async function saveWorking(db: D1Database, id: string, component: TargetingComponent, items: readonly BrainItemInput[], now: Date): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE targeting_drafts SET working = json_set(COALESCE(working, '{}'), ?2, json(?3)), updated_at = ?4 WHERE id = ?1 AND status = 'ready'`)
    .bind(id, `$.${component}`, JSON.stringify(items), now.toISOString())
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** Drop a row (a draft, or saved edits). False when it was already discarded. */
export async function discardDraft(db: D1Database, id: string, now: Date): Promise<boolean> {
  const r = await db.prepare("UPDATE targeting_drafts SET status = 'discarded', updated_at = ?2 WHERE id = ?1 AND status <> 'discarded'").bind(id, now.toISOString()).run();
  return (r.meta.changes ?? 0) > 0;
}
