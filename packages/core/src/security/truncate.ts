// GTM-agents: head-plus-tail text capping.
//
// Long tool output usually keeps its conclusion at the end: a research summary, a build log's
// error, a document's findings. Capping keeps both ends and states, in place, how much was dropped
// from the middle, so a reader can tell that material is missing. Cuts never split a UTF-16
// surrogate pair.

export interface CapResult {
  text: string;
  /** True when anything was dropped. */
  truncated: boolean;
}

/** Below this budget the middle-dropped notice would crowd out the text, so the cut is head-only. */
const MIN_HEAD_TAIL_BUDGET = 240;
const DEFAULT_TAIL_SHARE = 0.25;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The first `n` UTF-16 units of `text`, one shorter if the cut would split a surrogate pair. */
export function headSlice(text: string, n: number): string {
  if (n <= 0) return "";
  if (text.length <= n) return text;
  return isHighSurrogate(text.charCodeAt(n - 1)) ? text.slice(0, n - 1) : text.slice(0, n);
}

/** The last `n` UTF-16 units of `text`, one shorter if the cut would split a surrogate pair. */
export function tailSlice(text: string, n: number): string {
  if (n <= 0) return "";
  if (text.length <= n) return text;
  const start = text.length - n;
  return isLowSurrogate(text.charCodeAt(start)) ? text.slice(start + 1) : text.slice(start);
}

/**
 * Cap `text` at `maxChars` UTF-16 units, notice included. Keeps the head and `tailChars` from the
 * end (a quarter of the budget by default). The result is never longer than `maxChars`.
 */
export function capText(text: string, maxChars: number, tailChars?: number): CapResult {
  if (maxChars <= 0) return { text: "", truncated: text.length > 0 };
  if (text.length <= maxChars) return { text, truncated: false };

  if (maxChars < MIN_HEAD_TAIL_BUDGET) {
    const marker = " [truncated]";
    if (maxChars <= marker.length) return { text: headSlice(text, maxChars), truncated: true };
    return { text: headSlice(text, maxChars - marker.length) + marker, truncated: true };
  }

  // The dropped count never has more digits than the full length, so sizing the notice with the
  // full length keeps the result within the budget.
  const notice = (dropped: number) => `\n\n[truncated: ${dropped} of ${text.length} characters dropped from the middle]\n\n`;
  const room = Math.max(0, maxChars - notice(text.length).length);
  const wantedTail = tailChars ?? Math.floor(maxChars * DEFAULT_TAIL_SHARE);
  const tail = tailSlice(text, Math.max(0, Math.min(wantedTail, Math.floor(room / 2))));
  const head = headSlice(text, room - tail.length);
  return { text: head + notice(text.length - head.length - tail.length) + tail, truncated: true };
}
