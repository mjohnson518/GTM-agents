// GTM-agents: the dashboard's pipeline and contact methods.
//
// Deals move only through transitionDeal (data/deals.ts): forward, or to closed_lost, with a
// compare-and-set and a stage history row. Every id in a request is re-resolved from the database
// before anything is written. Contact edits touch only the names, the job title and the notes;
// the address, warmth and status fields have their own paths and are never edited here.
import { DEAL_STAGES, WARMTH_STATES } from "../data/enums.ts";
import { transitionDeal } from "../data/deals.ts";
import { RpcError, decodeCursor, encodeCursor, type Handler } from "./context.ts";
import type { ActivityItem } from "./protocol.ts";

const PAGE = 50;
const toValue = (cents: number | null): number | null => (cents === null || cents === undefined ? null : Math.round(Number(cents)) / 100);
const toCents = (value: number): number => Math.round(value * 100);

export const pipelineSummary: Handler<"pipeline.summary"> = async (_p, ctx) => {
  const { results } = await ctx.env.DB.prepare("SELECT stage, COUNT(*) AS n, COALESCE(SUM(value_cents), 0) AS cents, COALESCE(SUM(value_cents * probability), 0) AS weighted FROM deals GROUP BY stage").all<{
    stage: string;
    n: number;
    cents: number;
    weighted: number;
  }>();
  const byStage: Record<string, { count: number; value: number }> = Object.fromEntries(DEAL_STAGES.map((s) => [s, { count: 0, value: 0 }]));
  let weighted = 0;
  let won = 0;
  let lost = 0;
  for (const r of results) {
    byStage[r.stage] = { count: Number(r.n), value: toValue(Number(r.cents)) ?? 0 };
    if (r.stage !== "closed_won" && r.stage !== "closed_lost") weighted += Number(r.weighted) || 0;
    if (r.stage === "closed_won") won = Number(r.n);
    if (r.stage === "closed_lost") lost = Number(r.n);
  }
  return { byStage, weightedForecast: toValue(weighted) ?? 0, winRate: won + lost > 0 ? won / (won + lost) : null };
};

interface DealRow {
  id: string;
  contact_id: string | null;
  account_key: string | null;
  stage: string;
  value_cents: number | null;
  updated_at: string;
}

export const pipelineDeals: Handler<"pipeline.deals"> = async (p, ctx) => {
  const after = decodeCursor(p.cursor);
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, contact_id, account_key, stage, value_cents, updated_at FROM deals
      WHERE (?1 IS NULL OR stage = ?1) AND (?2 IS NULL OR updated_at || '|' || id < ?2)
      ORDER BY updated_at DESC, id DESC LIMIT ?3`,
  )
    .bind(p.stage ?? null, after, PAGE + 1)
    .all<DealRow>();
  const items = results.slice(0, PAGE).map((d) => ({ id: d.id, contactId: d.contact_id, accountKey: d.account_key, stage: d.stage, value: toValue(d.value_cents), updatedAt: d.updated_at }));
  const last = results[PAGE - 1];
  return { items, ...(results.length > PAGE && last ? { cursor: encodeCursor(`${last.updated_at}|${last.id}`) } : {}) };
};

export const pipelineCreate: Handler<"pipeline.create"> = async (p, ctx) => {
  const contact = await ctx.env.DB.prepare("SELECT id, account_key, first_name, last_name, warmth FROM contacts WHERE id = ?1").bind(p.contactId).first<{
    id: string;
    account_key: string | null;
    first_name: string | null;
    last_name: string | null;
    warmth: string;
  }>();
  if (!contact) throw new RpcError("not_found", "no such contact");
  if (contact.warmth === "opted_out") throw new RpcError("conflict", "that contact opted out");
  const id = crypto.randomUUID();
  const at = ctx.now().toISOString();
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.account_key || "New deal";
  await ctx.env.DB.prepare(
    `INSERT INTO deals (id, account_key, contact_id, name, stage, value_cents, source, notes, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'prospecting', ?5, 'dashboard', ?6, ?7, ?7)`,
  )
    .bind(id, contact.account_key, contact.id, name.slice(0, 200), p.value === undefined ? null : toCents(p.value), p.notes ?? null, at)
    .run();
  ctx.audit.dealId = id;
  ctx.audit.contactId = contact.id;
  return { id };
};

export const pipelineUpdate: Handler<"pipeline.update"> = async (p, ctx) => {
  if (p.value === undefined && p.notes === undefined) throw new RpcError("invalid", "nothing to update");
  const result = await ctx.env.DB.prepare(
    "UPDATE deals SET value_cents = CASE WHEN ?2 THEN ?3 ELSE value_cents END, notes = CASE WHEN ?4 THEN ?5 ELSE notes END, updated_at = ?6 WHERE id = ?1",
  )
    .bind(p.dealId, p.value !== undefined ? 1 : 0, p.value === undefined ? null : toCents(p.value), p.notes !== undefined ? 1 : 0, p.notes ?? null, ctx.now().toISOString())
    .run();
  if ((result.meta.changes ?? 0) === 0) throw new RpcError("not_found", "no such deal");
  ctx.audit.dealId = p.dealId;
  return { ok: true };
};

export const pipelineTransition: Handler<"pipeline.transition"> = async (p, ctx) => {
  const result = await transitionDeal(ctx.env.DB, p.dealId, p.to, { ...(p.reason ? { reason: p.reason } : {}), actor: ctx.actor, now: ctx.now() });
  ctx.audit.dealId = p.dealId;
  ctx.audit.to = p.to;
  if (!result.changed) {
    if (result.reason === "not_found") throw new RpcError("not_found", "no such deal");
    if (result.reason === "not_allowed") throw new RpcError("conflict", `a deal at ${result.current ?? "its stage"} cannot move to ${p.to}`);
    throw new RpcError("conflict", "the deal changed stage at the same time; reload and try again");
  }
  ctx.audit.from = result.from;
  return { ok: true, stage: result.to };
};

interface ContactRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  account_key: string | null;
  warmth: string;
  last_contacted_at: string | null;
}

const fullName = (r: Pick<ContactRow, "first_name" | "last_name">): string | null => [r.first_name, r.last_name].filter(Boolean).join(" ") || null;
const likeEscape = (q: string): string => q.replace(/[\\%_]/g, (c) => `\\${c}`);

export const contactsQuery: Handler<"contacts.query"> = async (p, ctx) => {
  const limit = p.limit ?? PAGE;
  const after = decodeCursor(p.cursor);
  const q = p.q?.trim() ? `%${likeEscape(p.q.trim().toLowerCase())}%` : null;
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, first_name, last_name, email, account_key, warmth, last_contacted_at FROM contacts
      WHERE (?1 IS NULL OR warmth = ?1)
        AND (?2 IS NULL OR email LIKE ?2 ESCAPE '\\' OR lower(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) LIKE ?2 ESCAPE '\\' OR account_key LIKE ?2 ESCAPE '\\')
        AND (?3 IS NULL OR id > ?3)
      ORDER BY id LIMIT ?4`,
  )
    .bind(p.warmth ?? null, q, after, limit + 1)
    .all<ContactRow>();
  const items = results.slice(0, limit).map((r) => ({ id: r.id, name: fullName(r), email: r.email, accountKey: r.account_key, warmth: r.warmth, lastContactedAt: r.last_contacted_at }));
  const last = results[limit - 1];
  return { items, ...(results.length > limit && last ? { cursor: encodeCursor(last.id) } : {}) };
};

