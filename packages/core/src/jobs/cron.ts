// GTM-agents: a small, strict cron parser for job schedules.
//
// Schedules are five fields in UTC: minute, hour, day of month, month, day of week. Supported:
// `*`, numbers, ranges `a-b`, steps `*/n` and `a-b/n`, lists `a,b`, and month names (JAN-DEC).
// Day of week must use names (SUN-SAT, for example MON-FRI): on Cloudflare, numeric day 1 is
// Sunday, which silently shifts schedules written for other platforms, so numbers are rejected.
// Non-standard tokens (L, W, #, ?) are rejected as well.

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export interface CronSchedule {
  expression: string;
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** 0 is Sunday. */
  daysOfWeek: ReadonlySet<number>;
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

export class CronError extends Error {
  constructor(expression: string, reason: string) {
    super(`invalid schedule "${expression}": ${reason}`);
    this.name = "CronError";
  }
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** Offset added to a name's index (months are 1-based). */
  nameOffset?: number;
  namesOnly?: boolean;
}

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, nameOffset: 1 },
  { name: "day of week", min: 0, max: 6, names: DAYS, nameOffset: 0, namesOnly: true },
];

/** Normalize whitespace so a registry schedule and a trigger string compare equal. */
export function normalizeCron(expression: string): string {
  return expression.trim().split(/\s+/).join(" ").toUpperCase();
}

export function parseCron(expression: string): CronSchedule {
  const normalized = normalizeCron(expression);
  const parts = normalized.split(" ");
  if (parts.length !== 5) throw new CronError(expression, "expected 5 fields: minute hour day-of-month month day-of-week");
  const sets = parts.map((part, i) => parseField(expression, part, FIELDS[i] as FieldSpec));
  return {
    expression: normalized,
    minutes: sets[0] as Set<number>,
    hours: sets[1] as Set<number>,
    daysOfMonth: sets[2] as Set<number>,
    months: sets[3] as Set<number>,
    daysOfWeek: sets[4] as Set<number>,
    dayOfMonthRestricted: parts[2] !== "*",
    dayOfWeekRestricted: parts[4] !== "*",
  };
}

function parseField(expression: string, field: string, spec: FieldSpec): Set<number> {
  const values = new Set<number>();
  for (const token of field.split(",")) {
    if (token === "") throw new CronError(expression, `${spec.name}: empty list item`);
    if (/[#?]/.test(token) || /^(?:\d*[LW]|LW)(?:\/\d+)?$/.test(token)) {
      throw new CronError(expression, `${spec.name}: L, W, # and ? are not supported`);
    }
    const slashParts = token.split("/");
    if (slashParts.length > 2) throw new CronError(expression, `${spec.name}: "${token}" has more than one step`);
    const [rangePart = "", stepPart] = slashParts;
    if (stepPart !== undefined && !/^\d+$/.test(stepPart)) throw new CronError(expression, `${spec.name}: bad step "${stepPart}"`);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (step < 1) throw new CronError(expression, `${spec.name}: bad step "${stepPart ?? ""}"`);
    if (rangePart.split("-").length > 2) throw new CronError(expression, `${spec.name}: "${rangePart}" is not a range`);
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = spec.min;
      end = spec.max;
    } else {
      const [a = "", b] = rangePart.split("-");
      start = parseValue(expression, a, spec);
      end = b === undefined ? (stepPart === undefined ? start : spec.max) : parseValue(expression, b, spec);
      if (end < start) throw new CronError(expression, `${spec.name}: range ${rangePart} runs backwards`);
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values;
}

function parseValue(expression: string, raw: string, spec: FieldSpec): number {
  if (spec.names) {
    const idx = spec.names.indexOf(raw);
    if (idx !== -1) return idx + (spec.nameOffset ?? 0);
  }
  if (spec.namesOnly) {
    throw new CronError(expression, `${spec.name}: use day names such as MON-FRI (on Cloudflare, numeric day 1 is Sunday)`);
  }
  if (!/^\d+$/.test(raw)) throw new CronError(expression, `${spec.name}: "${raw}" is not a number`);
  const n = Number(raw);
  if (n < spec.min || n > spec.max) throw new CronError(expression, `${spec.name}: ${n} is outside ${spec.min}-${spec.max}`);
  return n;
}

function dayMatches(schedule: CronSchedule, date: Date): boolean {
  if (!schedule.months.has(date.getUTCMonth() + 1)) return false;
  const dom = schedule.daysOfMonth.has(date.getUTCDate());
  const dow = schedule.daysOfWeek.has(date.getUTCDay());
  if (schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted) return dom || dow;
  if (schedule.dayOfMonthRestricted) return dom;
  if (schedule.dayOfWeekRestricted) return dow;
  return true;
}

/** True when the schedule fires at the given minute (UTC). */
export function cronMatches(schedule: CronSchedule, date: Date): boolean {
  return dayMatches(schedule, date) && schedule.hours.has(date.getUTCHours()) && schedule.minutes.has(date.getUTCMinutes());
}

/** The most recent time at or before `now` when the schedule fired, looking back up to 366 days. */
export function previousFire(schedule: CronSchedule, now: Date): Date | null {
  const hours = [...schedule.hours].sort((a, b) => b - a);
  const minutes = [...schedule.minutes].sort((a, b) => b - a);
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let back = 0; back <= 366; back++) {
    const day = new Date(startOfToday - back * 86_400_000);
    if (!dayMatches(schedule, day)) continue;
    for (const h of hours) {
      if (back === 0 && h > now.getUTCHours()) continue;
      for (const m of minutes) {
        if (back === 0 && h === now.getUTCHours() && m > now.getUTCMinutes()) continue;
        return new Date(day.getTime() + h * 3_600_000 + m * 60_000);
      }
    }
  }
  return null;
}
