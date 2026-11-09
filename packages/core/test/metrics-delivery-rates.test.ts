// GTM-agents: tests for the one definition of each delivery rate: the rates themselves, the bounce
// monitor, campaign readiness, the warm-up ramp and the reports reading the same numbers from the
// same ledger rows, and a guard that fails the build if a module outside metrics/ counts bounces or
// divides by them itself. Every row is synthetic, and each test works in its own days of 2019.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  complaintRate,
  daysBefore,
  deliveryCounts,
  deliveryHealth,
  hardBounceRate,
  hardBounceShareOfOutcomes,
  peakDayDelivered,
  sinceWindow,
  trailingDays,
} from "../src/metrics/index.ts";
import { assessReadiness } from "../src/outreach/readiness.ts";
import { bounceWindow } from "../src/sending/bounce-monitor.ts";
import { loadDeliveryEvidence } from "../src/sending/ramp.ts";
import { uid } from "./delivery-fakes.ts";

const db = env.DB;
const DAY = 86_400_000;
const HOUR = 3_600_000;

async function sends(count: number, row: { sentAt: Date; path?: string; deliveredAt?: Date; bouncedAt?: Date; complainedAt?: Date }): Promise<void> {
  const statement = db.prepare("INSERT INTO outreach_sends (id, send_path, provider, sequence_step, sent_at, delivered_at, bounced_at, complained_at) VALUES (?1, ?2, 'test-ledger', 1, ?3, ?4, ?5, ?6)");
  const iso = (d: Date | undefined) => d?.toISOString() ?? null;
  const rows = Array.from({ length: count }, () => statement.bind(uid("os"), row.path ?? "cold", row.sentAt.toISOString(), iso(row.deliveredAt), iso(row.bouncedAt), iso(row.complainedAt)));
  for (let i = 0; i < rows.length; i += 50) await db.batch(rows.slice(i, i + 50));
}

describe("the delivery rates", () => {
  it("are a count over their own denominator, and null without one", () => {
    expect(hardBounceRate({ sends: 200, hardBounces: 5 })).toBe(0.025);
    expect(hardBounceRate({ sends: 0, hardBounces: 3 })).toBeNull();
    expect(hardBounceShareOfOutcomes({ delivered: 95, hardBounces: 5 })).toBe(0.05);
    expect(hardBounceShareOfOutcomes({ delivered: 0, hardBounces: 0 })).toBeNull();
    expect(complaintRate({ delivered: 1000, complaints: 1 })).toBe(0.001);
    expect(complaintRate({ delivered: 0, complaints: 1 })).toBeNull();
  });

  it("tell the two bounce questions apart: over everything sent, and over what the provider reported", () => {
    // 100 sent, 50 delivered, 2 hard bounced, 48 not reported yet.
    const counts = { sends: 100, delivered: 50, hardBounces: 2, complaints: 0 };
    expect(hardBounceRate(counts)).toBe(0.02);
    expect(hardBounceShareOfOutcomes(counts)).toBeCloseTo(2 / 52);
  });

  it("open a gate window at a point in time and leave it open, so later events still count", () => {
    const now = new Date("2019-01-10T09:00:00.000Z");
    const w = trailingDays(now, 7);
    expect(w.from).toBe("2019-01-03T09:00:00.000Z");
    expect(w.to > new Date(now.getTime() + 365 * DAY).toISOString()).toBe(true);
    expect(sinceWindow(now).from).toBe(now.toISOString());
  });
});

describe("every bounce check reads one definition from the same rows", () => {
  it("gives the monitor, readiness, the ramp and the reports the same counts and rate", async () => {
    const now = new Date("2019-02-13T09:00:00.000Z");
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    // Seven days of cold mail: 96 delivered, 4 hard bounced, a complaint.
    await sends(95, { sentAt: ago(3), deliveredAt: ago(3) });
    await sends(1, { sentAt: ago(3), deliveredAt: ago(3), complainedAt: ago(2) });
    await sends(4, { sentAt: ago(3), bouncedAt: ago(3) });
    // Bounces arriving this week for mail sent two weeks ago: they count by when they arrived.
    await sends(3, { sentAt: ago(14), bouncedAt: ago(1) });
    // Not outreach.
    await sends(10, { sentAt: ago(3), path: "reply", bouncedAt: ago(3) });

    const counts = await deliveryCounts(db, trailingDays(now, 7));
    expect(counts).toEqual({ sends: 100, delivered: 96, hardBounces: 7, complaints: 1 });
    expect(hardBounceRate(counts)).toBe(0.07);

    const monitor = await bounceWindow(db, 7, now);
    expect([monitor.sent, monitor.bounced, monitor.rate, monitor.level]).toEqual([100, 7, 0.07, "critical"]);

    const readiness = await assessReadiness(db, [], { now, domainDailyCap: 500, accountWeeklyCap: 3 });
    expect(readiness.dimensions.bounceRate).toEqual({ status: "block", detail: "bounces n/a over 1 day (0 sends), 7.0% over 7 days (100 sends)" });

    const ramp = await loadDeliveryEvidence(db, ago(7));
    expect(ramp).toEqual({ sends: 100, delivered: 96, peakDayDelivered: 96, hardBounced: 7, complained: 1 });
    expect(hardBounceShareOfOutcomes({ delivered: ramp.delivered, hardBounces: ramp.hardBounced })).toBe(7 / 103);

    // The reports read the same definition over a closed window: here the same seven days.
    const report = await deliveryHealth(db, daysBefore(now, 7));
    expect([report.sends, report.hardBounces, report.hardBounceRate]).toEqual([100, 7, 0.07]);
    expect(await peakDayDelivered(db, daysBefore(now, 7))).toBe(96);
  });

  it("makes readiness block on bounces the monitor sees, even when they belong to older sends", async () => {
    const now = new Date("2019-03-13T09:00:00.000Z");
    // Twenty clean sends today, and three bounces arriving today for last month's mail.
    await sends(20, { sentAt: new Date(now.getTime() - 2 * HOUR), deliveredAt: new Date(now.getTime() - HOUR) });
    await sends(3, { sentAt: new Date(now.getTime() - 30 * DAY), bouncedAt: new Date(now.getTime() - HOUR) });
    const monitor = await bounceWindow(db, 1, now);
    expect(monitor).toMatchObject({ sent: 20, bounced: 3, level: "critical" });
    const readiness = await assessReadiness(db, [], { now, domainDailyCap: 500, accountWeeklyCap: 3 });
    expect(readiness.dimensions.bounceRate.status).toBe("block");
    expect(readiness.dimensions.bounceRate.detail).toContain("15.0% over 1 day (20 sends)");
  });

  it("counts an event stamped after the check started against the gate", async () => {
    const now = new Date("2019-04-10T09:00:00.000Z");
    await sends(19, { sentAt: new Date(now.getTime() - HOUR) });
    await sends(1, { sentAt: new Date(now.getTime() - HOUR), bouncedAt: new Date(now.getTime() + 1_000) });
    expect(await bounceWindow(db, 1, now)).toMatchObject({ sent: 20, bounced: 1 });
  });
});

