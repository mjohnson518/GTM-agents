// GTM-agents: search monitors: standing searches the provider runs on its own schedule, delivered to
// a signed webhook and drained into candidates.
//
// The operator creates a monitor at the provider and lists it in the deployment's config with a key
// and the name of the secret the provider signs deliveries with (one secret per monitor). Then:
//   - POST /api/webhooks/search/:key (handleMonitorWebhook) resolves :key against the configured
//     monitors only, never the body; verifies the delivery's signature with that monitor's secret
//     before touching the database; refuses bodies over 1 MB; and, when signals:monitors_enabled is
//     on, writes each hit (up to 500) to monitor_items in batches, cleaned, deduplicated on the
//     provider's result id and on the URL per monitor. Off, or unreadable, it answers 503 and records
//     nothing;
//   - the monitor processor (drainMonitorItems) takes up to 500 unprocessed hits a run, oldest first,
//     and, for a monitor whose results are company sites, writes each as a raw account candidate
//     (the account is the result's host) for the discovery cycle to enrich, qualify and promote.
//     Hits from a monitor of articles are skipped, so a publisher never becomes an account. A hit with no company account (a personal or shared host) or on the never list is
//     skipped; one already a candidate is a duplicate. The fit gate applies downstream. Each monitor has an inactive discovery_queries row, so its candidates earn credit.
// Hits are third-party text and stay data.
import { accountKey } from "../data/keys.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import { sha256Hex } from "../shared/hash.ts";
import type { SourcingBrain } from "../sourcing/brain.ts";
import { insertCandidate } from "../sourcing/candidates.ts";
import { readFlagOn } from "../sourcing/flags.ts";
import { matchNeverList } from "../sourcing/identity.ts";
import { PROVIDER_TEXT_CAPS, cleanProviderText, cleanProviderUrl } from "../sourcing/text.ts";
import { creditResults, ensureSourceQuery } from "./attribution.ts";
import { SIGNAL_FLAGS, SIGNAL_LIMITS } from "./flags.ts";
import type { MonitorHit } from "./ports.ts";

export const MONITOR_BODY_MAX_BYTES = 1_000_000;
const KEY = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export interface MonitorConfig {
  /** The :key in the webhook path. */
  key: string;
  /** The provider (adapter name). */
  provider: string;
  /** The name of the Worker secret this monitor's deliveries are signed with. */
  secretName: string;
  /** What the monitor looks for, for its attribution row. */
  description: string;
  /**
   * What the monitor's results are. Only "company_sites" (a search in the provider's company
   * category, whose results are companies' own pages) becomes candidates, because the account is
   * read from the result's host. A monitor of articles would turn publishers into accounts, so its
   * hits are skipped.
   */
  results: "company_sites" | "articles";
  segment?: string;
}

export interface MonitorWebhookDeps {
  db: D1Database;
  flags: FlagReader;
  monitors: readonly MonitorConfig[];
  /** A Worker secret by name, or undefined when unset. */
  secret(name: string): string | undefined;
  /** The provider's signature check over the raw body. */
  verify(args: { secret: string; headers: Headers; rawBody: string; now: Date }): Promise<boolean>;
  /** The provider's delivery parser. Null when the body is not a delivery. */
  parse(body: unknown): MonitorHit[] | null;
  now: Date;
}

const reply = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function monitorItemId(provider: string, monitor: string, ref: string): Promise<string> {
  return `mi_${(await sha256Hex(`${provider}\n${monitor}\n${ref}`)).slice(0, 32)}`;
}

/** The webhook route's handler. The caller passes the :key path parameter. */
/**
 * A monitor's signing secret must be named MONITOR_<SOMETHING>, so a monitor can never be pointed at
 * a plain setting or an unrelated credential (an API token, say) whose value would then sign deliveries.
 */
export const MONITOR_SECRET_NAME = /^MONITOR_[A-Z0-9_]{1,60}$/;

