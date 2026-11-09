// GTM-agents: the time windows every metric is computed over.
//
// A window is half-open, [from, to), in ISO 8601 UTC text, so it compares correctly with the
// database's timestamps as strings. Every metric function takes one, and every report builds its
// windows with these helpers, so two reports asking about "the last 7 days" ask about exactly the
// same instants.

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

export interface MetricWindow {
  /** Inclusive start, ISO 8601 UTC. */
  from: string;
  /** Exclusive end, ISO 8601 UTC. */
  to: string;
}

/** The window [from, to). Throws when either end is not a valid time or the window runs backwards. */
export function metricWindow(from: Date, to: Date): MetricWindow {
  const f = from.getTime();
  const t = to.getTime();
  if (!Number.isFinite(f) || !Number.isFinite(t)) throw new Error("a metric window needs two valid times");
  if (t < f) throw new Error("a metric window cannot end before it starts");
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Midnight UTC at the start of `now`'s day. */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The `days` before `end`: [end - days, end). */
export function daysBefore(end: Date, days: number): MetricWindow {
  return metricWindow(new Date(end.getTime() - days * DAY_MS), end);
}

/** The `days` full UTC days before today: [today 00:00 - days, today 00:00). */
export function fullDaysBefore(now: Date, days: number): MetricWindow {
  return daysBefore(startOfUtcDay(now), days);
}

/** Monday 00:00 UTC of `now`'s ISO week. */
export function startOfUtcWeek(now: Date): Date {
  const day = startOfUtcDay(now);
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - sinceMonday * DAY_MS);
}

/** The week so far: [Monday 00:00 UTC, now). */
export function weekToDate(now: Date): MetricWindow {
  return metricWindow(startOfUtcWeek(now), now);
}

/** "2026-11-06", or "2026-11-06 to 2026-11-08" for a window longer than a day (the end is exclusive). */
export function windowLabel(window: MetricWindow): string {
  const first = window.from.slice(0, 10);
  const last = new Date(Date.parse(window.to) - 1).toISOString().slice(0, 10);
  return first === last ? first : `${first} to ${last}`;
}
