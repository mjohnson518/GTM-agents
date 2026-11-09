// GTM-agents: the nightly pull from the product (docs/EVENT-CONTRACT.md, section 2), the repair
// path for a push that never arrived.
//
// Three signed GETs under PRODUCT_APP_URL, in this order, each paged by the host's cursor:
//   1. deletions first, so nothing below can touch a person erased in the product: each one runs
//      the same erasure as user.deleted (erasure.ts), tombstone first;
//   2. users: a user the agent never saw signed up is resolved and signed up (with the attribution
//      their signup_ref carries); one whose org shows usage this period while still signed up or
//      stalled is activated; the org and plan are kept. Erased people are refused before anything
//      is written;
//   3. feedback: filed for the ship loop as full-taint text, only when its author is an existing
//      contact (matched by address, never created), so an erasure always finds it; recognized when
//      the push already filed it.
// High-water marks: each resource keeps {since, cursor, high, done, fullAt} in KV. A pass reads
// `since` the last completed pass's mark; its pages follow the host's cursor; after every page the
// state is saved, so a pass longer than the per-run page cap continues the next night where it
// stopped, and a mark only advances once the pass that reached it has finished. Once a week a pass
// starts from nothing (a full re-read), because a host may change a row without moving updated_at.
// Each run reads at most LIFECYCLE_LIMITS.pullPages pages of pullPageSize per resource. One bad row
// is counted and skipped; a read that fails stops that resource for the night. No model calls.
import type { LifecycleState } from "../data/enums.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import { applyLifecycleEvent } from "../lifecycle/apply.ts";
import { LIFECYCLE_FLAGS, LIFECYCLE_LIMITS, pullStateKey } from "../lifecycle/flags.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { readSwitch } from "../sending/flags.ts";
import { addressHash, mailboxOf, normalizeAddress } from "../sending/suppression.ts";
import type { KvStore } from "../shared/kv.ts";
import { count, label } from "./envelope.ts";
import { eraseIfTombstoned, eraseProductUser } from "./erasure.ts";
import { fileFeedback } from "./feedback.ts";
import { isErased, resolveProductUser } from "./identity.ts";
import { readSignatureHeaders } from "./signature.ts";

export const READ_PATHS = Object.freeze({ users: "/api/internal/gtm/users", feedback: "/api/internal/gtm/feedback", deletions: "/api/internal/gtm/deletions" });
export type PullResource = keyof typeof READ_PATHS;

export interface PullState {
  since: string | null;
  cursor: string | null;
  high: string | null;
  done: string | null;
  fullAt: string | null;
}

export interface ReconcileDeps {
  db: D1Database;
  kv: KvStore | undefined | null;
  bucket: R2Bucket | undefined | null;
  appUrl: string | undefined;
  readSecret: string | undefined;
  flags: FlagReader;
  now: Date;
  log: JobLogger;
  fetch: typeof fetch;
  signal?: AbortSignal;
  /** Smaller pages or fewer of them (never more than LIFECYCLE_LIMITS allows), for a host with tighter limits. */
  limits?: { pages?: number; pageSize?: number };
  /** Read only these resources (deletions alone while the lifecycle is off). Defaults to all three. */
  only?: readonly PullResource[];
}

export interface ReconcileReport {
  status: "skipped" | "ok" | "partial";
  reason?: string;
  rows: number;
  deletions: number;
  signups: number;
  activations: number;
  feedback: number;
  refused: number;
  recordErrors: number;
  errors: string[];
}

const empty = (): ReconcileReport => ({ status: "ok", rows: 0, deletions: 0, signups: 0, activations: 0, feedback: 0, refused: 0, recordErrors: 0, errors: [] });
const fresh = (): PullState => ({ since: null, cursor: null, high: null, done: null, fullAt: null });
const str = (value: unknown, max = 300): string | null => (typeof value === "string" && value.length > 0 ? value.slice(0, max) : null);
const iso = (value: unknown): string | null => (typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null);

const pageSize = (deps: Pick<ReconcileDeps, "limits">): number => Math.max(1, Math.min(LIFECYCLE_LIMITS.pullPageSize, Math.floor(deps.limits?.pageSize ?? LIFECYCLE_LIMITS.pullPageSize)));

