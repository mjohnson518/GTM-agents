// GTM-agents: the ship loop's themes: feedback is triaged, embedded and grouped into themes, and
// every live theme is scored by demand. Run daily by the ship_themes job (planning.ts).
//
// A run, in order, each phase bounded by the job's row ceiling, its spend cap and its time:
//   1. triage: feedback_items with status new, oldest first, one schema-bound call each (role
//      triage, triage.ts). An item that cannot be acted on is closed (declined); an actionable one
//      is triaged with its neutral summary. An answer that cannot be used counts an attempt, and the
//      third such answer declines the item. A refusal before any call (no model, no price, the
//      budget) stops the phase and nothing is counted; a call that fails counts nothing either, and
//      two failed calls in a row stop the phase;
//   2. theming: triaged items with no theme have their summaries embedded (role embedding) in one
//      call, and each joins the nearest live theme whose centroid comes from the same embedding
//      model, when the cosine similarity is at least the join threshold (0.83 by default). The
//      theme's centroid becomes the running mean of its members, written to D1 with a
//      compare-and-set on the member count. Otherwise the item starts a theme of its own;
//   3. scoring: every live theme of the repository is rescored from the database:
//        (demand + 3 * paying requesters + requester MRR / ARPA) * priority weight
//      where demand counts distinct requesters, paying requesters are those whose lifecycle state is
//      paying, expanding or at risk, requester MRR is their monthly revenue, ARPA is the current MRR
//      over the paying count (the term is 0 while nobody pays), and the weight follows the highest
//      priority among the theme's items: critical 4, high 2.5, normal (medium) 1.5, low 1.
// Feedback text is read only to be fenced into the triage call; nothing else in a run sees it.
import type { GtmConfig } from "@gtm-agents/core/config";
import type { FlagReader, JobLogger } from "@gtm-agents/core/jobs";
import { PAYING_STATES } from "@gtm-agents/core/lifecycle";
import { currentMrr } from "@gtm-agents/core/metrics";
import type { ModelGateway } from "@gtm-agents/core/ports";
import { sanitizeErrorMessage } from "@gtm-agents/core/security";
import type { SpendGate } from "@gtm-agents/core/sourcing";
import { complete, embed, type ShipModelDeps } from "./model-call.ts";
import { LIVE_THEME_SQL, shortId } from "./planning-shared.ts";
import { MAX_TRIAGE_ATTEMPTS, TRIAGE_SCHEMA, TRIAGE_SYSTEM, parseTriage, triageUserTurn, type TriagePriority } from "./triage.ts";

/** Cosine similarity at or above which a summary joins a theme. */
export const DEFAULT_JOIN_THRESHOLD = 0.83;
/** Live themes compared against in one run, most recently updated first. */
export const MAX_THEMES_COMPARED = 500;
export const TRIAGE_TIMEOUT_MS = 30_000;
export const EMBED_TIMEOUT_MS = 30_000;
/** Summaries per embedding call. */
export const EMBED_BATCH = 64;

/** The theme score's weight for the highest priority among a theme's items. "normal" is medium. */
export const PRIORITY_WEIGHTS: Readonly<Record<TriagePriority, number>> = Object.freeze({ critical: 4, high: 2.5, normal: 1.5, low: 1 });
const RANKED: readonly TriagePriority[] = ["low", "normal", "high", "critical"];

export interface ScoreInput {
  demand: number;
  payingRequesters: number;
  requesterMrrCents: number;
  /** Average revenue per paying account, in cents; 0 or less when nobody pays. */
  arpaCents: number;
  maxPriority: TriagePriority | null;
}

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

/** The theme score, rounded to two decimals. Pure. */
export function themeScore(input: ScoreInput): number {
  const mrrTerm = count(input.arpaCents) > 0 ? count(input.requesterMrrCents) / input.arpaCents : 0;
  const weight = input.maxPriority ? PRIORITY_WEIGHTS[input.maxPriority] : PRIORITY_WEIGHTS.low;
  return Math.round((count(input.demand) + 3 * count(input.payingRequesters) + mrrTerm) * weight * 100) / 100;
}

