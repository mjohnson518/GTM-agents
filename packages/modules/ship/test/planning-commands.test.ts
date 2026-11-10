// GTM-agents: the ship loop's approval commands: ship-themes and ship-spec show a theme and its spec
// with the code of its digest; ship-approve binds to that digest (a wrong code, or a spec edited
// since, approves nothing and goes back to review), queues one ship task and starts its build once;
// a build that did not start is retried by the same command; ship-decline closes a theme; and every
// command refuses while the module or its flag is off. Every theme and person is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "@gtm-agents/core";
import { memoryKv } from "@gtm-agents/core/agents/testing";
import type { ModuleCommand } from "@gtm-agents/core/operator";
import { createShipCommands, parseShipCommand } from "../src/planning-commands.ts";
import { approvalCode, parseSpec, specDigest, storedSpec } from "../src/spec.ts";
import { SHIP_ON, SHIP_TEST_REPO, recordingBuild, resetShipTables, seedFeedback, seedTheme, shipTestConfig, specAnswer, type RecordingBuild } from "../src/planning-testing.ts";
import { silentLogger } from "@gtm-agents/core/outreach/testing";

const db = (env as unknown as { DB: D1Database }).DB;
const NOW = new Date("2026-11-09T09:00:00.000Z");

function harness(options: { flags?: Record<string, string>; build?: RecordingBuild<Env>; moduleOn?: boolean } = {}) {
  const build = options.build ?? recordingBuild<Env>();
  const kv = memoryKv(options.flags ?? { ...SHIP_ON });
  const config = shipTestConfig({ modules: { ship: { enabled: options.moduleOn ?? true } } });
  const command: ModuleCommand<Env> = createShipCommands<Env>({ config, startBuild: build.start, baseBranch: "main", repo: SHIP_TEST_REPO, log: silentLogger });
  const testEnv = { DB: db, KV: kv } as unknown as Env;
  const say = async (text: string): Promise<string> => {
    const handler = command.match(text);
    if (!handler) throw new Error(`not a ship command: ${text}`);
    return handler({ env: testEnv, now: NOW, actor: "operator:4251001", sessionKey: "s1" });
  };
  return { say, build, command, kv };
}

async function readyTheme(fields: Record<string, unknown> = {}): Promise<{ id: string; code: string }> {
  const spec = parseSpec(specAnswer(fields))!;
  const id = await seedTheme(db, { status: "spec_ready", score: 12 });
  const digest = await specDigest(id, spec);
  await db.prepare("UPDATE themes SET spec = ?2, spec_digest = ?3, spec_risk = ?4 WHERE id = ?1").bind(id, storedSpec(spec), digest, spec.risk).run();
  await seedFeedback(db, { text: "raw text stays here", status: "themed", themeId: id, summary: "Users want to export the quarantine list as CSV." });
  return { id, code: approvalCode(digest) };
}

const themeRow = (id: string) => db.prepare("SELECT status, approved_by, spec_digest, declined_reason FROM themes WHERE id = ?1").bind(id).first<Record<string, unknown>>();
const tasks = (id: string) => db.prepare("SELECT id, status, repo, base_branch, risk FROM ship_tasks WHERE theme_id = ?1").bind(id).all<Record<string, string>>().then((r) => r.results);

beforeEach(async () => {
  await resetShipTables(db);
});