export const contactsGet: Handler<"contacts.get"> = async (p, ctx) => {
  const row = await ctx.env.DB.prepare(
    `SELECT id, first_name, last_name, email, account_key, job_title, department, location, timezone, source, warmth, last_contacted_at, total_touches,
            email_confidence, verification_status, verified_at, employment_status, notes, created_at, updated_at
       FROM contacts WHERE id = ?1`,
  )
    .bind(p.id)
    .first<Record<string, unknown>>();
  if (!row) throw new RpcError("not_found", "no such contact");
  const deals = await ctx.env.DB.prepare("SELECT id, stage, value_cents, updated_at FROM deals WHERE contact_id = ?1 ORDER BY updated_at DESC LIMIT 10").bind(p.id).all<{ id: string; stage: string; value_cents: number | null; updated_at: string }>();
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    accountKey: row.account_key,
    jobTitle: row.job_title,
    department: row.department,
    location: row.location,
    timezone: row.timezone,
    source: row.source,
    warmth: row.warmth,
    lastContactedAt: row.last_contacted_at,
    totalTouches: row.total_touches,
    emailConfidence: row.email_confidence,
    verificationStatus: row.verification_status,
    verifiedAt: row.verified_at,
    employmentStatus: row.employment_status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deals: deals.results.map((d) => ({ id: d.id, stage: d.stage, value: toValue(d.value_cents), updatedAt: d.updated_at })),
  };
};