/** Cosine similarity, or null when the vectors differ in length or one is all zeros. Pure. */
export function cosine(a: readonly number[], b: readonly number[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** The running mean of `n` vectors averaged in `centroid`, with one more. Pure. */
export function runningMean(centroid: readonly number[], n: number, next: readonly number[]): number[] {
  const members = Math.max(0, Math.floor(n));
  return centroid.map((c, i) => (c * members + (next[i] ?? 0)) / (members + 1));
}

/** A stored centroid, or null when it is not a non-empty array of finite numbers. Pure. */
export function parseCentroid(text: string | null | undefined): number[] | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || value.length === 0 || !value.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
    return value as number[];
  } catch {
    return null;
  }
}

/** A centroid as stored: JSON, each component to 7 significant digits. Pure. */
export const serializeCentroid = (v: readonly number[]): string => JSON.stringify(v.map((x) => Number(x.toPrecision(7))));

export interface LiveTheme {
  id: string;
  centroid: number[];
  model: string;
  members: number;
}

/** The nearest theme from the same embedding model at or above the threshold, or null. Pure. */
export function nearestTheme(vector: readonly number[], model: string, themes: readonly LiveTheme[], threshold: number): { theme: LiveTheme; similarity: number } | null {
  let best: { theme: LiveTheme; similarity: number } | null = null;
  for (const theme of themes) {
    if (theme.model !== model) continue;
    const similarity = cosine(vector, theme.centroid);
    if (similarity === null || similarity < threshold) continue;
    if (!best || similarity > best.similarity) best = { theme, similarity };
  }
  return best;
}

export interface ThemesDeps {
  db: D1Database;
  flags: FlagReader;
  config: Pick<GtmConfig, "models">;
  model: ModelGateway | undefined;
  spend: Pick<SpendGate, "allow" | "record" | "recordModel">;
  /** The repository the themes are for (owner/name). */
  repo: string;
  job: string;
  runId?: string;
  now: Date;
  log: JobLogger;
  signal?: AbortSignal;
  /** Feedback items triaged per run, and items themed per run. */
  maxRows: number;
  joinThreshold?: number;
}

export interface ThemesResult {
  triaged: number;
  declined: number;
  unusable: number;
  themed: number;
  joined: number;
  created: number;
  rescored: number;
  failed: number;
  /** Why a phase stopped early, when it did. */
  stopped: string[];
}

interface NewItem {
  id: string;
  text: string;
  triage_attempts: number;
}