describe("parsing", () => {
  it("matches the exact command words only", () => {
    expect(parseShipCommand("ship-themes")).toEqual({ kind: "themes" });
    expect(parseShipCommand("/ship_themes@AcmeBot")).toEqual({ kind: "themes" });
    expect(parseShipCommand("SHIP-SPEC-A1B2C3D4E5")).toEqual({ kind: "spec", id: "a1b2c3d4e5" });
    expect(parseShipCommand(`ship-approve-a1b2c3d4e5 ${"f".repeat(32)}`)).toEqual({ kind: "approve", id: "a1b2c3d4e5", code: "f".repeat(32) });
    expect(parseShipCommand(`ship-approve-a1b2c3d4e5-${"f".repeat(32)}`)).toEqual({ kind: "approve", id: "a1b2c3d4e5", code: "f".repeat(32) });
    expect(parseShipCommand("ship-approve-a1b2c3d4e5")).toEqual({ kind: "approve", id: "a1b2c3d4e5", code: null });
    expect(parseShipCommand("ship-decline-a1b2c3d4e5 not now")).toEqual({ kind: "decline", id: "a1b2c3d4e5", reason: "not now" });
    expect(parseShipCommand(`ship-note-approve-a1b2c3d4e5 ${"0".repeat(32)}`)).toEqual({ kind: "note_approve", id: "a1b2c3d4e5", code: "0".repeat(32) });
    expect(parseShipCommand("ship-note-decline-a1b2c3d4e5")).toEqual({ kind: "note_decline", id: "a1b2c3d4e5" });
    for (const text of ["please ship-themes", "ship-themes now", "ship-spec-a1b2c3", `ship-approve-a1b2c3d4e5 ${"f".repeat(32)} extra`, "ship-approve-a1b2c3d4e5 short", "ship", "", "shipthemes"]) {
      expect(parseShipCommand(text)).toBeNull();
    }
  });
});

describe("showing themes and specs", () => {
  it("lists live themes, highest score first", async () => {
    await seedTheme(db, { title: "Dark mode", score: 3 });
    await seedTheme(db, { title: "CSV export", score: 9 });
    await seedTheme(db, { title: "Old idea", status: "declined", score: 50 });
    const text = await harness().say("ship-themes");
    expect(text.indexOf("CSV export")).toBeLessThan(text.indexOf("Dark mode"));
    expect(text).not.toContain("Old idea");
  });

  it("shows a spec with the command that approves exactly it", async () => {
    const { id, code } = await readyTheme();
    const text = await harness().say(`ship-spec-${id}`);
    expect(text).toContain("Export quarantined tests as CSV");
    expect(text).toContain(`ship-approve-${id} ${code}`);
    expect(text).toContain("Users want to export the quarantine list as CSV.");
    expect(text).not.toContain("raw text stays here");
  });
});

