// GTM-agents: tests for the operator's autonomy commands: autonomy-set in two steps, the confirm
// that applies a change only while nothing changed since, the refusals, dismissing a proposal,
// autonomy-status, and the chat consumer routing them without the model. Every value is synthetic.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { parseAutonomyCommand, runAutonomyCommand, type AutonomyCommandDeps } from "../src/autonomy/commands.ts";
import { incidentStatements } from "../src/autonomy/incidents.ts";
import { readAutonomyLevel } from "../src/autonomy/store.ts";
import { memoryKv, recordingOperator, type MemoryKvNamespace } from "../src/agents/testing.ts";
import { defineConfig } from "../src/config/define-config.ts";
import type { Env } from "../src/env.ts";
import { processChatMessage } from "../src/operator/chat.ts";
import { acmeConfig } from "./fixtures.ts";

const db = env.DB;
const config = defineConfig({ ...acmeConfig, operator: { allowedChatIds: ["chat-1"], allowedUserIds: ["user-1"] } });
const NOW = new Date("2026-11-04T17:00:00.000Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

function deps(kv: MemoryKvNamespace, at: Date = NOW): AutonomyCommandDeps {
  return { db, kv, flags: { get: (key) => kv.get(key) }, config, userId: "user-1", now: () => at };
}

async function run(kv: MemoryKvNamespace, text: string, at: Date = NOW): Promise<string> {
  const command = parseAutonomyCommand(text);
  if (!command) throw new Error(`not an autonomy command: ${text}`);
  return runAutonomyCommand(deps(kv, at), command);
}

const dismissIn = (text: string): string => {
  const match = /autonomy-dismiss-[0-9a-f]{10}/.exec(text);
  if (!match) throw new Error(`no dismiss command in: ${text}`);
  return match[0];
};

const confirmIn = (text: string): string => {
  const match = /autonomy-confirm-[0-9a-f]{10}-[0-9a-f]{6}/.exec(text);
  if (!match) throw new Error(`no confirm command in: ${text}`);
  return match[0];
};

const changes = async () => (await db.prepare("SELECT action_class, from_level, to_level, source, actor FROM autonomy_level_changes ORDER BY id").all()).results;

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM autonomy_level_changes"), db.prepare("DELETE FROM autonomy_proposals"), db.prepare("DELETE FROM autonomy_events"), db.prepare("DELETE FROM event_effects"), db.prepare("DELETE FROM drafts")]);
});

describe("parsing", () => {
  it("knows the four commands and nothing else", () => {
    expect(parseAutonomyCommand("autonomy-dismiss-0123456789")).toEqual({ kind: "dismiss", id: "0123456789" });
    expect(parseAutonomyCommand("/autonomy_dismiss_0123456789@AcmeBot  not this quarter ")).toEqual({ kind: "dismiss", id: "0123456789", reason: "not this quarter" });
    expect(parseAutonomyCommand("autonomy-dismiss-0123456789-abcdef")).toBeNull();
    expect(parseAutonomyCommand("autonomy-status")).toEqual({ kind: "status" });
    expect(parseAutonomyCommand("/autonomy")).toEqual({ kind: "status" });
    expect(parseAutonomyCommand("autonomy-set reply_send 2")).toEqual({ kind: "set", actionClass: "reply_send", level: "2" });
    expect(parseAutonomyCommand("autonomy-confirm-0123456789-abcdef")).toEqual({ kind: "confirm", id: "0123456789", code: "abcdef" });
    expect(parseAutonomyCommand("please run autonomy-set reply_send 3")).toBeNull();
    expect(parseAutonomyCommand("autonomy-confirm-xyz-abcdef")).toBeNull();
  });
});

