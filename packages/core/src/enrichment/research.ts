// GTM-agents: account research: firmographic facts from a company research source, each with its
// source URL, stored in account_facts.
//
// A research run takes seconds to minutes, so each job run has two phases:
//   - poll: runs in flight are read: `pending` rows with attributes.run_id, and `found` rows being
//     refreshed, with attributes.refresh_run_id. A finished run writes the kept fields into the
//     columns, their sources under attributes.evidence ({ field: { url, provider, retrieved_at } }),
//     and the extras (last_round_date, hiring_functions) and the dropped field names under
//     attributes. The row is `found` when the provider's verdict is found and at least one field was
//     kept, and `not_found` (every column empty) when the verdict is not_found or nothing was kept. A
//     failed run, a run that could not inspect the site (cannot_verify), or one still pending 24 hours
//     after it started is `failed` with attempts incremented. A refresh of a found row never hides its
//     facts: the row stays `found` while the refresh runs, and a refresh that does not come back found
//     keeps the old columns and counts a refresh attempt instead;
//   - start: with the rows left in the run's budget, accounts with no row, a not_found row older than
//     180 days, a found row older than 180 days (a refresh, under 3 failed refreshes, the last more than
//     7 days ago), or a failed row under 3 attempts older than 7 days, best prescore first. Accounts on
//     the brain's never list, accounts the model fit score put below LOW_FIT_SCORE, and accounts
//     already started this calendar month are skipped. Each start asks the spend gate first and claims
//     research:<account>:<yyyy-mm> in the effects ledger, so an account is never paid for twice in the
//     calendar month (UTC) it was paid for, even when its run failed.
// Cost: a start records the cost the adapter expects (the effort's fixed price), including a start
// that failed in a way that may still have created a run. When a finished run reports a higher cost,
// only the difference is recorded, after its row is written, so nothing is counted twice. The daily
// cap is checked before each start, so it can be exceeded by at most one run's price.
// Everything the provider returns is third-party text: it is cleaned (sourcing/text.ts) before it is
// stored, every stored field needs an http(s) source URL, and a prompt that reads it later puts it
// inside the untrusted fence (scoring/fit.ts).
import { claimEffect, releaseEffect } from "../events/effects.ts";
import type { JobLogger } from "../jobs/registry.ts";
import { AdapterError } from "../ports/types.ts";
import { RESEARCH_FIELDS, RESEARCH_HIRING_FUNCTIONS, type CompanyResearchRead, type CompanyResearchSource, type ResearchField } from "../ports/discovery.ts";
import { LOW_FIT_SCORE } from "../scoring/fit.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import type { SourcingBrain } from "../sourcing/brain.ts";
import { matchNeverList } from "../sourcing/identity.ts";
import type { SpendGate } from "../sourcing/spend.ts";
import { cleanProviderText, cleanProviderUrl } from "../sourcing/text.ts";

/** Found and not_found rows older than this are researched again. */
export const RESEARCH_REFRESH_DAYS = 180;
/** A failed row is retried after this many days, while it has fewer than RESEARCH_MAX_ATTEMPTS. */
export const RESEARCH_RETRY_DAYS = 7;
export const RESEARCH_MAX_ATTEMPTS = 3;
/** A run still pending this long after it started is failed. */
export const RESEARCH_PENDING_TIMEOUT_MS = 24 * 3_600_000;
/** The effect claimed for each start in the effects ledger. */
export const RESEARCH_EFFECT = "start";
const DAY_MS = 86_400_000;
const TECHNOLOGIES_MAX = 10;

/** The effects-ledger event id for researching one account in one calendar month (UTC). */
export function researchEffectId(accountKey: string, now: Date): string {
  return `research:${accountKey}:${now.toISOString().slice(0, 7)}`;
}

export interface AccountResearchOptions {
  db: D1Database;
  source: CompanyResearchSource;
  brain: Pick<SourcingBrain, "never">;
  gate: SpendGate;
  now: Date;
  /** Rows polled plus runs started, at most, in this run. */
  maxRows: number;
  log?: JobLogger;
  signal?: AbortSignal;
}