async function triagePhase(deps: ThemesDeps, model: ShipModelDeps, result: ThemesResult): Promise<void> {
  const { db, now } = deps;
  const at = now.toISOString();
  const { results } = await db
    .prepare("SELECT id, text, triage_attempts FROM feedback_items WHERE status = 'new' ORDER BY created_at ASC, id ASC LIMIT ?1")
    .bind(deps.maxRows)
    .all<NewItem>();
  let failedCalls = 0;
  for (const item of results) {
    if (deps.signal?.aborted) {
      result.stopped.push("triage: the run's time ran out");
      return;
    }
    try {
      const answer = await complete(model, {
        role: "triage",
        system: TRIAGE_SYSTEM,
        user: triageUserTurn(item.text),
        jsonSchema: TRIAGE_SCHEMA,
        maxTokens: 400,
        timeoutMs: TRIAGE_TIMEOUT_MS,
        metadata: { feedback_id: item.id },
      });
      if (!answer.ok && !answer.called) {
        result.stopped.push(`triage: ${answer.reason}`);
        return;
      }
      if (!answer.ok) {
        // A call that failed is not an unusable answer: nothing is counted against the item. Two in
        // a row look like an outage, so the phase stops rather than wait out every time-out.
        result.failed += 1;
        failedCalls += 1;
        if (failedCalls >= 2) {
          result.stopped.push(`triage: ${answer.reason}`);
          return;
        }
        continue;
      }
      failedCalls = 0;
      const parsed = parseTriage(answer.text);
      if (!parsed) {
        // The answer is not used. A third unusable answer declines the item rather than paying for it every day.
        const attempts = Number(item.triage_attempts) + 1;
        const give = attempts >= MAX_TRIAGE_ATTEMPTS;
        await db
          .prepare(`UPDATE feedback_items SET triage_attempts = ?2${give ? ", status = 'declined', triaged_at = ?3" : ""} WHERE id = ?1 AND status = 'new'`)
          .bind(item.id, attempts, ...(give ? [at] : []))
          .run();
        result.unusable += 1;
        if (give) result.declined += 1;
        continue;
      }
      const status = parsed.actionable ? "triaged" : "declined";
      const changed = await db
        .prepare(
          `UPDATE feedback_items SET status = ?2, category = ?3, priority = ?4, triage_summary = ?5, affected_area = ?6, triaged_at = ?7
            WHERE id = ?1 AND status = 'new'`,
        )
        .bind(item.id, status, parsed.category, parsed.priority, parsed.summary, parsed.affectedArea, at)
        .run();
      if ((changed.meta.changes ?? 0) === 0) continue;
      if (parsed.actionable) result.triaged += 1;
      else result.declined += 1;
    } catch (error) {
      result.failed += 1;
      deps.log.warn("a feedback item could not be triaged; the next run tries again", { feedbackId: item.id, error: sanitizeErrorMessage(error) });
    }
  }
}

interface TriagedItem {
  id: string;
  triage_summary: string;
  category: string | null;
  affected_area: string | null;
  priority: string | null;
}

async function loadLiveThemes(db: D1Database, repo: string): Promise<LiveTheme[]> {
  const { results } = await db
    .prepare(`SELECT id, centroid, centroid_model, member_count FROM themes WHERE repo = ?1 AND status IN (${LIVE_THEME_SQL}) AND centroid IS NOT NULL AND centroid_model IS NOT NULL ORDER BY updated_at DESC LIMIT ?2`)
    .bind(repo, MAX_THEMES_COMPARED)
    .all<{ id: string; centroid: string; centroid_model: string; member_count: number }>();
  const out: LiveTheme[] = [];
  for (const r of results) {
    const centroid = parseCentroid(r.centroid);
    if (centroid) out.push({ id: r.id, centroid, model: r.centroid_model, members: Math.max(0, Number(r.member_count) || 0) });
  }
  return out;
}