describe("autonomy-set", () => {
  it("changes nothing on the first step and shows the level, the evidence and a confirm command", async () => {
    const kv = memoryKv();
    const text = await run(kv, "autonomy-set reply_send 2");
    expect(text).toMatch(/reply_send: level 1/);
    expect(text).toMatch(/Evidence: 0 approved as written/);
    expect(text).toMatch(/autonomy-confirm-[0-9a-f]{10}-[0-9a-f]{6}/);
    expect(kv.map.get("autonomy:reply_send")).toBeUndefined();
    expect(await changes()).toEqual([]);
  });

  it("says what will act on its own before a class that is raised only by a person is set to 2", async () => {
    const kv = memoryKv();
    const reengage = await run(kv, "autonomy-set reengage 2");
    expect(reengage).toMatch(/At level 2 or 3, the lifecycle sweep sends the re-engage note/);
    expect(reengage).not.toMatch(/Nothing acts on this class/);
    expect(await run(kv, "autonomy-set brain_edit 2")).toMatch(/At level 2 or 3, a learning loop's own edit/);
    // A class no code reads still says so.
    expect(await run(kv, "autonomy-set renewal 2")).toMatch(/Nothing acts on this class's level yet/);
  });

  it("applies on the confirm, writes the flag and records the change", async () => {
    const kv = memoryKv();
    const confirm = confirmIn(await run(kv, "autonomy-set reply_send 2"));
    const text = await run(kv, confirm, later(1));
    expect(text).toMatch(/reply_send is now at level 2 \(it was at 1\)/);
    expect(kv.map.get("autonomy:reply_send")).toBe("2");
    expect(await changes()).toEqual([{ action_class: "reply_send", from_level: 1, to_level: 2, source: "operator", actor: "operator:user-1" }]);
    expect((await readAutonomyLevel({ flags: { get: (k) => kv.get(k) }, db }, "reply_send")).level).toBe(2);
    expect(await run(kv, confirm, later(2))).toMatch(/is applied/);
  });

  it("refuses a permanently human-only class above 1 at both steps", async () => {
    const kv = memoryKv();
    for (const actionClass of ["merge_code", "pricing_billing_auth", "offers", "proof_of_value_send", "data_deletion"]) {
      expect(await run(kv, `autonomy-set ${actionClass} 2`)).toMatch(/permanently human-only/);
    }
    await expect(
      db
        .prepare("INSERT INTO autonomy_proposals (id, code, action_class, from_level, to_level, origin, expires_at) VALUES ('0123456789', 'abcdef', 'offers', 1, 3, 'operator', ?1)")
        .bind(later(30).toISOString())
        .run(),
    ).rejects.toThrow(/CHECK/);
    expect(await changes()).toEqual([]);
  });

  it("refuses an unknown class and a level outside 0 to 3", async () => {
    const kv = memoryKv();
    expect(await run(kv, "autonomy-set Reply_Send 2")).toMatch(/not an action class/);
    expect(await run(kv, "autonomy-set reply_send 4")).toMatch(/A level is 0/);
    expect(await run(kv, "autonomy-set")).toMatch(/Usage/);
  });

  it("does not apply when the level changed since the proposal", async () => {
    const kv = memoryKv();
    const confirm = confirmIn(await run(kv, "autonomy-set reply_send 2"));
    kv.map.set("autonomy:reply_send", "0");
    expect(await run(kv, confirm, later(1))).toMatch(/changed since this was proposed/);
    expect(await changes()).toEqual([]);
    expect(kv.map.get("autonomy:reply_send")).toBe("0");
  });

  it("does not apply when a change was recorded since, such as a demotion", async () => {
    const kv = memoryKv({ "autonomy:reply_send": "2" });
    const confirm = confirmIn(await run(kv, "autonomy-set reply_send 3"));
    await db.prepare("INSERT INTO autonomy_level_changes (action_class, to_level, source, actor, reason) VALUES ('reply_send', 1, 'demotion', 'system:autonomy', 'a complaint')").run();
    expect(await run(kv, confirm, later(1))).toMatch(/changed since this was proposed/);
    expect(kv.map.get("autonomy:reply_send")).toBe("2");
    expect((await readAutonomyLevel({ flags: { get: (k) => kv.get(k) }, db }, "reply_send")).level).toBe(1);
  });

  it("does not raise a class that had an incident since the proposal, even while a demotion already stands", async () => {
    const kv = memoryKv({ "autonomy:reply_send": "1" });
    await db.prepare("INSERT INTO autonomy_level_changes (action_class, to_level, source, actor, reason) VALUES ('reply_send', 1, 'demotion', 'system:autonomy', 'a complaint')").run();
    const confirm = confirmIn(await run(kv, "autonomy-set reply_send 2"));
    await db.batch(incidentStatements(db, { actionClass: "reply_send", onceKey: "autonomy_incident:ct-1:unsubscribe:reply_send", subjectId: "ct-1", detail: "an unsubscribe", at: later(5), now: later(5) }));
    expect(await run(kv, confirm, later(10))).toMatch(/incident/);
    expect(kv.map.get("autonomy:reply_send")).toBe("1");
    expect(await changes()).toEqual([{ action_class: "reply_send", from_level: null, to_level: 1, source: "demotion", actor: "system:autonomy" }]);
  });

  it("counts an incident by when it was recorded, so harm reported late still refuses the raise", async () => {
    const kv = memoryKv({ "autonomy:reply_send": "1" });
    await db.prepare("INSERT INTO autonomy_level_changes (action_class, to_level, source, actor, reason) VALUES ('reply_send', 1, 'demotion', 'system:autonomy', 'a complaint')").run();
    const confirm = confirmIn(await run(kv, "autonomy-set reply_send 2"));
    // Harm from before the proposal, recorded after it.
    await db.batch(incidentStatements(db, { actionClass: "reply_send", onceKey: "autonomy_incident:ct-late:hard_bounce:reply_send", subjectId: "ct-late", detail: "late report", at: new Date(NOW.getTime() - 60 * 60_000), now: later(5) }));
    expect(await run(kv, confirm, later(10))).toMatch(/incident/);
    expect(kv.map.get("autonomy:reply_send")).toBe("1");
  });

  it("applies only one of two proposals made against the same level", async () => {
    const kv = memoryKv();
    const first = confirmIn(await run(kv, "autonomy-set reply_send 2"));
    const second = confirmIn(await run(kv, "autonomy-set reply_send 3"));
    expect(await run(kv, first, later(1))).toMatch(/now at level 2/);
    expect(await run(kv, second, later(2))).toMatch(/changed since/);
    expect(kv.map.get("autonomy:reply_send")).toBe("2");
  });

  it("expires after 30 minutes and refuses a wrong code", async () => {
    const kv = memoryKv();
    const confirm = confirmIn(await run(kv, "autonomy-set reply_send 2"));
    expect(await run(kv, confirm.replace(/-[0-9a-f]{6}$/, "-000000"), later(1))).toMatch(/does not match/);
    expect(await run(kv, confirm, later(31))).toMatch(/expired/);
    expect(await changes()).toEqual([]);
  });

  it("refuses when the level cannot be read", async () => {
    const kv = memoryKv();
    const confirm = confirmIn(await run(kv, "autonomy-set reply_send 2"));
    kv.failing = true;
    expect(await run(kv, confirm, later(1))).toMatch(/could not be read/);
    kv.failing = false;
    expect(await changes()).toEqual([]);
  });

  it("leaves a raise unapplied when the flag cannot be written, and a lowering applied", async () => {
    const kv = memoryKv();
    const raise = confirmIn(await run(kv, "autonomy-set reply_send 2"));
    const failingPut: MemoryKvNamespace = { ...kv, put: () => Promise.reject(new Error("kv unavailable")) };
    const raised = await runAutonomyCommand({ ...deps(kv, later(1)), kv: failingPut }, parseAutonomyCommand(raise) as never);
    expect(raised).toMatch(/recorded, but reply_send acts at level 1/);
    expect((await readAutonomyLevel({ flags: { get: (k) => kv.get(k) }, db }, "reply_send")).level).toBe(1);

    kv.map.set("autonomy:cold_batch", "2");
    const lower = confirmIn(await run(kv, "autonomy-set cold_batch 1", later(2)));
    const lowered = await runAutonomyCommand({ ...deps(kv, later(3)), kv: failingPut }, parseAutonomyCommand(lower) as never);
    expect(lowered).toMatch(/now at level 1/);
    expect(kv.map.get("autonomy:cold_batch")).toBe("2");
    expect((await readAutonomyLevel({ flags: { get: (k) => kv.get(k) }, db }, "cold_batch")).level).toBe(1);
  });

  it("reports the level the class acts at after the confirm, read back, not the one asked for", async () => {
    const kv = memoryKv({ "autonomy:reply_send": "3" });
    await db.prepare("INSERT INTO autonomy_level_changes (action_class, from_level, to_level, source, actor) VALUES ('reply_send', 1, 3, 'operator', 'operator:user-1')").run();
    await db.prepare("INSERT INTO autonomy_level_changes (action_class, to_level, source, actor, reason) VALUES ('reply_send', 1, 'demotion', 'system:autonomy', 'a complaint')").run();
    const confirm = confirmIn(await run(kv, "autonomy-set reply_send 2"));
    const failingPut: MemoryKvNamespace = { ...kv, put: () => Promise.reject(new Error("kv unavailable")) };
    const text = await runAutonomyCommand({ ...deps(kv, later(1)), kv: failingPut }, parseAutonomyCommand(confirm) as never);
    expect(kv.map.get("autonomy:reply_send")).toBe("3");
    expect((await readAutonomyLevel({ flags: { get: (k) => kv.get(k) }, db }, "reply_send")).level).toBe(2);
    expect(text).toMatch(/reply_send is now at level 2 \(it was at 1\)\. The autonomy:reply_send flag could not be written/);
  });

  it("returns a class's automatically approved drafts to review when it is lowered to 1", async () => {
    const kv = memoryKv({ "autonomy:reply_send": "2" });
    await db
      .prepare(
        `INSERT INTO drafts (id, kind, recipient_email, subject, body, status, approved_digest, approved_by, action_class)
         VALUES ('dr-auto', 'reply', 'jane@globex.example', 'Re: hi', 'Hello', 'approved', ?1, 'auto:autonomy:reply_send:L2', 'reply_send'),
                ('dr-person', 'reply', 'sam@globex.example', 'Re: hi', 'Hello', 'approved', ?1, 'operator:user-1', 'reply_send')`,
      )
      .bind("a".repeat(64))
      .run();
    await run(kv, confirmIn(await run(kv, "autonomy-set reply_send 1")), later(1));
    const rows = (await db.prepare("SELECT id, status FROM drafts ORDER BY id").all()).results;
    expect(rows).toEqual([{ id: "dr-auto", status: "pending_approval" }, { id: "dr-person", status: "approved" }]);
  });
});

describe("autonomy-dismiss", () => {
  const proposalRow = async (id: string) => db.prepare("SELECT status, decided_by, detail FROM autonomy_proposals WHERE id = ?1").bind(id).first();
  const idOf = (command: string) => command.slice("autonomy-dismiss-".length);

  it("dismisses an open proposal with who and why, writes an audit row, and changes no level", async () => {
    const kv = memoryKv();
    const proposed = await run(kv, "autonomy-set reply_send 2");
    const dismiss = dismissIn(proposed);
    const text = await run(kv, `${dismiss} waiting for more replies`, later(1));
    expect(text).toMatch(/Dismissed proposal [0-9a-f]{10} \(reply_send level 1 to 2\)\. It can no longer be confirmed, and no level changed/);
    expect(await proposalRow(idOf(dismiss))).toEqual({ status: "refused", decided_by: "operator:user-1", detail: "dismissed: waiting for more replies" });
    const audit = await db.prepare("SELECT agent_id, details FROM audit_log WHERE action = 'autonomy.proposal_dismissed' ORDER BY id DESC LIMIT 1").first<{ agent_id: string; details: string }>();
    expect(audit?.agent_id).toBe("operator:user-1");
    expect(JSON.parse(audit?.details ?? "{}")).toEqual({ proposalId: idOf(dismiss), actionClass: "reply_send", from: 1, to: 2, origin: "operator", withReason: true });
    expect(audit?.details).not.toContain("waiting");
    expect(kv.map.get("autonomy:reply_send")).toBeUndefined();
    expect(await changes()).toEqual([]);
    expect(await run(kv, "autonomy-status", later(2))).not.toMatch(/Open proposals/);
  });

  it("leaves a dismissed proposal impossible to confirm", async () => {
    const kv = memoryKv();
    const proposed = await run(kv, "autonomy-set reply_send 2");
    await run(kv, dismissIn(proposed), later(1));
    expect(await run(kv, confirmIn(proposed), later(2))).toMatch(/is refused\. Nothing changed/);
    expect(kv.map.get("autonomy:reply_send")).toBeUndefined();
    expect(await changes()).toEqual([]);
  });

  it("refuses to dismiss a proposal that is not pending: applied, already dismissed, expired or unknown", async () => {
    const kv = memoryKv();
    const applied = await run(kv, "autonomy-set reply_send 2");
    await run(kv, confirmIn(applied), later(1));
    expect(await run(kv, dismissIn(applied), later(2))).toMatch(/is applied, so there is nothing to dismiss/);
    expect(kv.map.get("autonomy:reply_send")).toBe("2");
    expect(await proposalRow(idOf(dismissIn(applied)))).toMatchObject({ status: "applied" });

    const twice = await run(kv, "autonomy-set reply_demo_link 2");
    await run(kv, dismissIn(twice), later(1));
    expect(await run(kv, dismissIn(twice), later(2))).toMatch(/is refused, so there is nothing to dismiss/);

    const stale = await run(kv, "autonomy-set cold_batch 2");
    expect(await run(kv, dismissIn(stale), later(31))).toMatch(/has already expired/);
    expect(await proposalRow(idOf(dismissIn(stale)))).toMatchObject({ status: "expired" });

    expect(await run(kv, "autonomy-dismiss-0000000000")).toMatch(/There is no autonomy proposal 0000000000/);
    const audits = await db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'autonomy.proposal_dismissed' AND details LIKE ?1").bind(`%${idOf(dismissIn(stale))}%`).first();
    expect(audits).toEqual({ n: 0 });
  });

  it("says when a dismissed weekly-review proposal can come back, and lists the dismiss command with open proposals", async () => {
    const kv = memoryKv();
    await run(kv, "autonomy-set reply_send 2");
    expect(await run(kv, "autonomy-status")).toMatch(/autonomy-confirm-[0-9a-f]{10}-[0-9a-f]{6}, or drop it with autonomy-dismiss-[0-9a-f]{10}/);
    await db
      .prepare("INSERT INTO autonomy_proposals (id, code, action_class, from_level, to_level, origin, based_on_change, requested_by, status, expires_at, created_at) VALUES ('abcdef0123', 'abcdef', 'cold_batch', 1, 2, 'review', 0, 'system:autonomy_review', 'open', ?1, ?2)")
      .bind(later(60 * 24).toISOString(), NOW.toISOString())
      .run();
    expect(await run(kv, "autonomy-dismiss-abcdef0123", later(1))).toMatch(/proposes the same change again no sooner than 14 days after it first did/);
  });
});

describe("autonomy-status", () => {
  it("lists levels, evidence, permanently human-only classes and open proposals", async () => {
    const kv = memoryKv({ "autonomy:cold_batch": "2" });
    await db.prepare("INSERT INTO autonomy_events (id, action_class, outcome, created_at) VALUES ('ae-1', 'reply_send', 'approved_unchanged', ?1)").bind(NOW.toISOString()).run();
    await run(kv, "autonomy-set reply_send 2");
    const text = await run(kv, "autonomy-status");
    expect(text).toMatch(/- cold_batch: level 2/);
    expect(text).toMatch(/- reply_send: level 1\. 1 approved as written/);
    expect(text).toMatch(/Permanently human-only, never above level 1: merge_code, pricing_billing_auth, offers, proof_of_value_send, data_deletion/);
    expect(text).toMatch(/Open proposals:\n- reply_send level 1 to 2 \(autonomy-set/);
  });
});

describe("the chat consumer", () => {
  function chatEnv(kv: MemoryKvNamespace): Env {
    return { DB: db, KV: kv as unknown as KVNamespace } as Env;
  }

  it("routes autonomy commands without the model, once per message, for allowlisted operators only", async () => {
    const kv = memoryKv({ "operator:agent_enabled": "true" });
    const operator = recordingOperator();
    const options = { config, operator: () => operator.channel, now: () => NOW };
    const message = { updateId: "u-1", chatId: "chat-1", userId: "user-1", sessionKey: "s-1", text: "autonomy-set reply_send 2" };
    await processChatMessage(options, chatEnv(kv), message);
    await processChatMessage(options, chatEnv(kv), message);
    expect(operator.messages).toHaveLength(1);
    expect(operator.messages[0]?.text).toMatch(/autonomy-confirm-/);

    const stranger = { ...message, updateId: "u-2", userId: "user-2", text: confirmIn(operator.messages[0]?.text ?? "") };
    await processChatMessage(options, chatEnv(kv), stranger);
    expect(operator.messages).toHaveLength(1);
    expect(await changes()).toEqual([]);

    await processChatMessage(options, chatEnv(kv), { ...stranger, userId: "user-1", updateId: "u-3" });
    expect(operator.messages.at(-1)?.text).toMatch(/now at level 2/);
    expect(kv.map.get("autonomy:reply_send")).toBe("2");
  });

  it("routes autonomy-dismiss for allowlisted operators only, recording the operator who sent it", async () => {
    const kv = memoryKv({ "operator:agent_enabled": "true" });
    const operator = recordingOperator();
    const options = { config, operator: () => operator.channel, now: () => NOW };
    const message = { updateId: "u-10", chatId: "chat-1", userId: "user-1", sessionKey: "s-10", text: "autonomy-set reply_send 2" };
    await processChatMessage(options, chatEnv(kv), message);
    const dismiss = dismissIn(operator.messages[0]?.text ?? "");
    await processChatMessage(options, chatEnv(kv), { ...message, updateId: "u-11", userId: "user-2", text: dismiss });
    expect(await db.prepare("SELECT status FROM autonomy_proposals WHERE id = ?1").bind(dismiss.slice(-10)).first()).toEqual({ status: "open" });
    await processChatMessage(options, chatEnv(kv), { ...message, updateId: "u-12", text: dismiss });
    expect(operator.messages.at(-1)?.text).toMatch(/Dismissed proposal/);
    expect(await db.prepare("SELECT status, decided_by FROM autonomy_proposals WHERE id = ?1").bind(dismiss.slice(-10)).first()).toEqual({ status: "refused", decided_by: "operator:user-1" });
  });
});
