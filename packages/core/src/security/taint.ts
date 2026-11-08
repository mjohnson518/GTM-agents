// GTM-agents: taint levels, and the only way to combine them.
//
// A session's taint records the least trusted text it has read so far:
//   none        only the deployment's own data
//   metadata    short third-party text: subjects, snippets, search results, provider lookups
//   structured  typed values that a validating extractor pulled out of untrusted text
//   full        raw untrusted text: web pages, inbound email bodies, product feedback
//
// Taint only rises within a session. Combine levels with maxTaintLevel and raise a session with
// raiseTaint; never compare levels by hand. A value that is not a known level counts as "full", so
// a corrupted or misspelled level can only make the system stricter.
import { GATE_LEVELS, type GateLevel } from "../ports/manifest-schema.ts";
import { TAINT_LEVELS, type TaintLevel } from "../ports/types.ts";

export { GATE_LEVELS, TAINT_LEVELS };
export type { GateLevel, TaintLevel };

const RANK: ReadonlyMap<string, number> = new Map(TAINT_LEVELS.map((level, i) => [level, i]));
const FULL_RANK = TAINT_LEVELS.length - 1;

export function isTaintLevel(value: unknown): value is TaintLevel {
  return typeof value === "string" && RANK.has(value);
}

/** A known taint level, or "full" for anything else. */
export function toTaintLevel(value: unknown): TaintLevel {
  return isTaintLevel(value) ? value : "full";
}

function rank(level: unknown): number {
  return typeof level === "string" ? (RANK.get(level) ?? FULL_RANK) : FULL_RANK;
}

/** The highest of the given levels. With no arguments, "none". */
export function maxTaintLevel(...levels: TaintLevel[]): TaintLevel {
  let best = 0;
  for (const level of levels) best = Math.max(best, rank(level));
  return TAINT_LEVELS[best] ?? "full";
}

/** True when a tool whose gate is `gate` is refused in a session at `taint`. */
export function isRefusedAt(gate: GateLevel, taint: TaintLevel): boolean {
  if (gate === "never") return false;
  // An unknown gate value is read as "metadata": refused once anything untrusted has been read.
  const threshold = gate === "structured" || gate === "full" ? rank(gate) : rank("metadata");
  return rank(taint) >= threshold;
}

/** The mutable part of a session that the taint model owns. */
export interface TaintedSession {
  taint: TaintLevel;
}

/** Raise a session's taint to at least `level`. Never lowers it. Returns the new level. */
export function raiseTaint(session: TaintedSession, level: TaintLevel): TaintLevel {
  session.taint = maxTaintLevel(session.taint, level);
  return session.taint;
}
