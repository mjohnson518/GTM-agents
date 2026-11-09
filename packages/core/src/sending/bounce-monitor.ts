// GTM-agents: the bounce monitor, which pauses cold outreach when hard bounces climb.
//
// It reads the hard bounce rate (hard bounces over sends, metrics/delivery-rates.ts, the one
// definition campaign readiness and the reports also use) for cold and sequence mail in two trailing
// windows, 7 days (the stable signal) and 1 day (the early warning):
//   - fewer than 20 sends in a window is low volume (no sends: no data), and says nothing;
//   - under 2% is healthy, 2% to 5% warns, 5% or more is critical.
// The overall reading is the worse of the two.
//
// Critical pauses cold outreach. A spike seen only in the 1-day window, with the 7-day window still
// healthy, looks like one bad batch and gives a warning pause; anything the 7-day window confirms
// gives a critical pause. A warning-level spike within 14 days of the monitor lifting a warning
// pause is the same pattern twice and pauses at critical instead. An unreadable record of that last
// lift counts as recent, so doubt escalates rather than relaxes.
//
// While a pause stands:
//   - critical: the operator is paged once a day, and only a person lifts it
//     (resumeColdOutreach(kv, { liftCritical: true }));
//   - warning: lifted automatically once it is at least 3 days old and the last 3 days were clean
//     (no hard bounces at all, or 20 or more sends at under 2%), with one ramp step down for it.
// Automation adds a critical pause only when none stands, and never overwrites, lowers or lifts
// one. Pages go through the operator channel, each claimed once per day in the effects ledger.
import { deliveryCounts, hardBounceRate, trailingDays } from "../metrics/delivery-rates.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import type { KvStore } from "../shared/kv.ts";
import { DELIVERY_FLAGS } from "./flags.ts";
import { pauseColdOutreach, readColdPause, resumeColdOutreach, type PauseSeverity } from "./kill-switch.ts";
import { pageOnce, utcDay } from "./pages.ts";
import { stepDownForPause } from "./ramp.ts";

export const BOUNCE_WARN_RATE = 0.02;
export const BOUNCE_CRITICAL_RATE = 0.05;
export const BOUNCE_MIN_VOLUME = 20;
export const AUTO_RESUME_MIN_DAYS = 3;
export const REPEAT_ESCALATION_DAYS = 14;
const DAY_MS = 86_400_000;

export type BounceLevel = "no_data" | "low_volume" | "healthy" | "warn" | "critical";

const RANK: Record<BounceLevel, number> = { no_data: 0, low_volume: 1, healthy: 2, warn: 3, critical: 4 };

export interface BounceWindow {
  days: number;
  sent: number;
  bounced: number;
  /** hardBounceRate over the window: null with no sends. */
  rate: number | null;
  level: BounceLevel;
}

/** The level of one window. Pure. */
export function bounceLevel(sent: number, bounced: number): BounceLevel {
  if (sent <= 0) return "no_data";
  if (sent < BOUNCE_MIN_VOLUME) return "low_volume";
  const rate = hardBounceRate({ sends: sent, hardBounces: bounced });
  if (rate === null || rate >= BOUNCE_CRITICAL_RATE) return "critical";
  if (rate >= BOUNCE_WARN_RATE) return "warn";
  return "healthy";
}

export const worseLevel = (a: BounceLevel, b: BounceLevel): BounceLevel => (RANK[a] >= RANK[b] ? a : b);

/** The pause severity for a critical reading. Pure. */
export function pauseSeverityFor(level7d: BounceLevel, level1d: BounceLevel): PauseSeverity {
  return level1d === "critical" && level7d === "healthy" ? "warning" : "critical";
}

/** The hard bounce rate for cold and sequence mail over the last `days` (a trailing window). Throws on a database error. */
export async function bounceWindow(db: D1Database, days: number, now: Date): Promise<BounceWindow> {
  const counts = await deliveryCounts(db, trailingDays(now, days));
  return { days, sent: counts.sends, bounced: counts.hardBounces, rate: hardBounceRate(counts), level: bounceLevel(counts.sends, counts.hardBounces) };
}

export interface BounceMonitorDeps {
  db: D1Database;
  kv: KvStore | undefined | null;
  operator?: OperatorChannel;
  now: Date;
}

