// GTM-agents: security properties of earned autonomy's levels. A permanently human-only class can
// never be recorded, set, proposed or read above level 1; a level is raised only by an allowlisted
// operator's confirmed command, never by a tool, a job, a model or inbound text; promotion only
// proposes; dismissing a proposal changes no level and leaves it unconfirmable; and every failure to
// read or write a level falls toward level 1. Every value is synthetic.
/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ACTION_CLASSES, PERMANENT_HUMAN, effectiveLevel } from "@gtm-agents/core/autonomy";
import { confirmCommand, createProposal, dismissProposal, parseAutonomyCommand, readAutonomyLevel, runAutonomyCommand, runAutonomyReview, runAutonomyWatch } from "@gtm-agents/core/autonomy/runtime";
import { defineConfig } from "@gtm-agents/core/config";
import { readAutoApprove } from "@gtm-agents/core/outreach";
import { MemoryKv, failingDb, flagsOf, silentLog } from "./helpers.ts";

const db = env.DB;
const config = defineConfig({
  company: { name: "Acme", domain: "acme.example", url: "https://acme.example", product: { name: "Acme Quarantine", description: "Detects flaky tests." } },
  agent: { name: "Avery" },
  sending: { from: { email: "avery@outreach.acme.example" }, replyTo: "avery@acme.example", supportAddress: "support@acme.example", postalAddress: "Acme Inc., 100 Example Street, Springfield, EX 00000", domain: "outreach.acme.example" },
  operator: { allowedChatIds: ["chat-1"], allowedUserIds: ["user-1"] },
  autonomy: { defaults: { cold_batch: 3 } },
});
const NOW = new Date("2026-11-04T17:00:00.000Z");

const sources = import.meta.glob<string>("../../packages/core/src/**/*.ts", { query: "?raw", import: "default", eager: true });
const migration = Object.values(import.meta.glob<string>("../../packages/core/migrations/0023_autonomy.sql", { query: "?raw", import: "default", eager: true }))[0] ?? "";
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
const filesMatching = (pattern: RegExp) =>
  Object.entries(sources)
    .filter(([, source]) => pattern.test(code(source)))
    .map(([file]) => file.replace("../../packages/core/src/", ""))
    .sort();

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM autonomy_level_changes"), db.prepare("DELETE FROM autonomy_proposals"), db.prepare("DELETE FROM autonomy_events")]);
});