export const contactsUpdate: Handler<"contacts.update"> = async (p, ctx) => {
  const sets: string[] = [];
  const values: Array<string | null> = [];
  const field = (column: string, value: string | undefined) => {
    if (value === undefined) return;
    values.push(value.trim() === "" ? null : value.trim());
    sets.push(`${column} = ?${values.length + 1}`);
  };
  field("first_name", p.patch.firstName);
  field("last_name", p.patch.lastName);
  field("job_title", p.patch.jobTitle);
  field("notes", p.patch.notes);
  if (sets.length === 0) throw new RpcError("invalid", "nothing to update");
  values.push(ctx.now().toISOString());
  sets.push(`updated_at = ?${values.length + 1}`);
  const result = await ctx.env.DB.prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ?1`).bind(p.id, ...values).run();
  if ((result.meta.changes ?? 0) === 0) throw new RpcError("not_found", "no such contact");
  ctx.audit.contactId = p.id;
  ctx.audit.fields = Object.keys(p.patch).sort().join(",");
  return { ok: true };
};

export const contactsStats: Handler<"contacts.stats"> = async (_p, ctx) => {
  const { results } = await ctx.env.DB.prepare("SELECT warmth, COUNT(*) AS n FROM contacts GROUP BY warmth").all<{ warmth: string; n: number }>();
  const stats: Record<string, number> = Object.fromEntries(WARMTH_STATES.map((w) => [w, 0]));
  let total = 0;
  for (const r of results) {
    stats[r.warmth] = Number(r.n);
    total += Number(r.n);
  }
  return { total, ...stats };
};

/** Who to look at next: people waiting on a reply first, then warm contacts gone quiet for a week. */
export const contactsNext: Handler<"contacts.next"> = async (_p, ctx) => {
  const now = ctx.now();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const [owed, quiet] = await Promise.all([
    ctx.env.DB.prepare(
      `SELECT contact_id AS id, MIN(received_at) AS at FROM inbound_emails WHERE contact_id IS NOT NULL AND status IN ('new', 'notified', 'draft_created') AND received_at >= ?1
        GROUP BY contact_id ORDER BY at LIMIT 10`,
    )
      .bind(monthAgo)
      .all<{ id: string }>(),
    ctx.env.DB.prepare("SELECT id, warmth FROM contacts WHERE warmth IN ('hot', 'engaged', 'warming') AND (last_contacted_at IS NULL OR last_contacted_at < ?1) ORDER BY last_contacted_at LIMIT 10")
      .bind(weekAgo)
      .all<{ id: string; warmth: string }>(),
  ]);
  const seen = new Set<string>();
  const out: Array<{ id: string; reason: string }> = [];
  const add = (contactId: string, reason: string) => {
    if (seen.has(contactId)) return;
    seen.add(contactId);
    out.push({ id: contactId, reason });
  };
  for (const r of owed.results) add(r.id, "waiting on a reply");
  for (const r of quiet.results) add(r.id, `${r.warmth}, no touch in a week`);
  return out.slice(0, 15);
};

export const contactsLog: Handler<"contacts.log"> = async (p, ctx) => {
  const after = decodeCursor(p.cursor);
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, channel, direction, subject, summary, outcome, agent_id, created_at FROM outreach_log
      WHERE contact_id = ?1 AND (?2 IS NULL OR created_at || '|' || id < ?2) ORDER BY created_at DESC, id DESC LIMIT ?3`,
  )
    .bind(p.id, after, PAGE + 1)
    .all<{ id: string; channel: string; direction: string; subject: string | null; summary: string | null; outcome: string | null; agent_id: string | null; created_at: string }>();
  const items: ActivityItem[] = results.slice(0, PAGE).map((r) => ({
    id: r.id,
    at: r.created_at,
    kind: `${r.direction}.${r.channel}`,
    actor: r.agent_id ?? (r.direction === "inbound" ? "contact" : "agent"),
    // Subjects and summaries can come from outside: they are plain strings, rendered as text.
    summary: [r.subject, r.summary, r.outcome ? `(${r.outcome})` : null].filter(Boolean).join(" ").slice(0, 500),
    ref: { type: "contact", id: p.id },
  }));
  const last = results[PAGE - 1];
  return { items, ...(results.length > PAGE && last ? { cursor: encodeCursor(`${last.created_at}|${last.id}`) } : {}) };
};

/** A plain summary from what the database holds. No model call. */
export const contactsSummary: Handler<"contacts.summary"> = async (p, ctx) => {
  const contact = await ctx.env.DB.prepare("SELECT id, first_name, last_name, account_key, job_title, warmth, last_contacted_at, total_touches FROM contacts WHERE id = ?1").bind(p.id).first<{
    id: string;
    first_name: string | null;
    last_name: string | null;
    account_key: string | null;
    job_title: string | null;
    warmth: string;
    last_contacted_at: string | null;
    total_touches: number;
  }>();
  if (!contact) throw new RpcError("not_found", "no such contact");
  const [deal, inbound] = await Promise.all([
    ctx.env.DB.prepare("SELECT stage FROM deals WHERE contact_id = ?1 ORDER BY updated_at DESC LIMIT 1").bind(p.id).first<{ stage: string }>(),
    ctx.env.DB.prepare("SELECT intent, received_at, status FROM inbound_emails WHERE contact_id = ?1 ORDER BY received_at DESC LIMIT 1").bind(p.id).first<{ intent: string | null; received_at: string; status: string }>(),
  ]);
  const who = fullName(contact) ?? "This contact";
  const lines = [
    `${who}${contact.job_title ? `, ${contact.job_title}` : ""}${contact.account_key ? ` at ${contact.account_key}` : ""}.`,
    `Warmth: ${contact.warmth}. Touches: ${contact.total_touches}. Last contacted: ${contact.last_contacted_at ?? "never"}.`,
    deal ? `Latest deal stage: ${deal.stage}.` : "No deal yet.",
    inbound ? `Last inbound mail ${inbound.received_at} (${inbound.intent ?? "not triaged"}, ${inbound.status}).` : "No inbound mail.",
  ];
  return { text: lines.join("\n") };
};