describe("approving", () => {
  it("queues one task bound to the digest and starts its build once", async () => {
    const { id, code } = await readyTheme();
    const h = harness();
    const text = await h.say(`ship-approve-${id} ${code}`);
    expect(text).toContain("build has started");
    expect(await themeRow(id)).toMatchObject({ status: "approved", approved_by: "operator:4251001" });
    const t = await tasks(id);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ status: "queued", repo: SHIP_TEST_REPO, base_branch: "main", risk: "low" });
    expect(h.build.calls).toEqual([t[0]?.id]);
    const evidence = await db.prepare("SELECT outcome FROM autonomy_events WHERE action_class = 'ship_spec' AND subject_id = ?1").bind(id).all<{ outcome: string }>();
    expect(evidence.results.map((e) => e.outcome)).toEqual(["approved_unchanged"]);
  });

  it("approves nothing with a code that is not the current spec's, and shows the spec again", async () => {
    const { id, code } = await readyTheme();
    const wrong = `${code.slice(0, 31)}${code.endsWith("0") ? "1" : "0"}`;
    const h = harness();
    const text = await h.say(`ship-approve-${id} ${wrong}`);
    expect(text).toContain("Nothing was approved");
    expect(text).toContain(`ship-approve-${id} ${code}`);
    expect((await themeRow(id))?.status).toBe("spec_ready");
    expect(await tasks(id)).toHaveLength(0);
    expect(h.build.calls).toHaveLength(0);
  });

  it("only shows what an approval would cover when the code is left out", async () => {
    const { id, code } = await readyTheme();
    const text = await harness().say(`ship-approve-${id}`);
    expect(text).toContain(`ship-approve-${id} ${code}`);
    expect((await themeRow(id))?.status).toBe("spec_ready");
  });

  it("sends an edited spec back to review, and approves it only with its new code", async () => {
    const { id, code } = await readyTheme();
    const edited = parseSpec(specAnswer({ approach: "Add the export to every list view in the product." }))!;
    await db.prepare("UPDATE themes SET spec = ?2 WHERE id = ?1").bind(id, storedSpec(edited)).run();
    const h = harness();
    const first = await h.say(`ship-approve-${id} ${code}`);
    expect(first).toContain("goes back to review");
    expect((await themeRow(id))?.status).toBe("spec_ready");
    expect(h.build.calls).toHaveLength(0);
    const newCode = approvalCode(await specDigest(id, edited));
    expect(first).toContain(`ship-approve-${id} ${newCode}`);
    expect((await themeRow(id))?.spec_digest).toBe(await specDigest(id, edited));
    await h.say(`ship-approve-${id} ${newCode}`);
    expect((await themeRow(id))?.status).toBe("approved");
  });

  it("keeps a task queued when its build does not start, and the same command starts it", async () => {
    const { id, code } = await readyTheme();
    const h = harness({ build: recordingBuild<Env>({ started: false, reason: "ship:enabled is off" }) });
    const text = await h.say(`ship-approve-${id} ${code}`);
    expect(text).toContain("did not start");
    expect(text).toContain("ship:enabled is off");
    await h.say(`ship-approve-${id} ${code}`);
    const t = await tasks(id);
    expect(t).toHaveLength(1);
    expect(h.build.calls).toEqual([t[0]?.id, t[0]?.id]);
  });

  it("reports a build that throws without failing the command", async () => {
    const { id, code } = await readyTheme();
    const text = await harness({ build: recordingBuild<Env>(new Error("sandbox binding missing")) }).say(`ship-approve-${id} ${code}`);
    expect(text).toContain("did not start");
    expect(await tasks(id)).toHaveLength(1);
  });

  it("creates one task when two approvals race", async () => {
    const { id, code } = await readyTheme();
    const h = harness();
    await Promise.all([h.say(`ship-approve-${id} ${code}`), h.say(`ship-approve-${id} ${code}`)]);
    expect(await tasks(id)).toHaveLength(1);
  });

  it("approves nothing for a theme without a spec waiting", async () => {
    const id = await seedTheme(db, { status: "open" });
    expect(await harness().say(`ship-approve-${id} ${"a".repeat(32)}`)).toContain("no spec to approve");
  });
});

describe("declining", () => {
  it("closes the theme, records the decision, and nothing can be approved after", async () => {
    const { id, code } = await readyTheme();
    const h = harness();
    expect(await h.say(`ship-decline-${id} not a fit this quarter`)).toContain("Declined");
    expect(await themeRow(id)).toMatchObject({ status: "declined", declined_reason: "not a fit this quarter" });
    const evidence = await db.prepare("SELECT outcome FROM autonomy_events WHERE action_class = 'ship_spec'").all<{ outcome: string }>();
    expect(evidence.results.map((e) => e.outcome)).toEqual(["rejected"]);
    expect(await h.say(`ship-approve-${id} ${code}`)).toContain("declined");
    expect(h.build.calls).toHaveLength(0);
  });
});

describe("switches", () => {
  it("refuses while ship:enabled is off or unreadable", async () => {
    const { id, code } = await readyTheme();
    const off = harness({ flags: {} });
    expect(await off.say(`ship-approve-${id} ${code}`)).toContain("ship:enabled");
    const broken = harness();
    broken.kv.failing = true;
    expect(await broken.say(`ship-approve-${id} ${code}`)).toContain("ship:enabled");
    expect((await themeRow(id))?.status).toBe("spec_ready");
  });

  it("refuses while modules.ship is off in the config", async () => {
    const { id, code } = await readyTheme();
    expect(await harness({ moduleOn: false }).say(`ship-approve-${id} ${code}`)).toContain("modules.ship.enabled");
    expect((await themeRow(id))?.status).toBe("spec_ready");
  });
});