export async function handleMonitorWebhook(request: Request, key: string, deps: MonitorWebhookDeps): Promise<Response> {
  if (request.method !== "POST") return reply(405, { error: "method not allowed" });
  const monitor = KEY.test(key) ? deps.monitors.find((m) => m.key === key) : undefined;
  if (!monitor) return reply(404, { error: "unknown monitor" });
  if (!MONITOR_SECRET_NAME.test(monitor.secretName)) return reply(503, { error: "monitor secret name must start with MONITOR_" });
  const secret = deps.secret(monitor.secretName);
  if (!secret) return reply(503, { error: "monitor secret not configured" });
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MONITOR_BODY_MAX_BYTES) return reply(413, { error: "body too large" });
  const rawBody = await request.text();
  if (rawBody.length > MONITOR_BODY_MAX_BYTES) return reply(413, { error: "body too large" });
  let verified: boolean;
  try {
    verified = (await deps.verify({ secret, headers: request.headers, rawBody, now: deps.now })) === true;
  } catch {
    verified = false;
  }
  if (!verified) return reply(401, { error: "bad signature" });
  if (!(await readFlagOn(deps.flags, SIGNAL_FLAGS.monitors))) return reply(503, { error: "monitors are off" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return reply(400, { error: "not JSON" });
  }
  const hits = deps.parse(parsed);
  if (hits === null) return reply(200, { stored: 0, ignored: true });
  // Cleaned first, then written in batches: INSERT OR IGNORE on the unique result id and URL per
  // monitor dedupes redeliveries without a read per hit.
  const stamp = deps.now.toISOString();
  const statements: D1PreparedStatement[] = [];
  const seenUrls = new Set<string>();
  for (const hit of hits.slice(0, SIGNAL_LIMITS.monitorHitsPerDelivery)) {
    const url = cleanProviderUrl(hit.url);
    const ref = cleanProviderText(hit.providerRef, PROVIDER_TEXT_CAPS.ref) ?? url;
    if (!url || !ref || seenUrls.has(url)) continue;
    seenUrls.add(url);
    const title = cleanProviderText(hit.title, PROVIDER_TEXT_CAPS.resultTitle);
    const published = typeof hit.publishedAt === "string" && Number.isFinite(Date.parse(hit.publishedAt)) ? new Date(Date.parse(hit.publishedAt)).toISOString() : null;
    const payload = JSON.stringify({ url, ...(title ? { title } : {}), ...(published ? { published_at: published } : {}) });
    statements.push(
      deps.db
        .prepare("INSERT OR IGNORE INTO monitor_items (id, provider, monitor_id, url, result_id, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
        .bind(await monitorItemId(monitor.provider, monitor.key, ref), monitor.provider, monitor.key, url, ref, payload, stamp),
    );
  }
  let stored = 0;
  for (let i = 0; i < statements.length; i += 100) {
    const results = await deps.db.batch(statements.slice(i, i + 100));
    stored += results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
  }
  return reply(200, { stored });
}

export interface MonitorDrainStats {
  processed: number;
  inserted: number;
  duplicate: number;
  skipped: number;
}

interface ItemRow {
  id: string;
  provider: string;
  monitor_id: string;
  url: string | null;
  result_id: string | null;
  payload: string | null;
}

function parsePayload(text: string | null): { title?: unknown } {
  try {
    const value: unknown = text ? JSON.parse(text) : {};
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

/** Turn up to `limit` unprocessed monitor hits into raw account candidates. */
export async function drainMonitorItems(args: { db: D1Database; monitors: readonly MonitorConfig[]; brain: SourcingBrain; now: Date; limit: number; log: JobLogger; signal?: AbortSignal }): Promise<MonitorDrainStats> {
  const stats: MonitorDrainStats = { processed: 0, inserted: 0, duplicate: 0, skipped: 0 };
  const limit = Math.max(0, Math.min(SIGNAL_LIMITS.monitorDrainPerRun, args.limit));
  if (limit === 0) return stats;
  const { db, now } = args;
  const stamp = now.toISOString();
  const { results } = await db.prepare("SELECT id, provider, monitor_id, url, result_id, payload FROM monitor_items WHERE processed_at IS NULL ORDER BY created_at, id LIMIT ?1").bind(limit).all<ItemRow>();
  const queryIds = new Map<string, string>();
  const credit = new Map<string, number>();
  for (const item of results) {
    if (args.signal?.aborted) break;
    stats.processed += 1;
    const finish = (outcome: "duplicate" | "skipped" | null, candidateId: string | null = null) =>
      db.prepare("UPDATE monitor_items SET processed_at = ?2, outcome = ?3, candidate_id = ?4 WHERE id = ?1 AND processed_at IS NULL").bind(item.id, stamp, outcome, candidateId).run();
    const url = cleanProviderUrl(item.url);
    const domain = accountKey(url);
    const monitor = args.monitors.find((m) => m.key === item.monitor_id && m.provider === item.provider);
    if (!url || !domain || !monitor || monitor.results !== "company_sites" || matchNeverList(args.brain.never, { domain, accountName: null, title: null })) {
      stats.skipped += 1;
      await finish("skipped");
      continue;
    }
    let queryId = queryIds.get(monitor.key);
    if (!queryId) {
      queryId = await ensureSourceQuery(db, { kind: "monitor", provider: monitor.provider, key: monitor.key, text: monitor.description, now });
      queryIds.set(monitor.key, queryId);
    }
    const payload = parsePayload(item.payload);
    const sourceRef = `monitor:${item.result_id ?? url}`;
    const inserted = await insertCandidate(
      db,
      {
        source: item.provider,
        sourceRef,
        queryId,
        searchType: "account",
        url,
        resultTitle: cleanProviderText(payload.title, PROVIDER_TEXT_CAPS.resultTitle),
        category: "monitor",
        accountName: domain,
        accountKey: domain,
        status: "raw",
        attributes: { intent: "monitor", ...(monitor.segment ? { segment: monitor.segment } : {}) },
      },
      now,
    );
    if (!inserted) {
      stats.duplicate += 1;
      await finish("duplicate");
      continue;
    }
    const row = await db.prepare("SELECT id FROM candidates WHERE source = ?1 AND source_ref = ?2").bind(item.provider, sourceRef).first<{ id: string }>();
    await finish(null, row?.id ?? null);
    stats.inserted += 1;
    credit.set(queryId, (credit.get(queryId) ?? 0) + 1);
  }
  for (const [queryId, added] of credit) await creditResults(db, queryId, added);
  return stats;
}
