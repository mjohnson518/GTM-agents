// GTM-agents: the warm-up ramp: how much cold mail a new sending domain may send per day.
//
// A new domain earns reputation gradually, so daily cold volume follows fixed levels: 25, 50, 100,
// 250, 500. The level index lives in KV (outreach:ramp_level) with the time of its last change
// (outreach:ramp_changed_at). Reading fails toward the quietest level: an unset, unreadable or
// malformed index is level 0 (25 a day); an index past the top is the top.
//
// The ramp job (flag outreach:ramp_auto) moves the level one step at a time, on evidence from the
// send ledger since the later of 7 days ago and the last change (so evidence that moved the level
// once never moves it again):
//   - up, only when all hold: at least 7 days since the last change; sends in that window;
//     delivered events present; the best day delivered at least 70% of the current level; hard
//     bounces under 2% of delivered plus hard-bounced; complaints under 0.1% of delivered;
//   - down, when complaints reach 0.3% of delivered with 20 or more delivered, or once for each
//     warning-level cold pause (the bounce monitor also steps down when it lifts one; the step is
//     taken once per pause, whichever comes first);
//   - held otherwise, and while a critical pause stands.
//
// readColdVolume is what the cold batch sizes itself by: the ramp level, lowered by the operator's
// cold_batch:daily_limit and by the per-domain daily cap, never above 1,500.
import type { FlagReader } from "../jobs/registry.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import type { KvStore } from "../shared/kv.ts";
import { DELIVERY_FLAGS, DELIVERY_LIMITS, readCap } from "./flags.ts";
import { readColdPause } from "./kill-switch.ts";
import { pageOnce, utcDay } from "./pages.ts";

export const RAMP_LEVELS: readonly number[] = Object.freeze([25, 50, 100, 250, 500]);
export const COLD_VOLUME_HARD_MAX = 1500;
export const RAMP_MIN_DAYS_BETWEEN_CHANGES = 7;
export const RAMP_MIN_LEVEL_USE = 0.7;
export const RAMP_MAX_HARD_BOUNCE_RATE = 0.02;
export const RAMP_MAX_COMPLAINT_RATE = 0.001;
export const RAMP_STEP_DOWN_COMPLAINT_RATE = 0.003;
export const RAMP_STEP_DOWN_MIN_DELIVERED = 20;
const DAY_MS = 86_400_000;

export interface RampState {
  index: number;
  limit: number;
  changedAt: string | null;
  /** True when the state could not be read whole and level 0 is assumed. */
  degraded: boolean;
}

export async function readRamp(kv: Pick<KvStore, "get"> | undefined | null): Promise<RampState> {
  const quietest: RampState = { index: 0, limit: RAMP_LEVELS[0] as number, changedAt: null, degraded: true };
  if (!kv) return quietest;
  let raw: string | null;
  let changedAt: string | null;
  try {
    [raw, changedAt] = await Promise.all([kv.get(DELIVERY_FLAGS.rampLevel), kv.get(DELIVERY_FLAGS.rampChangedAt)]);
  } catch {
    return quietest;
  }
  const changed = changedAt !== null && Number.isFinite(Date.parse(changedAt)) ? changedAt : null;
  if (raw === null || raw.trim() === "") return { index: 0, limit: RAMP_LEVELS[0] as number, changedAt: changed, degraded: false };
  const n = Number(raw.trim());
  if (!Number.isInteger(n)) return { ...quietest, changedAt: changed };
  const index = Math.min(Math.max(n, 0), RAMP_LEVELS.length - 1);
  return { index, limit: RAMP_LEVELS[index] as number, changedAt: changed, degraded: false };
}

/** Move the ramp to `index` and stamp the change. Returns the new state, or null when the write failed. */
export async function setRampLevel(kv: KvStore, index: number, now: Date): Promise<RampState | null> {
  const clamped = Math.min(Math.max(Math.trunc(index), 0), RAMP_LEVELS.length - 1);
  try {
    // The change time goes first: if the level write then fails, the ramp only waits longer.
    await kv.put(DELIVERY_FLAGS.rampChangedAt, now.toISOString());
    await kv.put(DELIVERY_FLAGS.rampLevel, String(clamped));
  } catch {
    return null;
  }
  return { index: clamped, limit: RAMP_LEVELS[clamped] as number, changedAt: now.toISOString(), degraded: false };
}

/**
 * Step down once for a warning pause that began at `pauseSince`: only when the ramp has not changed
 * since the pause began, so the pause costs one level however many times this is called.
 */