describe("no module outside metrics/ computes a bounce rate itself", () => {
  const sources = import.meta.glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true });
  // Comments may describe a rate and imports may name a bounce module; code may not compute one. The
  // only use of bounced_at outside metrics/ is the provider webhook stamping it, once.
  const code = (source: string) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:\\])\/\/.*$/gm, "$1")
      .replace(/\bfrom "[^"]*"/g, "")
      .replace(/\bSET bounced_at = COALESCE\(bounced_at, \?\d\)/g, "")
      .replace(/"outreach_sends\.bounced_at"/g, "");
  const RULES: ReadonlyArray<[string, RegExp]> = [
    ["a read of bounced_at", /\bbounced_at\b/i],
    ["a ratio of the domain's hard bounce count", /\bhard_bounces\b[^;\n]*\//i],
    ["a bounce count divided by something", /bounce\w*[ \t)?.\w*]*?\/(?![/*])/i],
    ["something divided by a bounce count", /\/(?![/*])[ \t(]*[\w.]*bounce/i],
    ["a denominator that holds a bounce count", /\/[ \t]*\([^)\n]*bounce/i],
    ["a bounce count compared with a share of something", /bounce\w*[ \t]*[<>]=?[ \t]*[\w.]+[ \t]*\*/i],
  ];

  it("has no bounce counting or bounce ratio in any module outside metrics/", () => {
    const outside = Object.entries(sources).filter(([file]) => !file.startsWith("../src/metrics/"));
    expect(outside.length).toBeGreaterThan(100);
    const findings: string[] = [];
    for (const [file, source] of outside) {
      code(source)
        .split("\n")
        .forEach((line, i) => {
          for (const [rule, pattern] of RULES) if (pattern.test(line)) findings.push(`${file}:${i + 1} ${rule}: ${line.trim()}`);
        });
    }
    expect(findings).toEqual([]);
  });

  it("catches the shapes a bounce rate takes in code", () => {
    const caught = (line: string) => RULES.some(([, pattern]) => pattern.test(code(line)));
    expect(caught("const rate = bounced / sent;")).toBe(true);
    expect(caught("const hardRate = e.hardBounced / (e.delivered + e.hardBounced);")).toBe(true);
    expect(caught("return { sends, rate: sends > 0 ? Number(row?.bounces ?? 0) / sends : 0 };")).toBe(true);
    expect(caught("SELECT COUNT(*) AS sends, COUNT(bounced_at) AS bounces FROM outreach_sends")).toBe(true);
    expect(caught("SUM(CASE WHEN bounced_at >= ?1 THEN 1 ELSE 0 END) AS bounced")).toBe(true);
    expect(caught("SELECT hard_bounces * 1.0 / delivered FROM domain_delivery")).toBe(true);
    expect(caught("SELECT COUNT(*) AS n FROM outreach_sends WHERE bounced_at IS NOT NULL AND sent_at >= ?1")).toBe(true);
    expect(caught("const rate = bounced/sent;")).toBe(true);
    expect(caught("const pct = (bounced * 100) / sent;")).toBe(true);
    expect(caught("const ok = 1 - delivered / (delivered + bounced);")).toBe(true);
    expect(caught("if (bounced > sent * 0.05) pause();")).toBe(true);
    expect(caught('import { parseBounce } from "./bounce.ts";')).toBe(false);
    expect(caught("// hard bounces / sends, as the monitor reads it")).toBe(false);
    expect(caught("UPDATE outreach_sends SET bounced_at = COALESCE(bounced_at, ?2) WHERE id = ?1")).toBe(false);
    expect(caught("const describe = (w: BounceWindow) => `${w.days}d (${w.bounced}/${w.sent})`;")).toBe(false);
  });

  it("has the gates and the reports take their rates from metrics/delivery-rates.ts", () => {
    for (const file of ["../src/sending/ramp.ts", "../src/sending/bounce-monitor.ts", "../src/outreach/readiness.ts", "../src/metrics/delivery.ts"]) {
      expect(sources[file], file).toMatch(/from "\.\.\/metrics\/delivery-rates\.ts"|from "\.\/delivery-rates\.ts"/);
    }
  });
});