async function themePhase(deps: ThemesDeps, model: ShipModelDeps, result: ThemesResult): Promise<void> {
  const { db, now } = deps;
  const at = now.toISOString();
  const threshold = deps.joinThreshold ?? DEFAULT_JOIN_THRESHOLD;
  const { results: items } = await db
    .prepare("SELECT id, triage_summary, category, affected_area, priority FROM feedback_items WHERE status = 'triaged' AND theme_id IS NULL AND triage_summary IS NOT NULL ORDER BY created_at ASC, id ASC LIMIT ?1")
    .bind(deps.maxRows)
    .all<TriagedItem>();
  if (items.length === 0) return;
  const themes = await loadLiveThemes(db, deps.repo);
  for (let start = 0; start < items.length; start += EMBED_BATCH) {
    if (deps.signal?.aborted) {
      result.stopped.push("theming: the run's time ran out");
      return;
    }
    const batch = items.slice(start, start + EMBED_BATCH);
    const vectors = await embed(model, batch.map((i) => i.triage_summary), EMBED_TIMEOUT_MS);
    if (!vectors.ok) {
      result.stopped.push(`theming: ${vectors.reason}`);
      return;
    }
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      const vector = vectors.vectors[i];
      if (!item || !vector) continue;
      try {
        const near = nearestTheme(vector, vectors.model, themes, threshold);
        if (near) {
          // Claim the item first, then move the centroid with a compare-and-set on the member count.
          const claimed = await db.prepare("UPDATE feedback_items SET status = 'themed', theme_id = ?2 WHERE id = ?1 AND status = 'triaged' AND theme_id IS NULL").bind(item.id, near.theme.id).run();
          if ((claimed.meta.changes ?? 0) === 0) continue;
          const centroid = runningMean(near.theme.centroid, near.theme.members, vector);
          const moved = await db
            .prepare(`UPDATE themes SET centroid = ?2, member_count = member_count + 1, updated_at = ?3 WHERE id = ?1 AND member_count = ?4 AND status IN (${LIVE_THEME_SQL})`)
            .bind(near.theme.id, serializeCentroid(centroid), at, near.theme.members)
            .run();
          if ((moved.meta.changes ?? 0) === 0) {
            await db.prepare("UPDATE feedback_items SET status = 'triaged', theme_id = NULL WHERE id = ?1 AND theme_id = ?2").bind(item.id, near.theme.id).run();
            deps.log.warn("a theme changed while an item joined it; the item waits for the next run", { themeId: near.theme.id });
            continue;
          }
          near.theme.centroid = centroid;
          near.theme.members += 1;
          result.joined += 1;
          result.themed += 1;
          continue;
        }
        const id = shortId();
        const title = item.triage_summary.slice(0, 120);
        await db.batch([
          db
            .prepare(
              `INSERT INTO themes (id, repo, category, affected_area, title, status, centroid, centroid_model, member_count, max_priority, created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6, ?7, 1, ?8, ?9, ?9)`,
            )
            .bind(id, deps.repo, item.category ?? "other", item.affected_area, title, serializeCentroid(vector), vectors.model, item.priority, at),
          db.prepare("UPDATE feedback_items SET status = 'themed', theme_id = ?2 WHERE id = ?1 AND status = 'triaged' AND theme_id IS NULL").bind(item.id, id),
        ]);
        themes.unshift({ id, centroid: [...vector], model: vectors.model, members: 1 });
        result.created += 1;
        result.themed += 1;
      } catch (error) {
        result.failed += 1;
        deps.log.warn("a triaged item could not be themed; the next run tries again", { feedbackId: item.id, error: sanitizeErrorMessage(error) });
      }
    }
  }
}

const PAYING = PAYING_STATES.map((s) => `'${s}'`).join(", ");

