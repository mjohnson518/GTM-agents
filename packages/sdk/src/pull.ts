// GTM-agents SDK: the signed read endpoints a host serves for the agent's nightly reconciliation
// (pull, agent to host).
//
// The agent signs every read with PRODUCT_READ_SECRET over a canonical string:
//
//   METHOD + "\n" + PATH + "\n" + SORTED_QUERY + "\n" + TIMESTAMP
//
// where SORTED_QUERY is the query string with its keys sorted bytewise and its values left
// percent-encoded exactly as sent. The host verifies the signature in constant time, refuses a
// timestamp more than 5 minutes from now, and returns only the contract's whitelisted fields.
// These endpoints are the one deliberately cross-tenant read path in the host: serve them from a
// dedicated query, and never let end-user credentials reach them.
import { hmacSha256Hex, timingSafeEqual } from "./crypto.ts";

export const TIMESTAMP_HEADER = "X-Timestamp";
export const READ_SIGNATURE_HEADER = "X-Signature";
/** A read signed further than this from the host's clock is refused. */
export const READ_TOLERANCE_SECONDS = 300;
/** The largest page the agent asks for, and the most a read handler returns. */
export const MAX_READ_LIMIT = 200;
/** Where the agent expects the three read endpoints, under PRODUCT_APP_URL. */
export const READ_BASE_PATH = "/api/internal/gtm";

const encoder = new TextEncoder();

function compareBytes(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** The query string (with or without its "?") with keys sorted bytewise, values untouched. */
export function sortedQuery(search: string): string {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const key = (pair: string) => {
    const eq = pair.indexOf("=");
    return eq < 0 ? pair : pair.slice(0, eq);
  };
  return raw
    .split("&")
    .filter((pair) => pair.length > 0)
    .map((pair, index) => ({ pair, index }))
    .sort((a, b) => compareBytes(key(a.pair), key(b.pair)) || a.index - b.index)
    .map((p) => p.pair)
    .join("&");
}

/** The canonical string a read is signed over. `url` is the full URL as requested. */
export function readCanonical(method: string, url: string | URL, timestamp: number | string): string {
  const u = typeof url === "string" ? new URL(url) : url;
  return [method.toUpperCase(), u.pathname, sortedQuery(u.search), String(timestamp)].join("\n");
}

/** The two headers a signed read carries. The agent produces these; hosts use it in their tests. */
export async function signRead(input: { secret: string; method: string; url: string | URL; timestamp: number }): Promise<Record<string, string>> {
  const signature = await hmacSha256Hex(input.secret, readCanonical(input.method, input.url, input.timestamp));
  return { [TIMESTAMP_HEADER]: String(input.timestamp), [READ_SIGNATURE_HEADER]: `sha256=${signature}` };
}

export type ReadVerification = { ok: true } | { ok: false; reason: "not_configured" | "missing" | "stale" | "bad_signature" };

/** Verify a signed read: a fresh timestamp and a signature that matches, compared in constant time. */
export async function verifyReadSignature(input: {
  secret: string | undefined | null;
  method: string;
  url: string | URL;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  now?: Date;
  toleranceSeconds?: number;
}): Promise<ReadVerification> {
  if (typeof input.secret !== "string" || input.secret.length === 0) return { ok: false, reason: "not_configured" };
  const timestamp = (input.timestamp ?? "").trim();
  const signature = (input.signature ?? "").trim().toLowerCase();
  if (!/^\d{1,12}$/.test(timestamp) || !signature.startsWith("sha256=")) return { ok: false, reason: "missing" };
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - Number(timestamp)) > (input.toleranceSeconds ?? READ_TOLERANCE_SECONDS)) return { ok: false, reason: "stale" };
  const expected = `sha256=${await hmacSha256Hex(input.secret, readCanonical(input.method, input.url, timestamp))}`;
  return (await timingSafeEqual(signature, expected)) ? { ok: true } : { ok: false, reason: "bad_signature" };
}

/** verifyReadSignature for a standard Request. */
export function verifyReadRequest(request: Request, secret: string | undefined | null, options: { now?: Date; toleranceSeconds?: number } = {}): Promise<ReadVerification> {
  return verifyReadSignature({
    secret,
    method: request.method,
    url: request.url,
    timestamp: request.headers.get(TIMESTAMP_HEADER),
    signature: request.headers.get(READ_SIGNATURE_HEADER),
    ...options,
  });
}

// The field whitelists. Anything outside them is never returned, however convenient; widening a
// list is a change to the contract.

export interface UserItem {
  id: string;
  email: string;
  name?: string | null;
  role?: string | null;
  created_at: string;
  updated_at: string;
  signup_ref?: string | null;
  org?: {
    id: string;
    name?: string | null;
    domain?: string | null;
    plan_tier?: string | null;
    usage_this_period?: number | null;
    flags?: { founding?: boolean; whitelisted?: boolean };
  } | null;
}

export interface FeedbackItem {
  id: string;
  created_at: string;
  author_email?: string | null;
  author_name?: string | null;
  context?: string | null;
  text: string;
  rating?: number | null;
}

export interface DeletionItem {
  user_id: string;
  email_sha256: string;
  deleted_at: string;
}

