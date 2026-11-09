// GTM-agents: the activity view: the audit trail (audit_log), a page at a time, as a CSV export, and
// as a live stream to dashboards that subscribe. Audit details hold ids, counts and enum values.
import { RpcError, decodeCursor, encodeCursor, type Handler } from "./context.ts";
import type { ActivityItem } from "./protocol.ts";

export const ACTIVITY_PAGE = 50;
export const EXPORT_MAX_ROWS = 5000;
/** The largest CSV one response carries; a longer export is cut at a row and says so. */
export const EXPORT_MAX_BYTES = 512 * 1024;
export const EXPORT_MAX_DAYS = 31;

export interface AuditRow {
  id: number;
  agent_id: string;
  action: string;
  details: string | null;
  created_at: string;
}

const REFS: Array<[string, string]> = [
  ["draftId", "draft"],
  ["dealId", "deal"],
  ["contactId", "contact"],
  ["inboundId", "inbound"],
  ["proposalId", "proposal"],
];

export function activityItem(row: AuditRow): ActivityItem {
  let details: Record<string, unknown> = {};
  try {
    const parsed: unknown = row.details ? JSON.parse(row.details) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) details = parsed as Record<string, unknown>;
  } catch {
    details = {};
  }
  const parts = Object.entries(details)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .slice(0, 8)
    .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`);
  const ref = REFS.find(([key]) => typeof details[key] === "string");
  return {
    id: String(row.id),
    at: row.created_at,
    kind: row.action,
    actor: row.agent_id,
    summary: [row.action, ...parts].join(" ").slice(0, 400),
    ...(ref ? { ref: { type: ref[1], id: String(details[ref[0]]) } } : {}),
  };
}

export const activityList: Handler<"activity.list"> = async (p, ctx) => {
  const limit = p.limit ?? ACTIVITY_PAGE;
  const before = decodeCursor(p.cursor);
  const { results } = await ctx.env.DB.prepare(
    "SELECT id, agent_id, action, details, created_at FROM audit_log WHERE (?1 IS NULL OR action = ?1) AND (?2 IS NULL OR id < CAST(?2 AS INTEGER)) ORDER BY id DESC LIMIT ?3",
  )
    .bind(p.kind ?? null, before, limit + 1)
    .all<AuditRow>();
  const items = results.slice(0, limit).map(activityItem);
  const last = results[limit - 1];
  return { items, ...(results.length > limit && last ? { cursor: encodeCursor(last.id) } : {}) };
};

export const activitySubscribe: Handler<"activity.subscribe"> = (p, ctx) => {
  ctx.state.subscribed = p.on;
  return Promise.resolve({ subscribed: p.on });
};

/** One CSV cell. A cell a spreadsheet would read as a formula is prefixed with a quote. */
export function csvCell(value: unknown): string {
  let text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : value === null || value === undefined ? "" : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const activityExport: Handler<"activity.export"> = async (p, ctx) => {
  const from = new Date(p.from);
  const to = new Date(p.to.length === 10 ? `${p.to}T23:59:59.999Z` : p.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) throw new RpcError("invalid", "from must be a date on or before to");
  if (to.getTime() - from.getTime() > EXPORT_MAX_DAYS * 86_400_000) throw new RpcError("invalid", `export at most ${EXPORT_MAX_DAYS} days at a time`);
  const { results } = await ctx.env.DB.prepare("SELECT id, agent_id, action, details, created_at FROM audit_log WHERE created_at >= ?1 AND created_at <= ?2 ORDER BY id LIMIT ?3")
    .bind(from.toISOString(), to.toISOString(), EXPORT_MAX_ROWS)
    .all<AuditRow>();
  let csv = "id,at,actor,action,details\n";
  for (const r of results) {
    const line = `${[r.id, r.created_at, r.agent_id, r.action, r.details ?? ""].map(csvCell).join(",")}\n`;
    if (csv.length + line.length > EXPORT_MAX_BYTES) {
      csv += `${csvCell(`truncated: export a shorter range after ${r.created_at}`)}\n`;
      break;
    }
    csv += line;
  }
  return { csv };
};

/** Audit rows after `afterId`, oldest first, for the live stream. */
export async function activitySince(db: D1Database, afterId: number, limit = 50): Promise<AuditRow[]> {
  const { results } = await db.prepare("SELECT id, agent_id, action, details, created_at FROM audit_log WHERE id > ?1 ORDER BY id LIMIT ?2").bind(afterId, limit).all<AuditRow>();
  return results;
}

export async function latestActivityId(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM audit_log").first<{ id: number }>();
  return Number(row?.id ?? 0);
}
