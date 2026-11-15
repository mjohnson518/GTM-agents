// GTM-agents: starting and running a targeting draft (docs/TARGETING.md).
//
// startTargetingDraft checks every gate, in order, before anything is fetched or spent, and each
// fails closed: targeting:enabled, targeting:draft_enabled, a model gateway, a model and a valid
// price for the worker role, the input (one URL that passes the URL check, or pasted text), the
// daily cap (targeting:drafts_daily_max), no other draft running, and the budget for the
// targeting_draft job. It then claims the one running slot with a running row and hands back the
// work, which the caller runs after answering (a site read and a model call outlast one request).
//
// runTargetingDraft never throws. It reads the site (site.ts) or takes the pasted text, reads the
// served ICP so its hard stops are kept, checks the budget again, makes one model call with the
// fixed rubric as the whole system prompt and the site's text in the user turn, sanitized and fenced
// as untrusted exactly as web_fetch's output is,
// records the cost, filters every item (draft.ts) and stores the result. The working copy the
// editor opens holds the drafted items plus every served ICP `never` item, unchanged, so approving a
// draft never removes a hard stop the operator did not delete. Anything that goes wrong is a failed
// row with a plain reason; the operator can always write or paste the text themselves.
import { itemsOf, readServedBrain, type BrainItemInput, type BrainKv } from "../learning/brain-edit.ts";
import { tokenCostMicroCents } from "../budget/cost-ledger.ts";
import { checkBudget } from "../budget/gate.ts";
import type { GtmConfig } from "../config/schema.ts";
import type { FlagReader } from "../jobs/registry.ts";
import type { ModelGateway } from "../ports/model.ts";
import { sanitizeErrorMessage, sanitizeToolOutput } from "../security/sanitize.ts";
import { createSpendGate } from "../sourcing/spend.ts";
import { fetchableUrl } from "../tools/web-fetch.ts";
import { TARGETING_OUTPUT_SCHEMA, TARGETING_RUBRIC, filterDraft, parseDraftOutput, type DraftItem, type DroppedItem } from "./draft.ts";
import { TARGETING_DAILY_CENTS, TARGETING_JOB, isTargetingDraftEnabled, isTargetingEnabled, targetingDraftsDailyMax } from "./flags.ts";
import { SITE_TEXT_MAX_CHARS, SITE_TEXT_MIN_CHARS, readSite, type SitePage } from "./site.ts";
import { DRAFT_STUCK_MS, completeDraft, draftsStartedOn, failDraft, newDraftId, type DraftPage, type WorkingCopy } from "./store.ts";

/** The model role a draft runs on. */
export const TARGETING_ROLE = "worker" as const;

export interface TargetingDeps {
  db: D1Database;
  /** The brain's KV namespace: the served ICP's hard stops are read from it. */
  kv: BrainKv | undefined;
  flags: FlagReader;
  models: GtmConfig["models"];
  model: ModelGateway | undefined;
  /** The fetch the site is read with. Defaults to the global fetch. */
  fetch?: typeof fetch;
  now: () => Date;
  log?: { warn(msg: string, data?: Record<string, unknown>): void };
}

export interface DraftInput {
  url?: string;
  /** Text the operator pasted instead of a URL. Treated exactly like page text: untrusted. */
  text?: string;
  requestedBy: string;
}

export type StartResult = { ok: true; draftId: string; run: () => Promise<void> } | { ok: false; code: "unavailable" | "conflict" | "invalid"; reason: string };