type Row = Record<string, unknown>;

function pick(row: Row, keys: readonly string[], kinds: readonly ("string" | "number" | "boolean")[]): Row {
  const out: Row = {};
  for (const key of keys) {
    if (!Object.hasOwn(row, key)) continue;
    const value = row[key];
    if (value === null || kinds.includes(typeof value as "string" | "number" | "boolean")) out[key] = value;
  }
  return out;
}

const STRING = ["string"] as const;

/** A users row cut down to the whitelist. Extra fields, however named, are dropped. */
export function toUserItem(row: Row): UserItem {
  const out = pick(row, ["id", "email", "name", "role", "created_at", "updated_at", "signup_ref"], STRING);
  const org = row.org;
  if (org && typeof org === "object" && !Array.isArray(org)) {
    const o = org as Row;
    const cut: Row = { ...pick(o, ["id", "name", "domain", "plan_tier"], STRING), ...pick(o, ["usage_this_period"], ["number"]) };
    if (o.flags && typeof o.flags === "object" && !Array.isArray(o.flags)) cut.flags = pick(o.flags as Row, ["founding", "whitelisted"], ["boolean"]);
    out.org = cut;
  } else if (org === null) out.org = null;
  return out as unknown as UserItem;
}

/** A feedback row cut down to the whitelist. */
export function toFeedbackItem(row: Row): FeedbackItem {
  return { ...pick(row, ["id", "created_at", "author_email", "author_name", "context", "text"], STRING), ...pick(row, ["rating"], ["number"]) } as unknown as FeedbackItem;
}

/** A deletion row cut down to the whitelist. */
export function toDeletionItem(row: Row): DeletionItem {
  return pick(row, ["user_id", "email_sha256", "deleted_at"], STRING) as unknown as DeletionItem;
}

export interface ReadQuery {
  /** ISO 8601. Users filter on updated_at, feedback on created_at, deletions on deleted_at. Null for a full read. */
  since: string | null;
  /** The last id of the previous page, or null for the first page. */
  cursor: string | null;
  /** At most MAX_READ_LIMIT. */
  limit: number;
}

/** One page, ordered by the `since` column then id. `hasMore` defaults to "the page is full". */
export interface ReadPage<T> {
  items: T[];
  hasMore?: boolean;
}

export interface ReadHandlerOptions {
  /** PRODUCT_READ_SECRET. Unset: every read answers 503. */
  secret: string | undefined | null;
  users?: (query: ReadQuery) => Promise<ReadPage<Row>>;
  feedback?: (query: ReadQuery) => Promise<ReadPage<Row>>;
  deletions?: (query: ReadQuery) => Promise<ReadPage<Row>>;
  /** Defaults to READ_BASE_PATH. */
  basePath?: string;
  now?: () => Date;
}

const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/**
 * A fetch-style handler for the three read endpoints. Mount it on `${basePath}/*` in any framework
 * that hands you a standard Request. It verifies the signature before calling a loader, validates
 * the query, and cuts every item down to its whitelist.
 */
export function createReadHandler(options: ReadHandlerOptions): (request: Request) => Promise<Response> {
  const base = (options.basePath ?? READ_BASE_PATH).replace(/\/+$/, "");
  const resources = {
    users: { load: options.users, cut: toUserItem, idOf: (i: Row) => i.id },
    feedback: { load: options.feedback, cut: toFeedbackItem, idOf: (i: Row) => i.id },
    deletions: { load: options.deletions, cut: toDeletionItem, idOf: (i: Row) => i.user_id },
  } as const;
  return async (request) => {
    if (typeof options.secret !== "string" || options.secret.length === 0) return json({ error: "not_configured" }, 503);
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    const verified = await verifyReadRequest(request, options.secret, options.now ? { now: options.now() } : {});
    if (!verified.ok) return json({ error: "unauthorized" }, 401);
    const url = new URL(request.url);
    const name = url.pathname.startsWith(`${base}/`) ? url.pathname.slice(base.length + 1) : "";
    const resource = name === "users" || name === "feedback" || name === "deletions" ? resources[name] : undefined;
    if (!resource?.load) return json({ error: "not_found" }, 404);
    const since = url.searchParams.get("since");
    const cursor = url.searchParams.get("cursor");
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw === null ? MAX_READ_LIMIT : Number(limitRaw);
    if ((since !== null && Number.isNaN(Date.parse(since))) || (cursor !== null && (cursor.length === 0 || cursor.length > 256)) || !Number.isInteger(limit) || limit < 1) {
      return json({ error: "bad_query" }, 400);
    }
    const query: ReadQuery = { since, cursor, limit: Math.min(limit, MAX_READ_LIMIT) };
    let page: ReadPage<Row>;
    try {
      page = await resource.load(query);
    } catch {
      return json({ error: "read_failed" }, 500);
    }
    const items = (Array.isArray(page?.items) ? page.items : []).slice(0, query.limit).map((row) => resource.cut(row) as unknown as Row);
    const more = page.hasMore ?? items.length >= query.limit;
    const last = items.at(-1);
    const next = more && last ? resource.idOf(last) : undefined;
    return json(typeof next === "string" ? { items, cursor: next } : { items }, 200);
  };
}
