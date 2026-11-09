// GTM-agents: tests for the one autonomy level reader and the cold batch's use of it: the flag, the
// configured starting level, the latest recorded change as a cap, a standing demotion, and every
// read failure reading as level 1. Every value is synthetic.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { readAutonomyLevel } from "../src/autonomy/store.ts";
import { defineConfig } from "../src/config/define-config.ts";
import { readAutoApprove } from "../src/outreach/flags.ts";
import { flagReader } from "../src/outreach/testing.ts";
import { failingOn } from "./delivery-fakes.ts";
import { acmeConfig } from "./fixtures.ts";

const db = env.DB;
const config = defineConfig(acmeConfig);
const startAt3 = defineConfig({ ...acmeConfig, autonomy: { defaults: { cold_batch: 3 } } });

async function change(actionClass: string, toLevel: number, source: "operator" | "demotion"): Promise<number> {
  await db
    .prepare("INSERT INTO autonomy_level_changes (action_class, from_level, to_level, source, actor, reason) VALUES (?1, NULL, ?2, ?3, 'test', 'synthetic')")
    .bind(actionClass, toLevel, source)
    .run();
  return Number((await db.prepare("SELECT MAX(id) AS id FROM autonomy_level_changes").first<{ id: number }>())?.id);
}

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM autonomy_level_changes"), db.prepare("DELETE FROM autonomy_proposals")]);
});

describe("the level reader", () => {
  it("reads the flag, else the configured starting level, else 1", async () => {
    expect(await readAutonomyLevel({ flags: flagReader({ "autonomy:reply_send": "2" }) }, "reply_send")).toMatchObject({ level: 2, source: "flag", flag: 2, error: null });
    expect(await readAutonomyLevel({ flags: flagReader(), config: startAt3 }, "cold_batch")).toMatchObject({ level: 3, source: "config" });
    expect(await readAutonomyLevel({ flags: flagReader(), config }, "cold_batch")).toMatchObject({ level: 1, source: "default" });
  });

  it("reads anything but one digit from 0 to 3 as level 1", async () => {
    for (const raw of ["9", "2.0", " 3x", "two", "-1", "22"]) {
      expect((await readAutonomyLevel({ flags: flagReader({ "autonomy:cold_batch": raw }) }, "cold_batch")).level, raw).toBe(1);
    }
    expect(await readAutonomyLevel({ flags: flagReader({ "autonomy:cold_batch": "9" }) }, "cold_batch")).toMatchObject({ source: "malformed" });
  });

  it("reads an unreadable flag as level 1 and says why", async () => {
    const reading = await readAutonomyLevel({ flags: flagReader({ "autonomy:cold_batch": "3" }, ["autonomy:cold_batch"]), config: startAt3 }, "cold_batch");
    expect(reading).toMatchObject({ level: 1, source: "unreadable" });
    expect(reading.error).toMatch(/could not be read/);
  });

  it("caps a permanently human-only class at 1 whatever is stored or configured", async () => {
    for (const actionClass of ["merge_code", "pricing_billing_auth", "offers", "proof_of_value_send", "data_deletion"]) {
      expect((await readAutonomyLevel({ flags: flagReader({ [`autonomy:${actionClass}`]: "3" }), db }, actionClass)).level).toBe(1);
    }
  });

  it("takes the lower of the flag and the latest recorded change", async () => {
    const flags = flagReader({ "autonomy:reply_send": "3" });
    await change("reply_send", 2, "operator");
    expect(await readAutonomyLevel({ flags, db }, "reply_send")).toMatchObject({ level: 2, demoted: false });
    await change("reply_send", 3, "operator");
    expect((await readAutonomyLevel({ flags: flagReader({ "autonomy:reply_send": "1" }), db }, "reply_send")).level).toBe(1);
  });

  it("holds a demotion even while the flag still says 3, and never raises a class at 0", async () => {
    await change("cold_batch", 1, "demotion");
    expect(await readAutonomyLevel({ flags: flagReader({ "autonomy:cold_batch": "3" }), db }, "cold_batch")).toMatchObject({ level: 1, demoted: true });
    expect((await readAutonomyLevel({ flags: flagReader({ "autonomy:cold_batch": "0" }), db }, "cold_batch")).level).toBe(0);
  });

  it("caps at 1 and counts as demoted when the recorded changes cannot be read", async () => {
    const broken = failingOn(db, /autonomy_level_changes/);
    const reading = await readAutonomyLevel({ flags: flagReader({ "autonomy:cold_batch": "3" }), db: broken }, "cold_batch");
    expect(reading).toMatchObject({ level: 1, demoted: true });
    expect(reading.error).toMatch(/recorded changes/);
  });
});

describe("the cold batch's auto-approve through the one reader", () => {
  it("keeps its behavior without the database", async () => {
    expect(await readAutoApprove(flagReader({ "cold_batch:auto_approve": "true" }), config)).toMatchObject({ auto: true, reason: "flag" });
    expect(await readAutoApprove(flagReader({ "autonomy:cold_batch": "2" }), config)).toMatchObject({ auto: true, reason: "autonomy_level", level: 2 });
    expect(await readAutoApprove(flagReader({}), startAt3)).toMatchObject({ auto: true, level: 3 });
    expect(await readAutoApprove(flagReader({}, ["*"]), startAt3)).toMatchObject({ auto: false, level: 1 });
  });

  it("stops on a standing demotion, even with the operator's auto-approve switch on", async () => {
    await change("cold_batch", 1, "demotion");
    expect(await readAutoApprove(flagReader({ "autonomy:cold_batch": "2", "cold_batch:auto_approve": "true" }), config, db)).toEqual({ auto: false, reason: null, level: 1 });
  });

  it("never auto-approves at level 0, observe only, even with the switch on", async () => {
    expect(await readAutoApprove(flagReader({ "autonomy:cold_batch": "0", "cold_batch:auto_approve": "true" }), config, db)).toMatchObject({ auto: false, level: 0 });
  });

  it("resumes once a person records a level again", async () => {
    await change("cold_batch", 1, "demotion");
    await change("cold_batch", 1, "operator");
    expect(await readAutoApprove(flagReader({ "cold_batch:auto_approve": "true" }), config, db)).toMatchObject({ auto: true, reason: "flag" });
  });

  it("stops when the recorded changes cannot be read", async () => {
    expect(await readAutoApprove(flagReader({ "cold_batch:auto_approve": "true", "autonomy:cold_batch": "3" }), config, failingOn(db, /autonomy_level_changes/))).toMatchObject({ auto: false });
  });
});
