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

function offsetMs(at: number, tz: string): number {
  const p = localParts(new Date(at), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(at / 60_000) * 60_000;
}

/** The UTC instant of a wall-clock time in `tz`. In a skipped daylight-saving hour it lands an hour later. */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, tz: string): Date {
  const naive = Date.UTC(year, month - 1, day, hour);
  const first = offsetMs(naive, tz);
  let guess = naive - first;
  const second = offsetMs(guess, tz);
  if (second !== first) guess = naive - second;
  return new Date(guess);
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