export interface BounceMonitorResult {
  window7d: BounceWindow;
  window1d: BounceWindow;
  overall: BounceLevel;
  action: string;
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const describe = (w: BounceWindow) => `${w.days}d ${pct(w.rate)} (${w.bounced}/${w.sent}, ${w.level})`;

/** One monitor pass. Throws when the send ledger cannot be read; then nothing changes. */
export async function runBounceMonitor(deps: BounceMonitorDeps): Promise<BounceMonitorResult> {
  const { db, kv, now } = deps;
  const [window7d, window1d] = await Promise.all([bounceWindow(db, 7, now), bounceWindow(db, 1, now)]);
  const overall = worseLevel(window7d.level, window1d.level);
  const day = utcDay(now);
  const page = (effect: string, text: string) => pageOnce({ db, kv, operator: deps.operator, eventId: `delivery:bounce:${day}`, effect, text });
  const summary = `${describe(window7d)}; ${describe(window1d)}`;
  const done = (action: string): BounceMonitorResult => ({ window7d, window1d, overall, action });
  if (!kv) return done("no KV binding: cannot pause or resume");

  const pause = await readColdPause(kv);

  if (overall === "critical") {
    let severity = pauseSeverityFor(window7d.level, window1d.level);
    if (severity === "warning" && (await resumedRecently(kv, now))) severity = "critical";
    const stricter = !pause.paused || (pause.severity === "warning" && severity === "critical");
    if (stricter) {
      await pauseColdOutreach(kv, { reason: `hard bounces: ${summary}`, source: "bounce-monitor", severity }, now);
      await page("pause", `Cold outreach paused (${severity}): hard bounces at ${summary}. ${severity === "critical" ? "Only a person can lift a critical pause." : "It lifts itself after 3 clean days."}`);
      return done(`paused (${severity})`);
    }
  }

  if (pause.paused && pause.severity === "critical") {
    await page("reminder", `Cold outreach is still paused (critical) since ${pause.since ?? "an unknown time"}: ${pause.reason ?? "no reason recorded"}. Bounces now: ${summary}. Only a person can lift it.`);
    return done("critical pause stands (reminded)");
  }

  if (pause.paused && pause.severity === "warning") {
    const since = pause.since ? Date.parse(pause.since) : NaN;
    if (!Number.isFinite(since) || now.getTime() - since < AUTO_RESUME_MIN_DAYS * DAY_MS) return done("warning pause stands (too recent to lift)");
    const recent = await bounceWindow(db, AUTO_RESUME_MIN_DAYS, now);
    const clean = recent.bounced === 0 || (recent.sent >= BOUNCE_MIN_VOLUME && recent.rate !== null && recent.rate < BOUNCE_WARN_RATE);
    if (!clean) return done(`warning pause stands (the last ${AUTO_RESUME_MIN_DAYS} days were not clean: ${describe(recent)})`);
    const resumed = await resumeColdOutreach(kv);
    if (!resumed.ok) return done(`warning pause stands (${resumed.refused})`);
    try {
      await kv.put(DELIVERY_FLAGS.lastAutoResume, now.toISOString(), { expirationTtl: REPEAT_ESCALATION_DAYS * 24 * 60 * 60 });
    } catch {
      // Bookkeeping; an unreadable marker escalates the next spike anyway.
    }
    const stepped = await stepDownForPause(kv, pause.since, now);
    const ramp = stepped ? `the warm-up ramp stepped down to ${stepped.limit} a day` : "the warm-up ramp had already stepped down for this pause";
    await page("resume", `Cold outreach resumed: the warning pause from ${pause.since ?? "an unknown time"} lifted after ${AUTO_RESUME_MIN_DAYS} clean days; ${ramp}.`);
    return done("warning pause lifted");
  }

  if (overall === "warn") {
    await page("warn", `Hard bounces are elevated: ${summary}. Cold outreach continues; at 5% it pauses.`);
    return done("warned");
  }
  return done("no change");
}

async function resumedRecently(kv: KvStore, now: Date): Promise<boolean> {
  try {
    const raw = await kv.get(DELIVERY_FLAGS.lastAutoResume);
    if (raw === null) return false;
    const at = Date.parse(raw);
    return !Number.isFinite(at) || now.getTime() - at < REPEAT_ESCALATION_DAYS * DAY_MS;
  } catch {
    return true;
  }
}