/** PRODUCT_APP_URL as a base for reads: https only, no credentials, no query. Null otherwise. Pure. */
export function readBase(appUrl: string | undefined): URL | null {
  if (typeof appUrl !== "string" || appUrl.trim().length === 0) return null;
  try {
    const url = new URL(appUrl.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

async function loadState(kv: KvStore | undefined | null, resource: PullResource): Promise<PullState> {
  try {
    const raw = kv ? await kv.get(pullStateKey(resource)) : null;
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== "object") return fresh();
    const v = value as Record<string, unknown>;
    return { since: iso(v.since), cursor: str(v.cursor, 256), high: iso(v.high), done: iso(v.done), fullAt: iso(v.fullAt) };
  } catch {
    // A rebuildable cache: unreadable means a full read.
    return fresh();
  }
}

async function saveState(kv: KvStore | undefined | null, resource: PullResource, state: PullState): Promise<void> {
  if (!kv) throw new Error("the KV binding is missing; the pull cannot keep its place");
  await kv.put(pullStateKey(resource), JSON.stringify(state));
}

/** One signed read. Throws on a network error, a non-200, an oversized body or a body without items. */
async function readPage(deps: ReconcileDeps, base: URL, resource: PullResource, query: { since: string | null; cursor: string | null }): Promise<{ items: Record<string, unknown>[]; cursor: string | null }> {
  const url = new URL(base.toString());
  url.pathname = `${base.pathname.replace(/\/+$/, "")}${READ_PATHS[resource]}`;
  const params = new URLSearchParams();
  if (query.since) params.set("since", query.since);
  if (query.cursor) params.set("cursor", query.cursor);
  params.set("limit", String(pageSize(deps)));
  url.search = params.toString();
  const headers = await readSignatureHeaders({ secret: deps.readSecret ?? "", method: "GET", url, timestamp: Math.floor(Date.now() / 1000) });
  const response = await deps.fetch(url.toString(), { method: "GET", headers: { ...headers, Accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(LIFECYCLE_LIMITS.pullTimeoutMs) });
  if (response.status !== 200) throw new Error(`the ${resource} read answered ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > LIFECYCLE_LIMITS.pullMaxBytes) throw new Error(`the ${resource} read is larger than ${LIFECYCLE_LIMITS.pullMaxBytes} bytes`);
  const text = await response.text();
  if (text.length > LIFECYCLE_LIMITS.pullMaxBytes) throw new Error(`the ${resource} read is larger than ${LIFECYCLE_LIMITS.pullMaxBytes} bytes`);
  const body: unknown = JSON.parse(text);
  const items = body && typeof body === "object" ? (body as { items?: unknown }).items : undefined;
  if (!Array.isArray(items)) throw new Error(`the ${resource} read has no items`);
  return {
    items: items.slice(0, pageSize(deps)).filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null && !Array.isArray(i)),
    cursor: str((body as { cursor?: unknown }).cursor, 256),
  };
}

/**
 * `strict`: a row that fails stops the pass before its page is saved, so the next run reads that
 * page again instead of passing the row by (deletions: an erasure is never skipped).
 */
async function drain(deps: ReconcileDeps, base: URL, resource: PullResource, stampOf: (item: Record<string, unknown>) => string | null, handle: (item: Record<string, unknown>) => Promise<void>, report: ReconcileReport, strict = false): Promise<void> {
  const state = await loadState(deps.kv, resource);
  if (state.cursor === null) {
    const fullDue = state.fullAt === null || deps.now.getTime() - Date.parse(state.fullAt) > LIFECYCLE_LIMITS.fullReadDays * 86_400_000;
    state.since = fullDue ? null : state.done;
    state.high = state.done;
    if (fullDue) state.fullAt = deps.now.toISOString();
  }
  const pages = Math.max(1, Math.min(LIFECYCLE_LIMITS.pullPages, Math.floor(deps.limits?.pages ?? LIFECYCLE_LIMITS.pullPages)));
  for (let page = 0; page < pages; page++) {
    if (deps.signal?.aborted) return;
    const result = await readPage(deps, base, resource, { since: state.since, cursor: state.cursor });
    for (const item of result.items) {
      report.rows += 1;
      try {
        await handle(item);
      } catch (error) {
        report.recordErrors += 1;
        if (report.errors.length < 10) report.errors.push(`${resource} row: ${sanitizeErrorMessage(error)}`);
        if (strict) throw new Error(`a ${resource} row failed; the pass resumes from this page next run`, { cause: error });
      }
      const stamp = stampOf(item);
      if (stamp && (state.high === null || stamp > state.high)) state.high = stamp;
    }
    if (result.cursor && result.items.length > 0) {
      state.cursor = result.cursor;
      await saveState(deps.kv, resource, state);
      continue;
    }
    // The pass is complete: its mark becomes the next pass's since.
    state.cursor = null;
    state.done = state.high;
    await saveState(deps.kv, resource, state);
    return;
  }
}

/** The pull. Never throws; what failed is in the report. */
export async function reconcileProduct(deps: ReconcileDeps): Promise<ReconcileReport> {
  const report = empty();
  const base = readBase(deps.appUrl);
  if (!base || !deps.readSecret) return { ...report, status: "skipped", reason: "PRODUCT_APP_URL (https) and PRODUCT_READ_SECRET are not both set" };
  const { db, now } = deps;
  const lifecycle = { db, now };
  const refTokens = await readSwitch(deps.flags, LIFECYCLE_FLAGS.refTokens);

  const steps: Array<[PullResource, () => Promise<void>]> = [
    [
      "deletions",
      () =>
        drain(deps, base, "deletions", (d) => iso(d.deleted_at), async (d) => {
          const userId = str(d.user_id, 128);
          const hash = typeof d.email_sha256 === "string" && /^[0-9a-f]{64}$/.test(d.email_sha256) ? d.email_sha256 : null;
          if (!userId || !hash) throw new Error("a deletion needs user_id and email_sha256");
          await eraseProductUser({ db, bucket: deps.bucket, now }, { userId, emailSha256: hash, erasedAt: iso(d.deleted_at) ?? now.toISOString(), eventKey: `pull:deletions:${userId}`, source: "reconciliation" });
          report.deletions += 1;
        }, report, true),
    ],
    [
      "users",
      () =>
        drain(deps, base, "users", (u) => iso(u.updated_at), async (u) => {
          const userId = str(u.id, 128);
          const email = str(u.email, 254);
          if (!userId || !email) throw new Error("a user needs id and email");
          const ref = typeof u.signup_ref === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(u.signup_ref) ? u.signup_ref : null;
          const resolved = await resolveProductUser(db, { userId, email, name: str(u.name, 200), ref }, { now, refTokens });
          if (resolved.kind === "erased") {
            report.refused += 1;
            return;
          }
          if (resolved.kind === "skipped") throw new Error(resolved.reason);
          const org = u.org && typeof u.org === "object" && !Array.isArray(u.org) ? (u.org as Record<string, unknown>) : null;
          const usage = count(org?.usage_this_period);
          const stateOf = async () => ((await db.prepare("SELECT state FROM contact_lifecycle WHERE contact_id = ?1").bind(resolved.contactId).first<{ state: LifecycleState }>())?.state ?? null);
          const updatedAt = iso(u.updated_at) ?? now.toISOString();
          // Always applied (once per user), so a retry finishes the side effects an earlier run left undone.
          {
            const attribution = resolved.method === "linked" ? {} : { attribution_method: resolved.method, attributed_campaign_id: resolved.campaignId, ...(ref ? { signup_ref: ref } : {}) };
            const signup = await applyLifecycleEvent(lifecycle, resolved.contactId, { kind: "signed_up" }, {
              eventKey: `pull:users:${userId}:signup`,
              occurredAt: iso(u.created_at) ?? updatedAt,
              source: "product",
              patch: { product_user_id: userId, ...attribution },
            });
            if (signup.applied && signup.to === "signed_up") report.signups += 1;
            if (signup.effectsFailed.length > 0) throw new Error(`side effects did not finish (${signup.effectsFailed.join(", ")})`);
          }
          const after = await stateOf();
          if (usage !== null && usage > 0 && (after === "signed_up" || after === "stalled")) {
            const activated = await applyLifecycleEvent(lifecycle, resolved.contactId, { kind: "activated" }, { eventKey: `pull:users:${userId}:activated`, occurredAt: updatedAt, source: "product" });
            if (activated.applied && activated.to === "activated") report.activations += 1;
            if (activated.effectsFailed.length > 0) throw new Error(`side effects did not finish (${activated.effectsFailed.join(", ")})`);
          }
          await applyLifecycleEvent(lifecycle, resolved.contactId, null, {
            eventKey: `pull:users:${userId}:${updatedAt}`,
            occurredAt: updatedAt,
            source: "product",
            patch: {
              product_user_id: userId,
              ...(str(org?.id, 128) ? { product_org_id: str(org?.id, 128) } : {}),
              ...(label(org?.plan_tier) ? { plan_tier: label(org?.plan_tier) } : {}),
              ...(usage !== null ? { usage: { usage_this_period: usage } } : {}),
            },
          });
          if (await eraseIfTombstoned({ db, bucket: deps.bucket, now }, { contactId: resolved.contactId, userId, source: "reconciliation" })) report.refused += 1;
        }, report),
    ],
    [
      "feedback",
      () =>
        drain(deps, base, "feedback", (f) => iso(f.created_at), async (f) => {
          const text = str(f.text, 4000);
          const address = normalizeAddress(f.author_email);
          if (!text || !address) return;
          const exact = await addressHash(address);
          const mailbox = await addressHash(mailboxOf(address));
          if (await isErased(db, { emailSha256: exact, mailboxSha256: mailbox })) {
            report.refused += 1;
            return;
          }
          // Only for an author who is a contact: the row then goes with the contact in an erasure. A
          // stranger's words would be kept with nothing that could find them again.
          const contact = await db.prepare("SELECT id FROM contacts WHERE email_sha256 = ?1 OR mailbox_sha256 = ?2 ORDER BY (email_sha256 = ?1) DESC LIMIT 1").bind(exact, mailbox).first<{ id: string }>();
          if (!contact) return;
          if (await fileFeedback(db, { text, authorSha256: exact, productUserId: null, contactId: contact.id, createdAt: iso(f.created_at) ?? now.toISOString() })) report.feedback += 1;
        }, report),
    ],
  ];
  for (const [name, step] of steps) {
    if (deps.signal?.aborted) break;
    if (deps.only && !deps.only.includes(name)) continue;
    try {
      await step();
    } catch (error) {
      report.status = "partial";
      report.errors.push(`${name}: ${sanitizeErrorMessage(error)}`);
      deps.log.warn("a pull step failed; it resumes from its saved place next run", { step: name, error: sanitizeErrorMessage(error) });
      // Deletions come first so nothing after them can touch an erased person: without them, stop.
      if (name === "deletions") break;
    }
  }
  if (report.recordErrors > 0) report.status = "partial";
  return report;
}
