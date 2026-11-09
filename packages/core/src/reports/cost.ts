// GTM-agents: the daily cost digest: spend per job since the previous report (yesterday, or Friday
// to Sunday on a Monday), from spendByJob (metrics/), the same function and window as the
// scorecard's spend line. While the scorecard is on it carries spend, so this digest stands down.
import { spendByJob, windowLabel, type MetricWindow, type Spend } from "../metrics/index.ts";
import { dollars, label, plural } from "./format.ts";
import { reportDay } from "./scorecard.ts";

const MAX_JOB_LINES = 15;

export interface CostData {
  window: MetricWindow;
  spend: Spend;
}

/** Load the digest. Throws on a database error. */
export async function loadCostDigest(db: D1Database, now: Date): Promise<CostData> {
  const window = reportDay(now);
  return { window, spend: await spendByJob(db, window) };
}

/** Render the digest. Pure. */
export function renderCostDigest(d: CostData): string {
  const lines = [`Spend for ${windowLabel(d.window)} (UTC): ${dollars(d.spend.totalMicroCents)}`];
  if (d.spend.jobs.length === 0) lines.push("Nothing was spent.");
  for (const j of d.spend.jobs.slice(0, MAX_JOB_LINES)) lines.push(`- ${label(j.job)}: ${dollars(j.microCents)}`);
  if (d.spend.jobs.length > MAX_JOB_LINES) lines.push(`- and ${plural(d.spend.jobs.length - MAX_JOB_LINES, "more job", "more jobs")}`);
  return lines.join("\n");
}
