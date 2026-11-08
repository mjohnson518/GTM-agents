// GTM-agents: the outbound liveness check, which notices when mail quietly stops.
//
// Once a day it pages the operator when either holds:
//   - no outbound mail at all in the last 3 days;
//   - today (UTC) is a window day, there are eligible contacts (cold, never contacted, with a
//     deliverable address), and nothing went out today.
// The page carries a short diagnosis: the halt and kill switch, delivery:enabled and
// cold_batch:enabled, the circuit breaker, drafts waiting for approval, the deferred queue and the
// ramp level, so the operator can see at a glance which one is holding mail back. It is claimed
// once per day in the effects ledger.
import type { GtmConfig } from "../config/schema.ts";
import type { FlagReader } from "../jobs/registry.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { readHalt } from "../security/halt.ts";
import type { KvStore } from "../shared/kv.ts";
import { readBreaker } from "./breaker.ts";
import { DELIVERY_FLAGS, readSwitch } from "./flags.ts";
import { readColdPause } from "./kill-switch.ts";
import { pageOnce, utcDay } from "./pages.ts";
import { readRamp } from "./ramp.ts";
import { WEEKDAYS } from "./window.ts";

export const LIVENESS_QUIET_DAYS = 3;
const DAY_MS = 86_400_000;

export interface LivenessDeps {
  db: D1Database;
  kv: KvStore | undefined | null;
  flags: FlagReader;
  config: Pick<GtmConfig, "sending">;
  operator?: OperatorChannel;
  now: Date;
}

export interface LivenessResult {
  quiet: boolean;
  sentLast3Days: number;
  sentToday: number;
  eligible: number;
  windowDay: boolean;
  paged: boolean;
  diagnosis: string[];
}

const count = async (db: D1Database, sql: string, ...binds: unknown[]): Promise<number> => Number((await db.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0);

/** One liveness check. Throws when the send ledger cannot be read. */
export async function runLiveness(deps: LivenessDeps): Promise<LivenessResult> {
  const { db, now } = deps;
  const today = `${utcDay(now)}T00:00:00.000Z`;
  const since = new Date(now.getTime() - LIVENESS_QUIET_DAYS * DAY_MS).toISOString();
  const sentLast3Days = await count(db, "SELECT COUNT(*) AS n FROM outreach_sends WHERE sent_at >= ?1", since);
  const sentToday = await count(db, "SELECT COUNT(*) AS n FROM outreach_sends WHERE sent_at >= ?1", today);
  const eligible = await count(db, "SELECT COUNT(*) AS n FROM contacts WHERE warmth = 'cold' AND last_contacted_at IS NULL AND verification_status = 'deliverable'");
  const windowDay = deps.config.sending.windowDays.includes(WEEKDAYS[now.getUTCDay()] as (typeof WEEKDAYS)[number]);
  const silentForDays = sentLast3Days === 0;
  const silentToday = windowDay && eligible > 0 && sentToday === 0;
  const quiet = silentForDays || silentToday;
  const diagnosis = quiet ? await diagnose(deps) : [];
  let paged = false;
  if (quiet) {
    const what = silentForDays ? `No outbound mail in the last ${LIVENESS_QUIET_DAYS} days.` : `No outbound mail today, a window day, with ${eligible} eligible contact(s).`;
    paged = await pageOnce({ db, kv: deps.kv, operator: deps.operator, eventId: `delivery:liveness:${utcDay(now)}`, effect: "page", text: `${what}\n${diagnosis.map((d) => `- ${d}`).join("\n")}` });
  }
  return { quiet, sentLast3Days, sentToday, eligible, windowDay, paged, diagnosis };
}

async function diagnose(deps: LivenessDeps): Promise<string[]> {
  const lines: string[] = [];
  const halt = await readHalt(deps.kv);
  if (halt.halted) lines.push(`the system is halted${halt.reason ? `: ${halt.reason}` : ""}`);
  const pause = await readColdPause(deps.kv);
  if (pause.paused) lines.push(`cold outreach is paused (${pause.severity ?? "critical"})${pause.reason ? `: ${pause.reason}` : ""}`);
  if (!(await readSwitch(deps.flags, DELIVERY_FLAGS.enabled))) lines.push("delivery:enabled is off");
  if (!(await readSwitch(deps.flags, DELIVERY_FLAGS.coldBatchEnabled))) lines.push("cold_batch:enabled is off");
  const breaker = await readBreaker(deps.kv, deps.now);
  if (breaker.open) lines.push(breaker.unreadable ? "the circuit breaker state cannot be read" : "the provider circuit breaker is open for today");
  const ramp = await readRamp(deps.kv);
  lines.push(`warm-up ramp: ${ramp.limit} a day`);
  try {
    const pending = await count(deps.db, "SELECT COUNT(*) AS n FROM drafts WHERE status = 'pending_approval'");
    if (pending > 0) lines.push(`${pending} draft(s) wait for approval`);
    const queued = await count(deps.db, "SELECT COUNT(*) AS n FROM deferred_sends WHERE status = 'queued'");
    const failed = await count(deps.db, "SELECT COUNT(*) AS n FROM deferred_sends WHERE status = 'failed' AND created_at >= ?1", new Date(deps.now.getTime() - 7 * DAY_MS).toISOString());
    lines.push(`deferred queue: ${queued} queued, ${failed} failed this week`);
  } catch {
    lines.push("drafts and the deferred queue could not be read");
  }
  return lines;
}