export async function stepDownForPause(kv: KvStore, pauseSince: string | undefined, now: Date): Promise<RampState | null> {
  const state = await readRamp(kv);
  if (state.index === 0) return null;
  const since = pauseSince ? Date.parse(pauseSince) : NaN;
  if (state.changedAt && Number.isFinite(since) && Date.parse(state.changedAt) >= since) return null;
  return setRampLevel(kv, state.index - 1, now);
}

export interface ColdVolume {
  /** Cold messages the batch may send today. */
  volume: number;
  rampIndex: number;
  rampLimit: number;
  /** cold_batch:daily_limit, when set and readable. */
  operatorLimit: number | null;
  domainCap: number;
  /** Why the volume is what it is, for the batch's report. */
  reason: string;
}

/**
 * Today's allowed cold volume: the ramp level, lowered by the operator's limit and the per-domain
 * daily cap, never above COLD_VOLUME_HARD_MAX. An operator limit that cannot be read or does not
 * parse allows nothing, because it could only have lowered the volume.
 */
export async function readColdVolume(input: { kv: Pick<KvStore, "get"> | undefined | null; flags: FlagReader }): Promise<ColdVolume> {
  const ramp = await readRamp(input.kv);
  const domainCap = await readCap(input.flags, DELIVERY_FLAGS.domainDailyCap, DELIVERY_LIMITS.domainDailyCap);
  let operatorLimit: number | null = null;
  let unreadable = false;
  try {
    const raw = await input.flags.get(DELIVERY_FLAGS.coldDailyLimit);
    if (raw !== null && raw.trim() !== "") {
      const n = Number(raw.trim());
      if (Number.isInteger(n) && n >= 0) operatorLimit = n;
      else unreadable = true;
    }
  } catch {
    unreadable = true;
  }
  if (unreadable) return { volume: 0, rampIndex: ramp.index, rampLimit: ramp.limit, operatorLimit: null, domainCap, reason: "cold_batch:daily_limit could not be read or is not a whole number" };
  const volume = Math.min(ramp.limit, operatorLimit ?? Infinity, domainCap, COLD_VOLUME_HARD_MAX);
  const reason =
    volume === ramp.limit
      ? `the ramp level (${ramp.limit} a day${ramp.degraded ? ", the quietest level because the ramp state could not be read" : ""})`
      : volume === operatorLimit
        ? `the operator limit (${operatorLimit} a day)`
        : volume === domainCap
          ? `the per-domain daily cap (${domainCap})`
          : `the hard maximum (${COLD_VOLUME_HARD_MAX})`;
  return { volume, rampIndex: ramp.index, rampLimit: ramp.limit, operatorLimit, domainCap, reason };
}

export interface DeliveryEvidence {
  sends: number;
  delivered: number;
  /** Most deliveries on any one UTC day in the window. */
  peakDayDelivered: number;
  hardBounced: number;
  complained: number;
}