export interface AccountResearchResult {
  polled: number;
  completed: number;
  found: number;
  notFound: number;
  failed: number;
  /** Fields the provider returned that were not stored. */
  dropped: number;
  started: number;
  /** Accounts skipped for the never list or a low fit score. */
  skipped: number;
  /** Accounts already started this month, per the effects ledger. */
  alreadyClaimed: number;
  /** Runs started and paid for whose row could not be written. */
  unrecorded: number;
  /** Why starting stopped early, when it did. */
  stopped?: string;
}

type Attributes = Record<string, unknown>;

function parseAttributes(raw: unknown): Attributes {
  if (typeof raw !== "string") return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Attributes) : {};
  } catch {
    return {};
  }
}

const usdOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** The text cap for each text field, matching the output schema. */
const TEXT_CAPS: Partial<Record<ResearchField, number>> = { employee_range: 40, industry: 80, sector: 80, company_type: 40, funding_stage: 40 };

/** A kept value, cleaned for storage, or null when it is not fit to store. */
function cleanValue(field: ResearchField, value: unknown, now: Date): unknown {
  const cap = TEXT_CAPS[field];
  if (cap !== undefined) return cleanProviderText(value, cap);
  switch (field) {
    case "employees_count":
      return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
    case "raised_usd":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
    case "founded_year":
      return typeof value === "number" && Number.isInteger(value) && value >= 1800 && value <= now.getUTCFullYear() ? value : null;
    case "hq_country":
      return typeof value === "string" && /^[A-Z]{2}$/.test(value) ? value : null;
    case "last_round_date":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) ? value : null;
    case "technologies": {
      if (!Array.isArray(value)) return null;
      const kept = value.map((t) => cleanProviderText(t, 60)).filter((t): t is string => t !== null).slice(0, TECHNOLOGIES_MAX);
      return kept.length > 0 ? kept : null;
    }
    case "hiring_functions": {
      if (!Array.isArray(value)) return null;
      const allowed = RESEARCH_HIRING_FUNCTIONS as readonly string[];
      const kept = [...new Set(value.filter((f): f is string => typeof f === "string" && allowed.includes(f)))].slice(0, 5);
      return kept.length > 0 ? kept : null;
    }
    default:
      return null;
  }
}

/** The attribute keys this module owns; a new research result replaces all of them. */
const RESEARCH_ATTRIBUTE_KEYS = ["evidence", "dropped", "verdict", "last_round_date", "hiring_functions", "last_error", "refresh_run_id", "refresh_started_at", "refresh_attempts", "refresh_failed_at"] as const;
/** The keys that track a refresh in flight, removed when it ends. */
const REFRESH_KEYS = ["refresh_run_id", "refresh_started_at"] as const;

function without(attributes: Attributes, keys: readonly string[]): Attributes {
  const out = { ...attributes };
  for (const key of keys) delete out[key];
  return out;
}

interface Stored {
  status: "found" | "not_found" | "failed";
  columns: Record<string, string | number | null>;
  attributes: Attributes;
  dropped: number;
}

