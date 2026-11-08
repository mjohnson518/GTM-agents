// GTM-agents: taint across delegation.
//
// Without these rules a tainted agent could act through a clean one (a confused deputy):
//   - down: a worker starts at its caller's taint (childStartTaint);
//   - up: the caller ends at the higher of its own taint and the worker's final taint
//     (returnTaint).
// The dispatcher applies the upward rule to the taint a delegation handler reports. When a result
// has to travel as plain text (a stored transcript, a resumed run), the worker's taint travels with
// it as a marker. Reading markers is escalate-only: a marker can raise the caller's taint and never
// lower it, so text that forges or strips a marker can at worst make the caller stricter.
import { maxTaintLevel, toTaintLevel, type TaintLevel } from "./taint.ts";

/** The taint a delegated worker starts at. */
export function childStartTaint(parentTaint: TaintLevel): TaintLevel {
  return toTaintLevel(parentTaint);
}

/** The caller's taint after a delegation returns. */
export function returnTaint(parentTaint: TaintLevel, childTaint: TaintLevel): TaintLevel {
  return maxTaintLevel(parentTaint, childTaint);
}

const MARKER = /\[delegation-taint:(none|metadata|structured|full)\]/g;

/** The marker appended to a delegation result. Empty for "none". */
export function formatTaintMarker(level: TaintLevel): string {
  return level === "none" ? "" : `\n\n[delegation-taint:${toTaintLevel(level)}]`;
}

/** The highest taint marked anywhere in `text`, or "none". */
export function readTaintMarker(text: string): TaintLevel {
  let level: TaintLevel = "none";
  for (const m of text.matchAll(MARKER)) level = maxTaintLevel(level, toTaintLevel(m[1]));
  return level;
}

/**
 * Re-append the raw result's marker if sanitizing (a truncated tail, a redaction) dropped or
 * lowered it. Never removes or lowers a marker.
 */
export function preserveTaintMarker(raw: string, sanitized: string): string {
  const rawLevel = readTaintMarker(raw);
  const kept = readTaintMarker(sanitized);
  if (maxTaintLevel(kept, rawLevel) === kept) return sanitized;
  return sanitized + formatTaintMarker(rawLevel);
}