/** Cold and sequence delivery evidence since `since`, from the send ledger. Throws on a database error. */
export async function loadDeliveryEvidence(db: D1Database, since: Date): Promise<DeliveryEvidence> {
  const s = since.toISOString();
  const totals = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN sent_at >= ?1 THEN 1 ELSE 0 END) AS sends,
         SUM(CASE WHEN delivered_at >= ?1 THEN 1 ELSE 0 END) AS delivered,
         SUM(CASE WHEN bounced_at >= ?1 THEN 1 ELSE 0 END) AS bounced,
         SUM(CASE WHEN complained_at >= ?1 THEN 1 ELSE 0 END) AS complained
       FROM outreach_sends WHERE send_path IN ('cold', 'sequence') AND (sent_at >= ?1 OR delivered_at >= ?1 OR bounced_at >= ?1 OR complained_at >= ?1)`,
    )
    .bind(s)
    .first<{ sends: number | null; delivered: number | null; bounced: number | null; complained: number | null }>();
  const peak = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM outreach_sends WHERE send_path IN ('cold', 'sequence') AND delivered_at >= ?1
        GROUP BY substr(delivered_at, 1, 10) ORDER BY n DESC LIMIT 1`,
    )
    .bind(s)
    .first<{ n: number }>();
  return {
    sends: Number(totals?.sends ?? 0),
    delivered: Number(totals?.delivered ?? 0),
    peakDayDelivered: Number(peak?.n ?? 0),
    hardBounced: Number(totals?.bounced ?? 0),
    complained: Number(totals?.complained ?? 0),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

/** Whether the evidence supports moving up from a level of `levelLimit` a day. Pure. */
export function rampAdvanceVerdict(e: DeliveryEvidence, levelLimit: number): { ok: boolean; reason: string } {
  if (e.sends === 0) return { ok: false, reason: "no sends in the window" };
  if (e.delivered === 0) return { ok: false, reason: "no delivered events in the window" };
  const needed = Math.ceil(levelLimit * RAMP_MIN_LEVEL_USE);
  if (e.peakDayDelivered < needed) return { ok: false, reason: `the best day delivered ${e.peakDayDelivered}; ${needed} (70% of ${levelLimit}) are needed` };
  const hardRate = e.hardBounced / (e.delivered + e.hardBounced);
  if (hardRate >= RAMP_MAX_HARD_BOUNCE_RATE) return { ok: false, reason: `hard bounces at ${pct(hardRate)}` };
  const complaintRate = e.complained / e.delivered;
  if (complaintRate >= RAMP_MAX_COMPLAINT_RATE) return { ok: false, reason: `complaints at ${pct(complaintRate)}` };
  return { ok: true, reason: `${e.delivered} delivered, hard bounces ${pct(hardRate)}, complaints ${pct(complaintRate)}` };
}

/** Whether complaints call for a step down. Pure. */
export function rampStepDownVerdict(e: DeliveryEvidence): { ok: boolean; reason: string } {
  if (e.delivered < RAMP_STEP_DOWN_MIN_DELIVERED || e.complained === 0) return { ok: false, reason: "not enough complaint evidence" };
  const rate = e.complained / e.delivered;
  return rate >= RAMP_STEP_DOWN_COMPLAINT_RATE ? { ok: true, reason: `complaints at ${pct(rate)} of ${e.delivered} delivered` } : { ok: false, reason: `complaints at ${pct(rate)}` };
}

export interface RampJobResult {
  action: "advanced" | "stepped_down" | "held";
  from: number;
  to: number;
  reason: string;
}

export interface RampJobDeps {
  db: D1Database;
  kv: KvStore | undefined | null;
  operator?: OperatorChannel;
  now: Date;
}

/** One ramp decision. Throws when the evidence cannot be read; never moves on unreadable state. */
export async function runRampJob(deps: RampJobDeps): Promise<RampJobResult> {
  const kv = deps.kv;
  const state = await readRamp(kv);
  const held = (reason: string): RampJobResult => ({ action: "held", from: state.limit, to: state.limit, reason });
  if (!kv || state.degraded) return held("the ramp state could not be read, so it is left alone");
  const pause = await readColdPause(kv);
  if (pause.paused && pause.severity === "warning") {
    const stepped = await stepDownForPause(kv, pause.since, deps.now);
    if (!stepped) return held("a warning pause stands; the ramp already stepped down for it, or is at the floor");
    await announce(deps, `Warm-up ramp stepped down to ${stepped.limit} a day: cold outreach is under a warning pause.`);
    return { action: "stepped_down", from: state.limit, to: stepped.limit, reason: "warning pause" };
  }
  if (pause.paused) return held("a critical pause stands; only a person moves things now");

  const windowStart = Math.max(deps.now.getTime() - RAMP_MIN_DAYS_BETWEEN_CHANGES * DAY_MS, state.changedAt ? Date.parse(state.changedAt) : 0);
  const evidence = await loadDeliveryEvidence(deps.db, new Date(windowStart));
  const down = rampStepDownVerdict(evidence);
  if (down.ok) {
    if (state.index === 0) return held(`${down.reason}, but the ramp is at the floor`);
    const stepped = await setRampLevel(kv, state.index - 1, deps.now);
    if (!stepped) return held("the ramp could not be written");
    await announce(deps, `Warm-up ramp stepped down to ${stepped.limit} a day: ${down.reason}.`);
    return { action: "stepped_down", from: state.limit, to: stepped.limit, reason: down.reason };
  }
  if (state.index >= RAMP_LEVELS.length - 1) return held("the ramp is at its top level");
  const daysSince = state.changedAt ? (deps.now.getTime() - Date.parse(state.changedAt)) / DAY_MS : Infinity;
  if (daysSince < RAMP_MIN_DAYS_BETWEEN_CHANGES) return held(`the last change was ${Math.floor(daysSince)} day(s) ago; ${RAMP_MIN_DAYS_BETWEEN_CHANGES} are needed`);
  const up = rampAdvanceVerdict(evidence, state.limit);
  if (!up.ok) return held(up.reason);
  const advanced = await setRampLevel(kv, state.index + 1, deps.now);
  if (!advanced) return held("the ramp could not be written");
  await announce(deps, `Warm-up ramp advanced to ${advanced.limit} a day: ${up.reason}.`);
  return { action: "advanced", from: state.limit, to: advanced.limit, reason: up.reason };
}

async function announce(deps: RampJobDeps, text: string): Promise<void> {
  await pageOnce({ db: deps.db, kv: deps.kv, operator: deps.operator, eventId: `delivery:ramp:${utcDay(deps.now)}`, effect: "change", text });
}
