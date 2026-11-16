// GTM-agents: the targeting_suggestions table (migration 0036): suggested search queries and
// personas, and the operator's picks. Nothing here is ever served; see docs/TARGETING.md.
//
// Status runs running -> ready | failed, and any row may end discarded. Every move out of running is
// a compare-and-set, so a late finish never overwrites a discard. A running row older than
// SUGGEST_STUCK_MS reads as failed. Every function throws on a database error.
import type { BrainItemInput } from "../learning/brain-edit.ts";
import type { DroppedSuggestion, SuggestComponent, SuggestedItem } from "./suggest.ts";

/** A suggestion still running after this long has failed: the work that ran it ended. */
export const SUGGEST_STUCK_MS = 5 * 60 * 1000;

export type SuggestionStatus = "running" | "ready" | "failed" | "discarded";

/** Suggested items per component. */
export type SuggestionSet = Record<SuggestComponent, SuggestedItem[]>;

/** The operator's picks per component: the picked items, with any edits. */
export type SuggestionPicks = Partial<Record<SuggestComponent, BrainItemInput[]>>;

export interface TargetingSuggestion {
  id: string;
  status: SuggestionStatus;
  reason: string | null;
  suggestions: SuggestionSet | null;
  dropped: DroppedSuggestion[];
  working: SuggestionPicks | null;
  requestedBy: string | null;
  model: string | null;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
}

interface Row {
  id: string;
  status: SuggestionStatus;
  reason: string | null;
  suggestions: string | null;
  dropped: string;
  working: string | null;
  requested_by: string | null;
  model: string | null;
  started_at: string;
  finished_at: string | null;
  updated_at: string;
}

const COLUMNS = "id, status, reason, suggestions, dropped, working, requested_by, model, started_at, finished_at, updated_at";

function json<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function fromRow(r: Row, now: Date): TargetingSuggestion {
  const stuck = r.status === "running" && now.getTime() - Date.parse(r.started_at) > SUGGEST_STUCK_MS;
  return {
    id: r.id,
    status: stuck ? "failed" : r.status,
    reason: stuck ? "the suggestion did not finish within five minutes; start it again" : r.reason,
    suggestions: json(r.suggestions, null),
    dropped: json(r.dropped, []),
    working: json(r.working, null),
    requestedBy: r.requested_by,
    model: r.model,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    updatedAt: r.updated_at,
  };
}

export function newSuggestionId(): string {
  return `ts_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** The newest row that is not discarded, or null. */
export async function latestSuggestion(db: D1Database, now: Date): Promise<TargetingSuggestion | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM targeting_suggestions WHERE status <> 'discarded' ORDER BY started_at DESC, id DESC LIMIT 1`).first<Row>();
  return row ? fromRow(row, now) : null;
}

export async function loadSuggestion(db: D1Database, id: string, now: Date): Promise<TargetingSuggestion | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM targeting_suggestions WHERE id = ?1`).bind(id).first<Row>();
  return row ? fromRow(row, now) : null;
}

/** Suggestions started on the UTC day of `now`. */
export async function suggestionsStartedOn(db: D1Database, now: Date): Promise<number> {
  const day = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const row = await db.prepare("SELECT COUNT(*) AS n FROM targeting_suggestions WHERE started_at >= ?1").bind(day).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * Claim the one running slot: insert a running row unless one younger than SUGGEST_STUCK_MS exists,
 * in one statement. False when another suggestion is running.
 */
export async function claimSuggestion(db: D1Database, id: string, requestedBy: string, now: Date): Promise<boolean> {
  const at = now.toISOString();
  const r = await db
    .prepare(
      `INSERT INTO targeting_suggestions (id, status, requested_by, started_at, created_at, updated_at)
       SELECT ?1, 'running', ?2, ?3, ?3, ?3
        WHERE NOT EXISTS (SELECT 1 FROM targeting_suggestions WHERE status = 'running' AND started_at > ?4)`,
    )
    .bind(id, requestedBy.slice(0, 120), at, new Date(now.getTime() - SUGGEST_STUCK_MS).toISOString())
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/**
 * Finish a running suggestion as ready. False when it is no longer running (discarded meanwhile) or
 * has run longer than SUGGEST_STUCK_MS, so a row that already reads as failed stays failed.
 */
export async function completeSuggestion(db: D1Database, id: string, done: { suggestions: SuggestionSet; dropped: DroppedSuggestion[]; model: string }, now: Date): Promise<boolean> {
  const at = now.toISOString();
  const r = await db
    .prepare("UPDATE targeting_suggestions SET status = 'ready', suggestions = ?2, dropped = ?3, model = ?4, finished_at = ?5, updated_at = ?5 WHERE id = ?1 AND status = 'running' AND started_at > ?6")
    .bind(id, JSON.stringify(done.suggestions), JSON.stringify(done.dropped), done.model, at, new Date(now.getTime() - SUGGEST_STUCK_MS).toISOString())
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** Finish a running suggestion as failed, with a plain reason. */
export async function failSuggestion(db: D1Database, id: string, failure: { reason: string; dropped?: DroppedSuggestion[]; model?: string | null }, now: Date): Promise<boolean> {
  const at = now.toISOString();
  const r = await db
    .prepare("UPDATE targeting_suggestions SET status = 'failed', reason = ?2, dropped = ?3, model = ?4, finished_at = ?5, updated_at = ?5 WHERE id = ?1 AND status = 'running'")
    .bind(id, failure.reason.slice(0, 300), JSON.stringify(failure.dropped ?? []), failure.model ?? null, at)
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** Save the operator's picks for one component on a ready row. False when the row is not ready. */
export async function saveSuggestionWorking(db: D1Database, id: string, component: SuggestComponent, items: readonly BrainItemInput[], now: Date): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE targeting_suggestions SET working = json_set(COALESCE(working, '{}'), ?2, json(?3)), updated_at = ?4 WHERE id = ?1 AND status = 'ready'`)
    .bind(id, `$."${component}"`, JSON.stringify(items), now.toISOString())
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/** Drop a suggestion. False when it was already discarded. */
export async function discardSuggestion(db: D1Database, id: string, now: Date): Promise<boolean> {
  const r = await db.prepare("UPDATE targeting_suggestions SET status = 'discarded', updated_at = ?2 WHERE id = ?1 AND status <> 'discarded'").bind(id, now.toISOString()).run();
  return (r.meta.changes ?? 0) > 0;
}
