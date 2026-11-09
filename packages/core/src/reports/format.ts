// GTM-agents: how reports print numbers and names. Presentation only: no report computes a metric
// here, and nothing here reads the database.
//
// Labels that come from records (a template id, a segment, a persona, a job name) can carry text
// from outside, so label() keeps only plain characters and caps the length before anything reaches
// an operator message. Rendered subjects and inbound text never reach a report at all.
import { replyRate } from "../metrics/index.ts";

/** "4.2%", "94.7%", "12%", or "n/a" when the rate is unknown. One decimal, so a rate just under a threshold never prints as the threshold. */
export function pct(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "n/a";
  const tenths = Math.floor(rate * 1000 + 1e-9) / 10;
  return `${Number.isInteger(tenths) ? tenths.toFixed(0) : tenths.toFixed(1)}%`;
}

/** "3 of 40 (7.5%)": a count over its denominator, with the rate. */
export function ratio(count: number, total: number): string {
  return `${count} of ${total} (${pct(replyRate(count, total))})`;
}

/** Micro-cents (10,000 to the cent) as dollars: "$1.25". */
export function dollars(microCents: number): string {
  return `$${(microCents / 1_000_000).toFixed(2)}`;
}

/** "1 reply", "3 replies". */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A record's value made safe to show: plain characters only, at most `max` long. */
export function label(value: string | number | null | undefined, max = 48): string {
  const text = String(value ?? "")
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9 _.:/@+#&()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return "(blank)";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** The text every report prints for a line whose source is a later milestone. Never a zero. */
export const NOT_MEASURED = "not measured yet";

/** The text for a section whose read failed. Never a zero. */
export const UNREADABLE = "could not be read";

/** Keep an operator message under the channel's limit, cutting whole lines. */
export function fitMessage(lines: readonly string[], max = 3_800): string {
  const out: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > max - 20) {
      out.push("(more lines left out)");
      break;
    }
    out.push(line);
    length += line.length + 1;
  }
  return out.join("\n");
}