/** Check every gate and claim the running slot. Throws only on a database error. */
export async function startTargetingDraft(deps: TargetingDeps, input: DraftInput): Promise<StartResult> {
  const refuse = (code: "unavailable" | "conflict" | "invalid", reason: string): StartResult => ({ ok: false, code, reason });
  if (!(await isTargetingEnabled(deps.flags))) return refuse("unavailable", "the Product and ICP page is off; set targeting:enabled to true");
  if (!(await isTargetingDraftEnabled(deps.flags))) return refuse("unavailable", "AI drafts are off; set targeting:draft_enabled to true, or write the text yourself");
  if (!deps.model) return refuse("unavailable", "no model gateway is configured for this deployment");
  const modelId = deps.models.roles[TARGETING_ROLE];
  const price = modelId ? deps.models.pricing[modelId] : undefined;
  try {
    tokenCostMicroCents({ inputTokens: 0, outputTokens: 0 }, price);
  } catch {
    return refuse("unavailable", `the ${TARGETING_ROLE} role needs a model in models.roles and its price in models.pricing`);
  }
  const hasUrl = typeof input.url === "string" && input.url.trim() !== "";
  const hasText = typeof input.text === "string" && input.text.trim() !== "";
  if (hasUrl === hasText) return refuse("invalid", "give either a URL or pasted text");
  let url: string | null = null;
  if (hasUrl) {
    try {
      url = fetchableUrl(input.url);
    } catch (error) {
      return refuse("invalid", error instanceof Error ? error.message : "the URL was refused");
    }
  } else if ((input.text ?? "").trim().length < SITE_TEXT_MIN_CHARS) {
    return refuse("invalid", `paste at least ${SITE_TEXT_MIN_CHARS} characters`);
  }
  const now = deps.now();
  const cap = await targetingDraftsDailyMax(deps.flags);
  if ((await draftsStartedOn(deps.db, now)) >= cap) return refuse("unavailable", `the daily limit of ${cap} drafts is reached (targeting:drafts_daily_max)`);
  const budget = await checkBudget({ db: deps.db, flags: deps.flags, now, job: TARGETING_JOB, jobCapCents: TARGETING_DAILY_CENTS });
  if (!budget.allowed) return refuse("unavailable", `spending is blocked: ${budget.message}`);
  const draftId = newDraftId();
  const at = now.toISOString();
  // One draft at a time, claimed in the same statement that checks it.
  const inserted = await deps.db
    .prepare(
      `INSERT INTO targeting_drafts (id, status, source, url, requested_by, started_at, created_at, updated_at)
       SELECT ?1, 'running', ?2, ?3, ?4, ?5, ?5, ?5
        WHERE NOT EXISTS (SELECT 1 FROM targeting_drafts WHERE status = 'running' AND started_at > ?6)`,
    )
    .bind(draftId, hasUrl ? "url" : "text", url, input.requestedBy.slice(0, 120), at, new Date(now.getTime() - DRAFT_STUCK_MS).toISOString())
    .run();
  if ((inserted.meta.changes ?? 0) === 0) return refuse("conflict", "a draft is already running; wait for it to finish");
  const pasted = hasText ? (input.text ?? "").slice(0, SITE_TEXT_MAX_CHARS) : null;
  return { ok: true, draftId, run: () => runTargetingDraft(deps, draftId, url, pasted) };
}

function asFields(item: DraftItem): BrainItemInput {
  return { id: item.id, fields: { kind: item.kind, text: item.text } };
}

/** The text the model reads, every page labelled. All of it is untrusted. */
function siteText(pages: readonly SitePage[]): string {
  return pages.map((p) => [`Page: ${p.url}`, ...(p.title ? [`Title: ${p.title}`] : []), "", p.text].join("\n")).join("\n\n");
}

