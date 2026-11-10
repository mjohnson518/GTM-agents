// GTM-agents: small helpers the ship loop's planning side shares: ids, hashing, a constant-time
// comparison, factory calls that treat a throw as "not configured", and the theme statuses that
// still take new feedback.

/** Theme statuses that still take new feedback: everything that is not shipped, declined or failed. */
export const LIVE_THEME_STATUSES = ["open", "spec_ready", "approved", "building", "pr_open", "merged"] as const;
export const LIVE_THEME_SQL = LIVE_THEME_STATUSES.map((s) => `'${s}'`).join(", ");

/** `n` random lowercase hex characters. */
export function hexId(n: number): string {
  const bytes = new Uint8Array(Math.ceil(n / 2));
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, n);
}

/** A theme or note id: 10 hex characters, the form the chat commands carry. */
export const shortId = (): string => hexId(10);

/** Lowercase hex SHA-256 of the UTF-8 text. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compare two strings in time that does not depend on where they differ. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Build from a factory, treating a throw (a missing secret, bad options) as "not configured". */
export function tryBuild<E, T>(factory: ((env: E) => T | undefined) | undefined, env: E): T | undefined {
  try {
    return factory?.(env) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Text for an operator message: one line, capped. Pure. */
export function oneLine(text: string | null | undefined, max = 160): string {
  const out = (text ?? "").replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max - 3).trimEnd()}...` : out;
}

/** Cents as dollars for operator messages: 4900 gives "$49.00". Pure. */
export const dollars = (cents: number): string => `$${(Math.max(0, cents) / 100).toFixed(2)}`;
