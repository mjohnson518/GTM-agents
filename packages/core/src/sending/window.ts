// GTM-agents: recipient-local send windows.
//
// A window is a set of weekdays and whole hours (start inclusive, end exclusive) in the
// recipient's time zone. nextAllowedTime is pure: given a moment, a zone and a window it returns
// that moment when it is inside the window, or else the next opening (the start hour on the next
// allowed day, recipient-local). Which window applies depends on the path:
//   - cold and sequence: sending.windowDays and sending.windowHours from gtm.config.ts;
//   - lifecycle: the same hours, Monday to Friday;
//   - reply: no window, because someone who wrote in should hear back promptly.
import type { GtmConfig } from "../config/schema.ts";
import type { SendPath } from "./gates.ts";

export const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface SendWindow {
  days: readonly Weekday[];
  /** Local hour the window opens, 0 to 23. */
  startHour: number;
  /** Local hour it closes, exclusive, 1 to 24. */
  endHour: number;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: Weekday;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall-clock parts of `at` in `tz`. Throws RangeError for an unknown zone. */
export function localParts(at: Date, tz: string): LocalParts {
  const parts = Object.fromEntries(formatter(tz).formatToParts(at).map((p) => [p.type, p.value]));
  const weekday = String(parts.weekday ?? "").toUpperCase().slice(0, 3) as Weekday;
  const hour = Number(parts.hour) % 24;
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour, minute: Number(parts.minute), weekday: WEEKDAYS.includes(weekday) ? weekday : "MON" };
}

const DAY_MS = 86_400_000;

/** `at` read as a wall clock in `tz`, as if that wall clock were UTC, to the minute. */
function wallMs(at: number, tz: string): number {
  const p = localParts(new Date(at), tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
}

function offsetMs(at: number, tz: string): number {
  return wallMs(at, tz) - Math.floor(at / 60_000) * 60_000;
}

/**
 * The UTC instant of a wall-clock time in `tz`. A time that happens twice, in the hour the clocks go
 * back, gives the earlier instant. A time that never happens, in the hour the clocks skip, gives the
 * instant as far past the change as the time is past its start, so 02:00 on a night the clocks jump
 * from 02:00 to 03:00 is 03:00, wherever the zone is.
 */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, tz: string): Date {
  const naive = Date.UTC(year, month - 1, day, hour);
  // An instant with this wall time is within a day of `naive` and uses one of the offsets in force
  // there: the one before and the one after any change in between.
  const offsets = new Set([offsetMs(naive - DAY_MS, tz), offsetMs(naive, tz), offsetMs(naive + DAY_MS, tz)]);
  const candidates = [...offsets].map((o) => naive - o).sort((a, b) => a - b);
  const exact = candidates.find((t) => wallMs(t, tz) === naive);
  if (exact !== undefined) return new Date(exact);
  // Skipped: clocks skip only when the offset grows, so the offset before the change is the smaller
  // one, and naive minus it is the latest candidate.
  return new Date(candidates.at(-1) ?? naive);
}

/** True when `at` falls inside the window, recipient-local. */
export function isWithinWindow(at: Date, tz: string, window: SendWindow): boolean {
  const p = localParts(at, tz);
  return window.days.includes(p.weekday) && p.hour >= window.startHour && p.hour < window.endHour;
}

/**
 * `now` when it is inside the window, otherwise the next time the window opens. A window with no
 * days, or with start not before end, never opens: the result is a week later, so callers defer
 * rather than send.
 */
export function nextAllowedTime(now: Date, tz: string, window: SendWindow): Date {
  const valid = window.days.length > 0 && window.startHour >= 0 && window.endHour <= 24 && window.startHour < window.endHour;
  if (!valid) return new Date(now.getTime() + 7 * 86_400_000);
  if (isWithinWindow(now, tz, window)) return now;
  const p = localParts(now, tz);
  for (let k = 0; k <= 7; k++) {
    const date = new Date(Date.UTC(p.year, p.month - 1, p.day + k));
    const weekday = WEEKDAYS[date.getUTCDay()] as Weekday;
    if (!window.days.includes(weekday)) continue;
    if (k === 0 && p.hour >= window.startHour) continue;
    const opens = zonedTimeToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), window.startHour, tz);
    if (opens.getTime() > now.getTime()) return opens;
  }
  return new Date(now.getTime() + 7 * 86_400_000);
}

const WORKWEEK: readonly Weekday[] = ["MON", "TUE", "WED", "THU", "FRI"];

/** The window for a path, from the sending config, or null for paths that are not windowed. */
export function windowForPath(path: SendPath, sending: Pick<GtmConfig["sending"], "windowDays" | "windowHours">): SendWindow | null {
  const hours = { startHour: sending.windowHours.start, endHour: sending.windowHours.end };
  if (path === "reply") return null;
  if (path === "lifecycle") return { days: WORKWEEK, ...hours };
  return { days: sending.windowDays, ...hours };
}