/** Read, draft, filter and store. Never throws. */
export async function runTargetingDraft(deps: TargetingDeps, draftId: string, url: string | null, pasted: string | null): Promise<void> {
  const fail = async (reason: string, extra: { pages?: DraftPage[]; dropped?: DroppedItem[]; model?: string | null } = {}) => {
    try {
      await failDraft(deps.db, draftId, { reason, ...extra }, deps.now());
    } catch (error) {
      deps.log?.warn("a targeting draft's failure could not be recorded", { draftId, error: sanitizeErrorMessage(error) });
    }
  };
  try {
    let pages: SitePage[] = [];
    let skipped: Array<{ url: string; reason: string }> = [];
    let text: string;
    if (url !== null) {
      const site = await readSite(url, deps.fetch ? { fetch: deps.fetch } : {});
      if (!site.ok) return await fail(site.reason);
      pages = site.pages;
      skipped = site.skipped;
      text = siteText(pages);
    } else {
      text = pasted ?? "";
    }
    const stored = pages.map(({ url: u, title, bytes, sha256 }) => ({ url: u, title, bytes, sha256 }));

    // The served ICP's hard stops go into the working copy unchanged; without them, no draft.
    let hardStops: BrainItemInput[];
    try {
      if (!deps.kv) return await fail("the brain's KV namespace is not bound", { pages: stored });
      const served = await readServedBrain(deps.kv);
      const icp = served.files.get("icp.md");
      if (!icp && served.lock?.files["icp.md"] !== undefined) {
        return await fail("the served ICP does not match the brain's lock, so its hard stops could not be read; upload the brain again or wait a minute", { pages: stored });
      }
      hardStops = icp ? itemsOf(icp, "icp").filter((i) => i.fields.kind === "never") : [];
    } catch {
      return await fail("the served ICP could not be read, so its hard stops could not be kept; try again", { pages: stored });
    }

    const gate = createSpendGate({ db: deps.db, flags: deps.flags, job: TARGETING_JOB, jobCapCents: TARGETING_DAILY_CENTS, now: deps.now });
    if (!(await gate.allow())) return await fail(`spending is blocked (${gate.stopped ?? "budget"})`, { pages: stored });
    const modelId = deps.models.roles[TARGETING_ROLE] ?? "";
    const price = deps.models.pricing[modelId];
    if (!deps.model || !price) return await fail("the model is no longer configured", { pages: stored });
    let answer: string;
    let servedBy = modelId;
    try {
      const result = await deps.model.complete({
        role: TARGETING_ROLE,
        system: TARGETING_RUBRIC,
        messages: [{ role: "user", content: `Draft the product items and the ICP items from the website text below.\n\n${sanitizeToolOutput(text, { tool: "targeting_site", taint: "full" }).text}` }],
        jsonSchema: TARGETING_OUTPUT_SCHEMA,
        maxTokens: 6000,
        temperature: 0,
        metadata: { job: TARGETING_JOB, draft_id: draftId },
      });
      servedBy = result.model || modelId;
      await gate.recordModel({ provider: deps.model.name, model: servedBy, usage: result.usage, price: deps.models.pricing[servedBy] ?? price });
      answer = result.text;
    } catch (error) {
      return await fail(`the model call failed: ${sanitizeErrorMessage(error)}`, { pages: stored, model: modelId });
    }
    const output = parseDraftOutput(answer);
    if (!output) return await fail("the model's answer was not in the expected shape, so nothing was drafted; try again or write the text yourself", { pages: stored, model: servedBy });
    const filtered = filterDraft(output, text);
    if (filtered.product.length === 0 && filtered.icp.length === 0) {
      return await fail("nothing usable was drafted; see what was left out and why, or write the text yourself", { pages: stored, dropped: filtered.dropped, model: servedBy });
    }
    const taken = new Set(hardStops.map((h) => h.id));
    const icpItems = filtered.icp.map(asFields).map((item) => (taken.has(item.id) ? { ...item, id: `${item.id}-drafted` } : item));
    const working: WorkingCopy = { product: filtered.product.map(asFields), icp: [...icpItems, ...hardStops] };
    await completeDraft(deps.db, draftId, { pages: stored, skipped, draft: { product: filtered.product, icp: filtered.icp }, dropped: filtered.dropped, working, model: servedBy }, deps.now());
  } catch (error) {
    await fail(`the draft failed: ${sanitizeErrorMessage(error)}`);
  }
}