/** Rescore every live theme of the repository from the database. Returns how many changed. Throws on a database error. */
export async function rescoreThemes(db: D1Database, repo: string, now: Date): Promise<number> {
  const [demand, paying, mrr, current] = await Promise.all([
    db
      .prepare(
        `SELECT f.theme_id AS id,
                COUNT(DISTINCT COALESCE(f.contact_id, l.contact_id, 'pu:' || f.product_user_id, 'fb:' || f.id)) AS demand,
                MAX(CASE f.priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 WHEN 'low' THEN 1 ELSE 0 END) AS rank
           FROM feedback_items f
           JOIN themes t ON t.id = f.theme_id
           LEFT JOIN contact_lifecycle l ON f.contact_id IS NULL AND f.product_user_id IS NOT NULL AND l.product_user_id = f.product_user_id
          WHERE t.repo = ?1 AND t.status IN (${LIVE_THEME_SQL}) AND f.status IN ('themed', 'shipped')
          GROUP BY f.theme_id`,
      )
      .bind(repo)
      .all<{ id: string; demand: number; rank: number | null }>(),
    db
      .prepare(
        `SELECT r.theme_id AS id, COUNT(*) AS paying, COALESCE(SUM(r.mrr), 0) AS mrr FROM (
           SELECT DISTINCT f.theme_id AS theme_id, l.contact_id AS contact_id, l.mrr_cents AS mrr
             FROM feedback_items f
             JOIN themes t ON t.id = f.theme_id
             JOIN contact_lifecycle l ON (f.contact_id IS NOT NULL AND l.contact_id = f.contact_id) OR (f.contact_id IS NULL AND f.product_user_id IS NOT NULL AND l.product_user_id = f.product_user_id)
            WHERE t.repo = ?1 AND t.status IN (${LIVE_THEME_SQL}) AND f.status IN ('themed', 'shipped') AND l.state IN (${PAYING})
         ) r GROUP BY r.theme_id`,
      )
      .bind(repo)
      .all<{ id: string; paying: number; mrr: number }>(),
    currentMrr(db),
    db
      .prepare(`SELECT id, demand_count, paying_requesters, requester_mrr_cents, max_priority, priority_score FROM themes WHERE repo = ?1 AND status IN (${LIVE_THEME_SQL}) LIMIT ?2`)
      .bind(repo, MAX_THEMES_COMPARED)
      .all<{ id: string; demand_count: number; paying_requesters: number; requester_mrr_cents: number; max_priority: string | null; priority_score: number }>(),
  ]);
  const arpaCents = mrr.paying > 0 ? mrr.mrrCents / mrr.paying : 0;
  const demandOf = new Map(demand.results.map((r) => [r.id, r]));
  const payingOf = new Map(paying.results.map((r) => [r.id, r]));
  const at = now.toISOString();
  const updates: D1PreparedStatement[] = [];
  for (const theme of current.results) {
    const d = demandOf.get(theme.id);
    const p = payingOf.get(theme.id);
    const rank = Number(d?.rank ?? 0);
    const maxPriority = rank >= 1 && rank <= 4 ? (RANKED[rank - 1] ?? null) : null;
    const next = {
      demand: Number(d?.demand ?? 0),
      paying: Number(p?.paying ?? 0),
      mrr: Math.round(Number(p?.mrr ?? 0)),
    };
    const score = themeScore({ demand: next.demand, payingRequesters: next.paying, requesterMrrCents: next.mrr, arpaCents, maxPriority });
    const same =
      Number(theme.demand_count) === next.demand &&
      Number(theme.paying_requesters) === next.paying &&
      Number(theme.requester_mrr_cents) === next.mrr &&
      (theme.max_priority ?? null) === maxPriority &&
      Number(theme.priority_score) === score;
    if (same) continue;
    updates.push(
      db
        .prepare("UPDATE themes SET demand_count = ?2, paying_requesters = ?3, requester_mrr_cents = ?4, max_priority = ?5, priority_score = ?6, updated_at = ?7 WHERE id = ?1")
        .bind(theme.id, next.demand, next.paying, next.mrr, maxPriority, score, at),
    );
  }
  for (let i = 0; i < updates.length; i += 50) await db.batch(updates.slice(i, i + 50));
  return updates.length;
}

/** One themes run: triage, theming and scoring. Throws only when a phase's first read fails. */
export async function runShipThemes(deps: ThemesDeps): Promise<ThemesResult> {
  const result: ThemesResult = { triaged: 0, declined: 0, unusable: 0, themed: 0, joined: 0, created: 0, rescored: 0, failed: 0, stopped: [] };
  const model: ShipModelDeps = { model: deps.model, config: deps.config, spend: deps.spend, job: deps.job, ...(deps.runId ? { runId: deps.runId } : {}), log: deps.log };
  await triagePhase(deps, model, result);
  await themePhase(deps, model, result);
  result.rescored = await rescoreThemes(deps.db, deps.repo, deps.now);
  return result;
}

/** One line for the run row. Pure. */
export function themesSummary(r: ThemesResult): string {
  const parts = [`${r.triaged} triaged`, `${r.declined} closed`, `${r.unusable} unusable answers`, `${r.joined} joined a theme`, `${r.created} new themes`, `${r.rescored} rescored`];
  if (r.failed) parts.push(`${r.failed} failed`);
  return `${parts.join(", ")}${r.stopped.length ? `; stopped: ${r.stopped.join("; ")}` : ""}`;
}