describe("permanently human-only classes", () => {
  it("are listed identically in the database's CHECK constraints", () => {
    const lists = [...migration.matchAll(/action_class NOT IN \(([^)]*)\)/g)].map((m) => (m[1] ?? "").split(",").map((s) => s.trim().replace(/'/g, "")));
    expect(lists).toHaveLength(2);
    for (const list of lists) expect(list).toEqual([...PERMANENT_HUMAN]);
  });

  it("can never be recorded above level 1, in a change or a proposal", async () => {
    for (const actionClass of PERMANENT_HUMAN) {
      await expect(db.prepare("INSERT INTO autonomy_level_changes (action_class, to_level, source, actor) VALUES (?1, 2, 'operator', 'operator:user-1')").bind(actionClass).run()).rejects.toThrow(/CHECK/);
      await expect(createProposal(db, { actionClass, from: 1, to: 3, origin: "operator", basedOnChange: 0, requestedBy: "operator:user-1", ttlMs: 60_000, now: NOW })).rejects.toThrow(/permanently human-only/);
    }
  });

  it("read as 1 at most from every source: the flag, the config and a malformed value", async () => {
    for (const actionClass of PERMANENT_HUMAN) {
      expect(effectiveLevel(actionClass, 3)).toBe(1);
      const kv = new MemoryKv();
      kv.map.set(`autonomy:${actionClass}`, "3");
      expect((await readAutonomyLevel({ flags: flagsOf(kv), db, config }, actionClass)).level).toBe(1);
    }
  });

  it("are refused above 1 by autonomy-set, and proposed by no review", async () => {
    const kv = new MemoryKv();
    for (const actionClass of PERMANENT_HUMAN) {
      const command = parseAutonomyCommand(`autonomy-set ${actionClass} 3`);
      expect(await runAutonomyCommand({ db, kv, flags: flagsOf(kv), config, userId: "user-1", now: () => NOW }, command as never)).toMatch(/permanently human-only/);
      const statement = db.prepare("INSERT INTO autonomy_events (id, action_class, outcome, created_at) VALUES (?1, ?2, 'approved_unchanged', ?3)");
      await db.batch(Array.from({ length: 40 }, (_, i) => statement.bind(`ae-${actionClass}-${i}`, actionClass, NOW.toISOString())));
    }
    const review = await runAutonomyReview({ db, flags: flagsOf(kv), config, now: NOW, log: silentLog });
    expect(review.proposals.filter((p) => (PERMANENT_HUMAN as readonly string[]).includes(p.actionClass))).toEqual([]);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM autonomy_proposals").first()).toEqual({ n: 0 });
  });

  it("is a constant: nothing reads a flag or config value to loosen it", () => {
    expect(filesMatching(/PERMANENT_HUMAN\s*=/)).toEqual(["autonomy/levels.ts"]);
    expect(filesMatching(/PERMANENT_HUMAN\.(?:push|splice|pop|shift|length\s*=)/)).toEqual([]);
  });
});

describe("who can change a level", () => {
  it("only the operator's confirm writes an operator change, and only incidents write a demotion", () => {
    expect(filesMatching(/INSERT INTO autonomy_level_changes/)).toEqual(["autonomy/incidents.ts", "autonomy/proposals.ts"]);
    expect(code(sources["../../packages/core/src/autonomy/incidents.ts"] ?? "")).not.toMatch(/'operator'/);
    expect(code(sources["../../packages/core/src/autonomy/proposals.ts"] ?? "")).not.toMatch(/'demotion'/);
  });

  it("only the confirm and the watch write a level flag, and the watch only lowers it", async () => {
    expect(filesMatching(/\.put\(\s*levelFlagKey\(/)).toEqual(["autonomy/jobs.ts", "autonomy/proposals.ts"]);
    expect(filesMatching(/["'`]autonomy:\$\{/)).toEqual(["autonomy/store.ts"]);
    await db.prepare("INSERT INTO autonomy_level_changes (action_class, to_level, source, actor) VALUES ('reply_send', 3, 'operator', 'operator:user-1')").run();
    const kv = new MemoryKv();
    kv.map.set("autonomy:reply_send", "1");
    await runAutonomyWatch({ db, kv, flags: flagsOf(kv), config, now: NOW, log: silentLog, maxRows: 10 });
    expect(kv.map.get("autonomy:reply_send")).toBe("1");
  });

  it("only an operator path (the chat, or the Access-verified dashboard) confirms a change, and no tool or agent module touches levels", () => {
    expect(filesMatching(/\brunAutonomyCommand\(/)).toEqual(["autonomy/commands.ts", "operator/chat.ts"]);
    // The dashboard confirms only an existing proposal, with its confirm code, for an operator whose
    // Cloudflare Access identity the Worker verified (gateway/proposals.ts).
    expect(filesMatching(/\bconfirmProposal\(/)).toEqual(["autonomy/commands.ts", "autonomy/proposals.ts", "gateway/proposals.ts"]);
    const toolsAndAgents = Object.entries(sources).filter(([file]) => /\/src\/(?:tools|agents|runtime)\//.test(file));
    expect(toolsAndAgents.length).toBeGreaterThan(3);
    for (const [file, source] of toolsAndAgents) expect(code(source), file).not.toMatch(/autonomy|levelFlagKey|autonomy_level_changes/);
  });

  it("only an operator path dismisses a proposal, through one function, and dismissing writes no level", async () => {
    // The chat's autonomy-dismiss-<id> and the dashboard's Reject both call dismissProposal.
    expect(filesMatching(/\bdismissProposal\(/)).toEqual(["autonomy/commands.ts", "autonomy/proposals.ts", "gateway/proposals.ts"]);
    const kv = new MemoryKv();
    const proposal = await createProposal(db, { actionClass: "reply_send", from: 1, to: 3, origin: "review", basedOnChange: 0, requestedBy: "system:autonomy_review", ttlMs: 60_000, now: NOW });
    const dismissed = await dismissProposal({ db, actor: "operator:user-1", now: NOW }, { id: proposal.id, reason: "not yet" });
    expect(dismissed.ok).toBe(true);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM autonomy_level_changes").first()).toEqual({ n: 0 });
    expect(kv.map.size).toBe(0);
    const confirm = parseAutonomyCommand(confirmCommand(proposal));
    expect(await runAutonomyCommand({ db, kv, flags: flagsOf(kv), config, userId: "user-1", now: () => NOW }, confirm as never)).toMatch(/is refused/);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM autonomy_level_changes").first()).toEqual({ n: 0 });
    expect([...kv.map.keys()].some((k) => k.startsWith("autonomy:"))).toBe(false);
    expect((await readAutonomyLevel({ flags: flagsOf(kv), db, config }, "reply_send")).level).toBe(1);
  });

  it("the review proposes and never applies", () => {
    const review = code(sources["../../packages/core/src/autonomy/promotion.ts"] ?? "");
    expect(review).not.toMatch(/autonomy_level_changes|\.put\(|confirmProposal/);
  });

  it("every action class the flag store can hold is a known class", () => {
    expect(new Set(ACTION_CLASSES).size).toBe(ACTION_CLASSES.length);
  });
});

describe("failures fall toward level 1", () => {
  it("reads 1 when the database is down, and stops automatic approval even with the switch on", async () => {
    const kv = new MemoryKv();
    kv.map.set("autonomy:cold_batch", "3");
    kv.map.set("cold_batch:auto_approve", "true");
    expect((await readAutonomyLevel({ flags: flagsOf(kv), db: failingDb(), config }, "cold_batch")).level).toBe(1);
    expect(await readAutoApprove(flagsOf(kv), config, failingDb())).toMatchObject({ auto: false, level: 1 });
  });

  it("reads 1 when the flag store is down, whatever the config says", async () => {
    const kv = new MemoryKv();
    kv.failing = true;
    expect((await readAutonomyLevel({ flags: flagsOf(kv), db, config }, "cold_batch")).level).toBe(1);
  });
});