/** What a finished run stores: only cleaned values that carry a source URL. */
function storedFacts(read: Extract<CompanyResearchRead, { status: "done" }>, provider: string, now: Date): Stored {
  const values: Partial<Record<ResearchField, unknown>> = {};
  const evidence: Record<string, { url: string; provider: string; retrieved_at: string }> = {};
  const dropped = new Set<string>(read.dropped.filter((f) => (RESEARCH_FIELDS as readonly string[]).includes(f)));
  const record = read.record;
  if (record) {
    for (const field of RESEARCH_FIELDS) {
      const raw = record.attributes[field];
      if (raw === undefined || raw === null) continue;
      const value = cleanValue(field, raw, now);
      const source = record.evidence.find((e) => e.field === field);
      const url = cleanProviderUrl(source?.url);
      if (value === null || url === null) {
        dropped.add(field);
        continue;
      }
      values[field] = value;
      const retrieved = source && Number.isFinite(Date.parse(source.retrievedAt)) ? new Date(source.retrievedAt).toISOString() : now.toISOString();
      evidence[field] = { url, provider, retrieved_at: retrieved };
    }
  }
  const found = record?.verdict === "found" && Object.keys(values).length > 0;
  const v = (field: ResearchField) => (found && values[field] !== undefined ? (values[field] as string | number) : null);
  const columns = {
    headcount_band: v("employee_range"),
    employees_count: v("employees_count"),
    hq_country: v("hq_country"),
    founded_year: v("founded_year"),
    sector: v("sector"),
    industry: v("industry"),
    company_type: v("company_type"),
    funding_stage: v("funding_stage"),
    raised_usd: v("raised_usd"),
    technologies: found && values.technologies !== undefined ? JSON.stringify(values.technologies) : null,
  };
  const attributes: Attributes = {
    verdict: record?.verdict ?? "cannot_verify",
    dropped: [...dropped].sort(),
    ...(found ? { evidence } : {}),
    ...(found && values.last_round_date !== undefined ? { last_round_date: values.last_round_date } : {}),
    ...(found && values.hiring_functions !== undefined ? { hiring_functions: values.hiring_functions } : {}),
  };
  // A run that could not inspect the site, or returned no structured output, is a failure to retry.
  const status = found ? "found" : !record || record.verdict === "cannot_verify" ? "failed" : "not_found";
  return { status, columns, attributes, dropped: dropped.size };
}

interface InFlightRow {
  account_key: string;
  status: "pending" | "found";
  attempts: number;
  attributes: string;
  updated_at: string;
}

interface CandidateRow {
  account_key: string;
  name: string | null;
  facts_status: string | null;
  attributes: string | null;
}

type CostLike = { usd?: number; provider: string; capability: string };

