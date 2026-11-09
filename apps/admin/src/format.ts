// GTM-agents: formatting and URL checks for the dashboard. Every value the server sends is shown
// as text; the only links built from server data are https URLs that pass `safeHttpsUrl`.

const MISSING = "none";

export function formatNumber(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** Provider costs are recorded in US cents. */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return MISSING;
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A rate between 0 and 1 as a percentage; a missing rate reads "n/a", never 0%. */
export function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "n/a";
  return `${(rate * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return MISSING;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatRelative(value: string | null | undefined, now = Date.now()): string {
  if (!value) return MISSING;
  const at = new Date(value).getTime();
  if (Number.isNaN(at)) return value;
  const seconds = Math.round((now - at) / 1000);
  const future = seconds < 0;
  const abs = Math.abs(seconds);
  const [amount, unit] =
    abs < 60 ? [abs, "s"] : abs < 3600 ? [Math.floor(abs / 60), "m"] : abs < 86_400 ? [Math.floor(abs / 3600), "h"] : [Math.floor(abs / 86_400), "d"];
  if (abs < 5) return "just now";
  return future ? `in ${amount}${unit}` : `${amount}${unit} ago`;
}

/** The leading characters of a digest, enough to compare by eye. */
export function shortDigest(digest: string): string {
  return digest.length > 12 ? `${digest.slice(0, 12)}...` : digest;
}

/** "coldPause" and "sent_7d" become "Cold pause" and "Sent 7d". */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_\-.:]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return spaced ? spaced[0]!.toUpperCase() + spaced.slice(1) : key;
}

/**
 * Returns a normalized https URL when the value is one, or null. Anything else (javascript:, data:,
 * http:, credentials in the URL, whitespace or control characters) is refused, so a link is only
 * ever built from a URL that passed this check.
 */
export function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x5c) return null;
  }
  if (/\s/.test(value)) return null;
  if (!value.toLowerCase().startsWith("https://")) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
  return url.href;
}

/** A date input value (YYYY-MM-DD) for `daysAgo` days before `now`, in UTC. */
export function isoDay(now: Date, daysAgo = 0): string {
  const date = new Date(now.getTime() - daysAgo * 86_400_000);
  return date.toISOString().slice(0, 10);
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong.";
}
