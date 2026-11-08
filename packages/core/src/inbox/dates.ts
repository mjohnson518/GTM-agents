// GTM-agents: reading the return date out of an out-of-office reply.
//
// The date is looked for only just after a return word ("back", "return", "until", "through"), in
// the sender's own text, so a date in quoted history or in a signature is not read. Accepted forms:
//   - ISO dates (2026-11-20);
//   - named months, either order, with an optional weekday, ordinal and year ("Monday, November
//     23rd", "23 Nov 2026", "the 23rd of November");
//   - numeric dates only when unambiguous: one part above 12 (23/11, 11/23) or both parts equal
//     (5/5). 11/12 could be either day first or month first, so it is not read.
// A date without a year is the next one on or after today. A date in the past, or more than 60 days
// ahead, is not trusted. With no usable date, callers wait OOO_DEFAULT_HOLD_DAYS.

/** The furthest ahead a return date is trusted. */
export const OOO_MAX_DAYS = 60;
/** How long a sequence waits on an out-of-office reply that gives no usable date. */
export const OOO_DEFAULT_HOLD_DAYS = 7;

const DAY_MS = 86_400_000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const RETURN_WORD = /\b(?:back|return(?:s|ing)?|until|till|through|thru|resum(?:e|ing))\b/gi;
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const ORDINAL = "(\\d{1,2})(?:st|nd|rd|th)?";
const YEAR = "(?:,?\\s+(\\d{4}))?";
const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const MONTH_FIRST = new RegExp(`\\b${MONTH}\\s+${ORDINAL}\\b${YEAR}`, "i");
const DAY_FIRST = new RegExp(`\\b${ORDINAL}\\s+(?:of\\s+)?${MONTH}\\b${YEAR}`, "i");
// Slashes (23/11, 23/11/2026), or dots with a trailing dot or year (23.11., 23.11.2026), so a time
// such as 9.30 is never read as a date.
const NUMERIC = /\b(\d{1,2})(?:\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b|\.(\d{1,2})\.(\d{4}|\d{2})?)/;

interface Found {
  index: number;
  year: number | null;
  month: number;
  day: number;
}

const startOfUtcDay = (d: Date): number => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

function monthIndex(name: string): number {
  return MONTHS.indexOf(name.toLowerCase().slice(0, 3));
}

function candidates(window: string): Found[] {
  const found: Found[] = [];
  const iso = ISO.exec(window);
  if (iso) found.push({ index: iso.index, year: Number(iso[1]), month: Number(iso[2]) - 1, day: Number(iso[3]) });
  const monthFirst = MONTH_FIRST.exec(window);
  if (monthFirst) found.push({ index: monthFirst.index, year: monthFirst[3] ? Number(monthFirst[3]) : null, month: monthIndex(monthFirst[1] ?? ""), day: Number(monthFirst[2]) });
  const dayFirst = DAY_FIRST.exec(window);
  if (dayFirst) found.push({ index: dayFirst.index, year: dayFirst[3] ? Number(dayFirst[3]) : null, month: monthIndex(dayFirst[2] ?? ""), day: Number(dayFirst[1]) });
  const numeric = NUMERIC.exec(window);
  if (numeric && !(iso && numeric.index >= iso.index && numeric.index < iso.index + 10)) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2] ?? numeric[4]);
    const yearText = numeric[3] ?? numeric[5];
    const year = yearText ? (yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText)) : null;
    if (a > 12 && b <= 12) found.push({ index: numeric.index, year, month: b - 1, day: a });
    else if (b > 12 && a <= 12) found.push({ index: numeric.index, year, month: a - 1, day: b });
    else if (a === b && a <= 12) found.push({ index: numeric.index, year, month: a - 1, day: a });
  }
  return found.sort((x, y) => x.index - y.index);
}

function resolve(found: Found, now: Date): Date | null {
  if (found.month < 0 || found.month > 11 || found.day < 1 || found.day > 31) return null;
  const today = startOfUtcDay(now);
  const build = (year: number): Date | null => {
    const date = new Date(Date.UTC(year, found.month, found.day));
    // Reject dates that rolled over (31 November becomes 1 December).
    return date.getUTCMonth() === found.month && date.getUTCDate() === found.day ? date : null;
  };
  let date: Date | null;
  if (found.year !== null) {
    date = build(found.year);
  } else {
    date = build(now.getUTCFullYear());
    if (date && date.getTime() < today) date = build(now.getUTCFullYear() + 1);
  }
  if (!date) return null;
  if (date.getTime() < today || date.getTime() - today > OOO_MAX_DAYS * DAY_MS) return null;
  return date;
}

/**
 * The day the sender says they are back (midnight UTC), or null when there is no unambiguous date
 * within OOO_MAX_DAYS. Pure.
 */
export function parseReturnDate(text: string, now: Date): Date | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const head = text.slice(0, 4000);
  for (const match of head.matchAll(RETURN_WORD)) {
    const window = head.slice(match.index, match.index + 140);
    for (const found of candidates(window)) {
      const date = resolve(found, now);
      if (date) return date;
    }
  }
  return null;
}

/**
 * When a sequence held for an out-of-office reply may resume: the day after the return date, or
 * OOO_DEFAULT_HOLD_DAYS from now when there is no usable date.
 */
export function outOfOfficeHoldUntil(returnDate: Date | null, now: Date): Date {
  return returnDate ? new Date(returnDate.getTime() + DAY_MS) : new Date(now.getTime() + OOO_DEFAULT_HOLD_DAYS * DAY_MS);
}