/** Run one poll phase and one start phase. Never throws for a provider error. */
export async function runAccountResearch(options: AccountResearchOptions): Promise<AccountResearchResult> {
  const { db, source, gate, now } = options;
  const stamp = now.toISOString();
  const result: AccountResearchResult = { polled: 0, completed: 0, found: 0, notFound: 0, failed: 0, dropped: 0, started: 0, skipped: 0, alreadyClaimed: 0, unrecorded: 0 };
  const maxRows = Math.max(0, Math.floor(options.maxRows));
  const fallback = { provider: source.name, capability: "company_research" };
  let rateLimited = false;

  /** Record what a finished run cost beyond what its start recorded. Called only after its row is written. */
  const recordExtra = async (cost: CostLike | undefined, recordedUsd: number) => {
    const extra = usdOf(cost?.usd) - recordedUsd;
    if (cost && extra > 0) await gate.record({ ...cost, usd: extra }, fallback);
  };
  /** The guard that the row still tracks this run: pending with run_id, or found with refresh_run_id. */
  const inFlight = "((status = 'pending' AND json_extract(attributes, '$.run_id') = ?9) OR (status = 'found' AND json_extract(attributes, '$.refresh_run_id') = ?9))";

  /** End a run that did not produce facts. A refresh keeps the found row and its columns. */
  const failRun = async (row: InFlightRow, attrs: Attributes, runId: string | null, reason: string, cost?: CostLike): Promise<void> => {
    const lastError = cleanProviderText(reason, 64) ?? "failed";
    let changes: number;
    if (row.status === "found") {
      const attributes = { ...without(attrs, REFRESH_KEYS), last_error: lastError, refresh_attempts: Number(attrs.refresh_attempts ?? 0) + 1, refresh_failed_at: stamp };
      const res = await db
        .prepare(`UPDATE account_facts SET attributes = ?2, updated_at = ?3 WHERE account_key = ?1 AND status = 'found' AND json_extract(attributes, '$.refresh_run_id') = ?9`)
        .bind(row.account_key, JSON.stringify(attributes), stamp, null, null, null, null, null, runId)
        .run();
      changes = res.meta.changes ?? 0;
    } else {
      const attributes = { ...attrs, last_error: lastError };
      const res = await db
        .prepare(`UPDATE account_facts SET status = 'failed', attempts = attempts + 1, attributes = ?2, updated_at = ?3 WHERE account_key = ?1 AND status = 'pending' AND COALESCE(json_extract(attributes, '$.run_id'), '') = COALESCE(?9, '')`)
        .bind(row.account_key, JSON.stringify(attributes), stamp, null, null, null, null, null, runId)
        .run();
      changes = res.meta.changes ?? 0;
    }
    if (changes > 0) {
      result.failed += 1;
      await recordExtra(cost, usdOf(attrs.recorded_usd));
    }
  };

  // Poll phase.
  const { results: inflight } = await db
    .prepare(
      `SELECT account_key, status, attempts, attributes, updated_at FROM account_facts
        WHERE status = 'pending' OR (status = 'found' AND json_extract(attributes, '$.refresh_run_id') IS NOT NULL)
        ORDER BY updated_at, account_key LIMIT ?1`,
    )
    .bind(maxRows)
    .all<InFlightRow>();
  for (const row of inflight) {
    if (options.signal?.aborted || rateLimited) break;
    const attrs = parseAttributes(row.attributes);
    const refresh = row.status === "found";
    const idValue = refresh ? attrs.refresh_run_id : attrs.run_id;
    const runId = typeof idValue === "string" ? idValue : null;
    const startedValue = refresh ? attrs.refresh_started_at : attrs.started_at;
    const startedAt = Date.parse(typeof startedValue === "string" ? startedValue : row.updated_at);
    const expired = !Number.isFinite(startedAt) || now.getTime() - startedAt > RESEARCH_PENDING_TIMEOUT_MS;
    if (!runId) {
      if (expired) await failRun(row, attrs, null, "no_run_id");
      continue;
    }
    result.polled += 1;
    let read: CompanyResearchRead;
    try {
      read = await source.readCompanyResearch(runId);
    } catch (error) {
      if (error instanceof AdapterError && error.code === "rate_limited") {
        rateLimited = true;
        break;
      }
      if (error instanceof AdapterError && error.code === "not_found") await failRun(row, attrs, runId, "not_found");
      else if (expired) await failRun(row, attrs, runId, "timed_out");
      else options.log?.warn("a company research run could not be read; it is read again next run", { account: row.account_key, error: sanitizeErrorMessage(error) });
      continue;
    }
    if (read.status === "pending") {
      if (expired) await failRun(row, attrs, runId, "timed_out");
      continue;
    }
    if (read.status === "failed") {
      await failRun(row, attrs, runId, read.reason, read.cost);
      continue;
    }
    const stored = storedFacts(read, source.name, now);
    result.dropped += stored.dropped;
    if (stored.status === "failed" || (refresh && stored.status !== "found")) {
      // A refresh that does not come back found keeps the facts already on file.
      await failRun(row, attrs, runId, stored.status === "failed" ? (read.record ? "cannot_verify" : "no_output") : "refresh_not_found", read.cost);
      continue;
    }
    const attributes = { ...without(attrs, RESEARCH_ATTRIBUTE_KEYS), ...stored.attributes, run_id: runId, started_at: new Date(startedAt).toISOString() };
    const c = stored.columns;
    const res = await db
      .prepare(
        `UPDATE account_facts SET status = ?2, provider = ?3, headcount_band = ?4, employees_count = ?5, hq_country = ?6, founded_year = ?7,
           sector = ?8, industry = ?10, company_type = ?11, funding_stage = ?12, raised_usd = ?13, technologies = ?14, attributes = ?15,
           attempts = 0, fetched_at = ?16, updated_at = ?16
         WHERE account_key = ?1 AND ${inFlight}`,
      )
      .bind(row.account_key, stored.status, source.name, c.headcount_band, c.employees_count, c.hq_country, c.founded_year, c.sector, runId, c.industry, c.company_type, c.funding_stage, c.raised_usd, c.technologies, JSON.stringify(attributes), stamp)
      .run();
    if ((res.meta.changes ?? 0) === 0) continue;
    await recordExtra(read.cost, usdOf(attrs.recorded_usd));
    result.completed += 1;
    if (stored.status === "found") result.found += 1;
    else result.notFound += 1;
  }
  if (rateLimited) {
    result.stopped = "rate limited";
    return result;
  }

  // Start phase.
  const budget = maxRows - result.polled;
  if (budget <= 0 || options.signal?.aborted) return result;
  const refreshBefore = new Date(now.getTime() - RESEARCH_REFRESH_DAYS * DAY_MS).toISOString();
  const retryBefore = new Date(now.getTime() - RESEARCH_RETRY_DAYS * DAY_MS).toISOString();
  const { results: candidates } = await db
    .prepare(
      `SELECT a.account_key, a.name, f.status AS facts_status, f.attributes
         FROM accounts a
         LEFT JOIN account_fit af ON af.account_key = a.account_key
         LEFT JOIN account_facts f ON f.account_key = a.account_key
        WHERE (f.account_key IS NULL
               OR (f.status = 'not_found' AND COALESCE(f.fetched_at, f.updated_at) < ?1)
               OR (f.status = 'found' AND COALESCE(f.fetched_at, f.updated_at) < ?1
                   AND json_extract(f.attributes, '$.refresh_run_id') IS NULL
                   AND COALESCE(json_extract(f.attributes, '$.refresh_attempts'), 0) < ?2
                   AND COALESCE(json_extract(f.attributes, '$.refresh_failed_at'), '') < ?3)
               OR (f.status = 'failed' AND f.attempts < ?2 AND f.updated_at < ?3))
          AND NOT (af.status = 'scored' AND af.fit_score IS NOT NULL AND af.fit_score < ?4)
          AND COALESCE(json_extract(af.prescore_detail, '$.never'), 0) = 0
          AND NOT EXISTS (SELECT 1 FROM event_effects e WHERE e.event_id = 'research:' || a.account_key || ':' || ?6 AND e.effect = ?7)
        ORDER BY COALESCE(af.prescore, 0) DESC, a.account_key
        LIMIT ?5`,
    )
    .bind(refreshBefore, RESEARCH_MAX_ATTEMPTS, retryBefore, LOW_FIT_SCORE, budget * 3, stamp.slice(0, 7), RESEARCH_EFFECT)
    .all<CandidateRow>();
  for (const row of candidates) {
    if (result.started >= budget || options.signal?.aborted) break;
    if (matchNeverList(options.brain.never, { domain: row.account_key, accountName: row.name })) {
      result.skipped += 1;
      continue;
    }
    if (!(await gate.allow())) {
      result.stopped = gate.stopped ?? "budget";
      break;
    }
    const eventId = researchEffectId(row.account_key, now);
    let claimed: boolean;
    try {
      claimed = await claimEffect(db, eventId, RESEARCH_EFFECT);
    } catch (error) {
      // The claim is a gate: when it cannot be written, nothing is started.
      options.log?.warn("the effects ledger could not be written; research starts stop", { error: sanitizeErrorMessage(error) });
      result.stopped = "effects ledger unavailable";
      break;
    }
    if (!claimed) {
      result.alreadyClaimed += 1;
      continue;
    }
    const existing = parseAttributes(row.attributes);
    const refresh = row.facts_status === "found";
    let started: { runId: string; cost: CostLike };
    try {
      // Only the account key goes to the provider: the stored name may itself be provider text.
      started = await source.startCompanyResearch({ domain: row.account_key });
    } catch (error) {
      const code = error instanceof AdapterError ? error.code : "unknown";
      if (code === "rate_limited" || code === "auth" || code === "quota") {
        // Refused before any run was created: release the claim, leave the row, stop starting.
        await releaseEffect(db, eventId, RESEARCH_EFFECT);
        result.stopped = code === "rate_limited" ? "rate limited" : `provider refused: ${code}`;
        break;
      }
      if (code === "invalid" || code === "not_found") {
        // A refusal for this account: no run exists, so the claim is released.
        await releaseEffect(db, eventId, RESEARCH_EFFECT);
      } else {
        // An ambiguous failure (a timeout, a 5xx, a dropped connection, an unreadable reply) keeps the
        // claim, because the provider may have started the run; its price is recorded as if it had.
        await gate.record(source.startCost(), fallback);
      }
      options.log?.warn("a company research run could not be started", { account: row.account_key, error: sanitizeErrorMessage(error) });
      if (refresh) {
        const attributes = { ...existing, last_error: code, refresh_attempts: Number(existing.refresh_attempts ?? 0) + 1, refresh_failed_at: stamp };
        await db.prepare("UPDATE account_facts SET attributes = ?2, updated_at = ?3 WHERE account_key = ?1 AND status = 'found'").bind(row.account_key, JSON.stringify(attributes), stamp).run();
      } else {
        const attributes = { ...without(existing, RESEARCH_ATTRIBUTE_KEYS), last_error: code };
        await db
          .prepare(
            `INSERT INTO account_facts (account_key, status, attempts, provider, attributes, created_at, updated_at) VALUES (?1, 'failed', 1, ?2, ?3, ?4, ?4)
             ON CONFLICT (account_key) DO UPDATE SET status = 'failed', attempts = account_facts.attempts + 1, provider = ?2, attributes = ?3, updated_at = ?4`,
          )
          .bind(row.account_key, source.name, JSON.stringify(attributes), stamp)
          .run();
      }
      result.failed += 1;
      continue;
    }
    // Recorded before the row is written, so a failed write never loses what was paid.
    await gate.record(started.cost, fallback);
    result.started += 1;
    const recordedUsd = usdOf(started.cost.usd);
    const write = refresh
      ? db
          .prepare("UPDATE account_facts SET attributes = ?2 WHERE account_key = ?1 AND status = 'found'")
          .bind(row.account_key, JSON.stringify({ ...existing, refresh_run_id: started.runId, refresh_started_at: stamp, recorded_usd: recordedUsd }))
      : db
          .prepare(
            `INSERT INTO account_facts (account_key, status, attempts, provider, attributes, created_at, updated_at) VALUES (?1, 'pending', 0, ?2, ?3, ?4, ?4)
             ON CONFLICT (account_key) DO UPDATE SET status = 'pending', provider = ?2, attributes = ?3, updated_at = ?4`,
          )
          .bind(row.account_key, source.name, JSON.stringify({ ...existing, run_id: started.runId, started_at: stamp, recorded_usd: recordedUsd }), stamp);
    let written = false;
    for (let attempt = 0; attempt < 2 && !written; attempt += 1) {
      try {
        await write.run();
        written = true;
      } catch (error) {
        if (attempt === 1) {
          // The run is paid for and claimed for the month; only its result is lost.
          options.log?.error("a started company research run could not be recorded", { account: row.account_key, run_id: started.runId, error: sanitizeErrorMessage(error) });
          result.unrecorded += 1;
        }
      }
    }
  }
  return result;
}

/** One line for the run row. */
export function summarizeResearch(r: AccountResearchResult): string {
  const parts = [
    `started ${r.started}`,
    `completed ${r.completed} (found ${r.found}, not_found ${r.notFound})`,
    `failed ${r.failed}`,
    `dropped ${r.dropped} fields`,
    ...(r.skipped > 0 ? [`skipped ${r.skipped}`] : []),
    ...(r.alreadyClaimed > 0 ? [`already started this month ${r.alreadyClaimed}`] : []),
    ...(r.unrecorded > 0 ? [`unrecorded ${r.unrecorded}`] : []),
  ];
  return `${parts.join(", ")}${r.stopped ? `; stopped: ${r.stopped}` : ""}`;
}
