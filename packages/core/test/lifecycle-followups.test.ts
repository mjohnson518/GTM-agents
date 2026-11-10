// GTM-agents: lifecycle follow-ups to product users: the rules, the sweep's order of checks, the
// classifier gate, sending through the send function at level 2, drafts at level 1, offers that are
// always drafted, the caps, erasure, the window, the fu-approve and fu-reject commands with every
// re-check, and the autonomy evidence each decision records (none for offers, and never at the cost
// of a send). Every person, address and id is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { recordingOperator } from "../src/agents/testing.ts";
import { defineConfig } from "../src/config/index.ts";
import { isPermanentHuman } from "../src/autonomy/levels.ts";
import { followupEvidenceClass } from "../src/lifecycle/followup-evidence.ts";
import { FOLLOWUP_RULES, capProblem, dueWindow, predecessorPending } from "../src/lifecycle/followup-rules.ts";
import { parseFollowupCommand, runFollowupCommand } from "../src/lifecycle/followup-commands.ts";
import { runLifecycleFollowups, type FollowupDeps } from "../src/lifecycle/followups.ts";
import { flagReader, resetOutreachTables, silentLogger } from "../src/outreach/testing.ts";
import type { CompletionRequest, ModelGateway } from "../src/ports/model.ts";
import { createOutreachSender } from "../src/sending/boundary.ts";
import { addSuppression } from "../src/sending/suppression.ts";
import type { ServedTemplate } from "../src/templates/store.ts";
import { NOW, harness, insertContact, type Harness, type TestContact } from "./delivery-fakes.ts";
import { acmeConfig } from "./fixtures.ts";

const db = env.DB;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number, from = NOW) => new Date(from.getTime() - ms).toISOString();
const CHAT = "4249001";
const config = defineConfig({
  ...acmeConfig,
  operator: { allowedChatIds: [CHAT], allowedUserIds: [CHAT] },
  models: { roles: { classifier: "test-classifier" }, pricing: { "test-classifier": { inputCentsPerMTok: 10, outputCentsPerMTok: 40 } } },
});
const ON = { "lifecycle:enabled": "true", "lifecycle:followups_enabled": "true" };

const template = (id: string, subject: string, body: string): ServedTemplate => ({
  id,
  meta: { id, kind: "lifecycle", status: "approved", angle: "none", subject, volume_weight: 1 },
  subject,
  body,
  sha256: "0".repeat(64),
});
const TEMPLATES: ServedTemplate[] = [
  template(
    "lifecycle-first-use",
    "Getting started with Acme Quarantine",
    "Hi {{first_name}},\n\nThanks for signing up for Acme Quarantine. The quickest way to see it work is to connect one CI pipeline and let it watch a few runs.\n\nIf anything gets in the way, just reply and I will help you get set up.\n\n{{sender_name}}",
  ),
  template(
    "lifecycle-usefulness",
    "Was Acme useful on your first runs?",
    "Hi {{first_name}},\n\nI saw your team has started using Acme. Every quarantined test gets an owner and a history of its failures.\n\nWas it useful so far, and did anything get in the way? A short reply is plenty.\n\n{{sender_name}}",
  ),
  template(
    "lifecycle-reengage",
    "Picking up where you left off with Acme",
    "Hi {{first_name}},\n\nIt looks like Acme has been quiet on your side lately. Connecting a pipeline again is usually quick.\n\nDid something get in the way that I could help with? A short reply is plenty.\n\n{{sender_name}}",
  ),
  template(
    "lifecycle-upgrade-offer",
    "Room to keep going",
    "Hi {{first_name}},\n\nYou have reached the limit of your current plan. If your team wants to keep going, a larger plan lifts it, and I can set that up for you.\n\nReply here if you would like that, or if you have questions first.\n\n{{sender_name}}",
  ),
];

function fakeModel(answer = "yes") {
  const calls: CompletionRequest[] = [];
  const gateway: ModelGateway = {
    name: "fake-model",
    complete(request) {
      calls.push(request);
      return Promise.resolve({ text: answer, toolCalls: [], stopReason: "end", usage: { inputTokens: 40, outputTokens: 1 }, model: "test-classifier" });
    },
    embed: () => Promise.resolve({ vectors: [], model: "none" }),
  };
  return { calls, gateway };
}

let operator: ReturnType<typeof recordingOperator>;
let h: Harness;
let model: ReturnType<typeof fakeModel>;
let spent: number;
const spend = { allow: () => Promise.resolve(true), recordModel: () => Promise.resolve(void (spent += 1)) };

const sweep = (overrides: Partial<FollowupDeps> = {}, values: Record<string, string> = {}) =>
  runLifecycleFollowups({
    db,
    flags: flagReader({ ...ON, ...values }),
    config,
    now: NOW,
    log: silentLogger,
    templates: () => Promise.resolve(TEMPLATES),
    model: model.gateway,
    spend,
    send: createOutreachSender(h.deps),
    operator: operator.channel,
    chatId: CHAT,
    ...overrides,
  });
const command = (text: string, options: { now?: Date; values?: Record<string, string>; sendNow?: Date } = {}) => {
  const parsed = parseFollowupCommand(text);
  if (!parsed) throw new Error(`not a follow-up command: ${text}`);
  const sender = options.sendNow ? createOutreachSender(harness(db, { now: () => options.sendNow as Date, kv: h.kv }).deps) : createOutreachSender(h.deps);
  return runFollowupCommand({ db, flags: flagReader({ ...ON, ...(options.values ?? {}) }), config, send: sender, operator: operator.channel, chatId: CHAT, userId: CHAT, now: () => options.now ?? NOW }, parsed);
};

/** A product user who entered `state` `since` ago. */
async function productUser(state: string, since: number, options: { email?: string; timezone?: string | null } = {}): Promise<TestContact> {
  const contact = await insertContact(db, { warmth: "hot", ...(options.email ? { email: options.email } : {}), ...(options.timezone !== undefined ? { timezone: options.timezone } : {}) });
  await db
    .prepare("INSERT INTO contact_lifecycle (contact_id, state, state_changed_at, signed_up_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(contact.id, state, ago(since), ago(Math.max(since, 25 * HOUR)))
    .run();
  return contact;
}
const followups = (contactId: string) =>
  db.prepare("SELECT id, kind, status, reason, draft_id, shown_digest, decided_by FROM lifecycle_followups WHERE contact_id = ?1 ORDER BY created_at").bind(contactId).all<Record<string, string | null>>().then((r) => r.results);
const idOf = async (contactId: string) => (await followups(contactId))[0]?.id ?? "";

beforeEach(async () => {
  await db.prepare("DELETE FROM lifecycle_followups").run();
  await resetOutreachTables(db);
  operator = recordingOperator();
  h = harness(db);
  model = fakeModel();
  spent = 0;
});

describe("the rules", () => {
  it("caps at 4 in 30 days and keeps each kind's gap", () => {
    const rule = FOLLOWUP_RULES.first_use;
    expect(capProblem([], NOW, rule)).toBeNull();
    expect(capProblem([NOW.getTime() - 2 * DAY], NOW, rule)).toBe("gap");
    expect(capProblem([NOW.getTime() - 2 * DAY], NOW, FOLLOWUP_RULES.last_first_use)).toBeNull();
    expect(capProblem([4, 8, 12, 16].map((d) => NOW.getTime() - d * DAY), NOW, rule)).toBe("cap");
    expect(capProblem([4, 8, 12, 31].map((d) => NOW.getTime() - d * DAY), NOW, rule)).toBeNull();
  });

  it("waits for a predecessor still being decided, and only while it is fresh", () => {
    const rule = FOLLOWUP_RULES.last_first_use;
    const entered = ago(73 * HOUR);
    expect(predecessorPending(rule, "drafted", entered, NOW)).toBe(true);
    expect(predecessorPending(rule, "sent", entered, NOW)).toBe(false);
    expect(predecessorPending(rule, "skipped", entered, NOW)).toBe(false);
    expect(predecessorPending(rule, null, entered, NOW)).toBe(false);
    expect(predecessorPending(rule, null, ago(70 * HOUR), NOW)).toBe(true);
  });

  it("is due only while fresh, so turning the feature on never mails old stays", () => {
    const { dueBy, freshAfter } = dueWindow(FOLLOWUP_RULES.win_back, NOW);
    expect(dueBy).toBe(ago(30 * DAY));
    expect(freshAfter).toBe(ago(44 * DAY));
  });

  it("keeps offers permanently human", () => {
    expect(FOLLOWUP_RULES.upgrade_offer).toMatchObject({ actionClass: "offers", offer: true });
    expect(FOLLOWUP_RULES.win_back).toMatchObject({ actionClass: "offers", offer: true });
  });

  it("counts each kind's decisions toward its own earnable class, and an offer's toward none", () => {
    for (const rule of Object.values(FOLLOWUP_RULES)) {
      const cls = followupEvidenceClass(rule);
      if (rule.offer) expect(cls, rule.kind).toBeNull();
      else expect(cls, rule.kind).toBe(rule.actionClass);
      if (cls) expect(isPermanentHuman(cls), rule.kind).toBe(false);
    }
    // Even a rule that named an earnable class but was marked an offer counts toward none.
    expect(followupEvidenceClass({ actionClass: "reengage", offer: true })).toBeNull();
    expect(followupEvidenceClass({ actionClass: "offers", offer: false })).toBeNull();
  });

  it("parses the commands, and nothing else", () => {
    expect(parseFollowupCommand("fu-approve-0123456789")).toEqual({ action: "approve", id: "0123456789" });
    expect(parseFollowupCommand(" FU-REJECT-abcdefabcd ")).toEqual({ action: "reject", id: "abcdefabcd" });
    expect(parseFollowupCommand("fu-approve-0123456789 please")).toBeNull();
    expect(parseFollowupCommand("fu-approve-xyz")).toBeNull();
  });
});

describe("the sweep", () => {
  it("drafts at level 1 and shows the operator the exact text with its commands", async () => {
    const person = await productUser("signed_up", 25 * HOUR);
    const result = await sweep();
    expect(result).toMatchObject({ candidates: 1, drafted: 1, sent: 0 });
    expect(h.provider.messages()).toHaveLength(0);
    const [row] = await followups(person.id);
    expect(row).toMatchObject({ kind: "first_use", status: "drafted" });
    expect(row?.shown_digest).toMatch(/^[0-9a-f]{64}$/);
    const text = operator.messages.map((m) => m.text).join("\n");
    expect(text).toContain(`fu-approve-${row?.id}`);
    expect(text).toContain("Hi Riley,");
    // The classifier saw structured facts only, fenced, under the classifier role.
    expect(model.calls[0]?.role).toBe("classifier");
    const facts = model.calls[0]?.messages[0]?.content;
    expect(typeof facts).toBe("string");
    expect(facts as string).toMatch(/^<facts>[\s\S]*<\/facts>$/);
    expect(facts as string).not.toContain(person.email);
    // A second sweep finds nothing to decide.
    expect((await sweep()).candidates).toBe(0);
  });

  it("sends at level 2 through the send function, once, even when two sweeps race", async () => {
    const person = await productUser("signed_up", 25 * HOUR);
    const level2 = { "autonomy:lifecycle_activation": "2" };
    const [a, b] = await Promise.all([sweep({}, level2), sweep({}, level2)]);
    expect(a.sent + b.sent).toBe(1);
    expect(h.provider.messages()).toHaveLength(1);
    expect(h.provider.messages()[0]?.to.email).toBe(person.email);
    const rows = await followups(person.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "sent", decided_by: "auto:L2" });
    expect(operator.messages.some((m) => m.text.includes("level 2"))).toBe(true);
  });

  it("never sends an offer, whatever the levels say, and the database refuses to record one sent without a person", async () => {
    const person = await productUser("at_wall", 20 * 60_000);
    const result = await sweep({}, { "autonomy:offers": "3", "autonomy:lifecycle_activation": "3" });
    expect(result.drafted).toBe(1);
    expect(h.provider.messages()).toHaveLength(0);
    const [row] = await followups(person.id);
    expect(row).toMatchObject({ kind: "upgrade_offer", status: "drafted" });
    await expect(db.prepare("UPDATE lifecycle_followups SET status = 'sent', decided_by = 'auto:L3' WHERE id = ?1").bind(row?.id).run()).rejects.toThrow();
  });

  it("skips a 'no' from the classifier for good, and waits when the classifier cannot answer", async () => {
    const said = await productUser("signed_up", 25 * HOUR);
    model = fakeModel("no");
    expect((await sweep()).skipped).toBe(1);
    expect((await followups(said.id))[0]).toMatchObject({ status: "skipped", reason: "the classifier said no" });
    await db.prepare("DELETE FROM lifecycle_followups").run();
    const noModel = await sweep({ model: undefined });
    expect(noModel.waiting).toBe(1);
    expect(await followups(said.id)).toHaveLength(0);
    const noBudget = await sweep({ spend: { allow: () => Promise.resolve(false), recordModel: () => Promise.resolve() } });
    expect(noBudget.waits).toEqual({ "the budget refused the classifier": 1 });
  });

  it("skips level 0 and suppressed or erased people before spending anything", async () => {
    const observed = await productUser("signed_up", 25 * HOUR);
    expect((await sweep({}, { "autonomy:lifecycle_activation": "0" })).skipped).toBe(1);
    expect((await followups(observed.id))[0]?.reason).toContain("level 0");
    const suppressed = await productUser("signed_up", 26 * HOUR);
    await addSuppression(db, { email: suppressed.email, reason: "opt_out" });
    expect((await sweep()).skipped).toBe(1);
    expect((await followups(suppressed.id))[0]?.reason).toBe("the address is suppressed");
    expect(model.calls).toHaveLength(0);
    expect(spent).toBe(0);
  });

  it("holds to the caps and the gap", async () => {
    const person = await productUser("signed_up", 25 * HOUR);
    await db
      .prepare("INSERT INTO lifecycle_followups (id, contact_id, kind, state, entered_at, action_class, status, sent_at) VALUES ('aaaaaaaaaa', ?1, 'usefulness', 'activated', ?2, 'feedback', 'sent', ?3)")
      .bind(person.id, ago(40 * DAY), ago(DAY))
      .run();
    expect((await sweep()).waits).toEqual({ gap: 1 });
    expect(model.calls).toHaveLength(0);
  });

  it("waits outside the recipient's window at level 2, before the classifier", async () => {
    await productUser("signed_up", 25 * HOUR);
    const saturday = new Date("2026-11-07T17:00:00.000Z");
    await db.prepare("UPDATE contact_lifecycle SET state_changed_at = ?1").bind(ago(25 * HOUR, saturday)).run();
    expect((await sweep({ now: saturday }, { "autonomy:lifecycle_activation": "2" })).waits).toEqual({ window: 1 });
    expect(model.calls).toHaveLength(0);
  });

  it("withdraws a drafted follow-up once the contact moves on", async () => {
    const person = await productUser("signed_up", 25 * HOUR);
    await sweep();
    await db.prepare("UPDATE contact_lifecycle SET state = 'activated', state_changed_at = ?2 WHERE contact_id = ?1").bind(person.id, ago(10 * 60_000)).run();
    expect((await sweep()).withdrawn).toBe(1);
    expect((await followups(person.id))[0]?.status).toBe("withdrawn");
    const draft = await db.prepare("SELECT status FROM drafts WHERE contact_id = ?1").bind(person.id).first<{ status: string }>();
    expect(draft?.status).toBe("rejected");
  });
});

describe("the commands", () => {
  it("sends an approved draft once, through the send function, with the approved digest", async () => {
    const person = await productUser("signed_up", 25 * HOUR);
    await sweep();
    const id = await idOf(person.id);
    expect(await command(`fu-approve-${id}`)).toContain("Sent the first-use nudge");
    expect(h.provider.messages()).toHaveLength(1);
    expect(await command(`fu-approve-${id}`)).toContain("is sent");
    expect(h.provider.messages()).toHaveLength(1);
    expect((await followups(person.id))[0]).toMatchObject({ status: "sent", decided_by: `operator:${CHAT}` });
  });

  it("lets a person send an offer", async () => {
    const person = await productUser("at_wall", 20 * 60_000);
    await sweep();
    expect(await command(`fu-approve-${await idOf(person.id)}`)).toContain("Sent the upgrade offer");
    expect(h.provider.messages()).toHaveLength(1);
  });

  it("drops it on fu-reject, and refuses while the flag is off", async () => {
    const person = await productUser("signed_up", 25 * HOUR);
    await sweep();
    const id = await idOf(person.id);
    expect(await command(`fu-approve-${id}`, { values: { "lifecycle:followups_enabled": "false" } })).toContain("off");
    expect(await command(`fu-reject-${id}`)).toContain("Dropped");
    expect(await command(`fu-approve-${id}`)).toContain("is rejected");
    expect(h.provider.messages()).toHaveLength(0);
  });

  it("re-checks the stay, the age and the content before sending", async () => {
    const moved = await productUser("signed_up", 25 * HOUR);
    await sweep();
    await db.prepare("UPDATE contact_lifecycle SET state = 'activated', state_changed_at = ?2 WHERE contact_id = ?1").bind(moved.id, ago(60_000)).run();
    expect(await command(`fu-approve-${await idOf(moved.id)}`)).toContain("withdrawn");

    const late = await productUser("signed_up", 26 * HOUR);
    await sweep();
    expect(await command(`fu-approve-${await idOf(late.id)}`, { now: new Date(NOW.getTime() + 3 * DAY) })).toContain("too old");

    const edited = await productUser("signed_up", 27 * HOUR);
    await sweep();
    const id = await idOf(edited.id);
    await db.prepare("UPDATE drafts SET body = body || ' Edited.' WHERE contact_id = ?1").bind(edited.id).run();
    const before = operator.messages.length;
    expect(await command(`fu-approve-${id}`)).toContain("review the version above");
    expect(operator.messages.length).toBe(before + 1);
    expect(h.provider.messages()).toHaveLength(0);
    expect(await command(`fu-approve-${id}`)).toContain("Sent");
    expect(h.provider.messages()[0]?.text).toContain("Edited.");
  });

  it("refuses outside the window, then hands it over when the command is repeated within an hour", async () => {
    const person = await productUser("signed_up", 25 * HOUR);
    await sweep();
    const id = await idOf(person.id);
    const evening = new Date("2026-11-04T23:30:00.000Z");
    expect(await command(`fu-approve-${id}`, { now: evening, sendNow: evening })).toContain("outside");
    expect(await command(`fu-approve-${id}`, { now: new Date(evening.getTime() + 2 * HOUR), sendNow: evening })).toContain("outside");
    const again = new Date(evening.getTime() + 2 * HOUR + 10 * 60_000);
    expect(await command(`fu-approve-${id}`, { now: again, sendNow: again })).toContain("holds it");
    expect(h.provider.messages()).toHaveLength(0);
    expect((await followups(person.id))[0]?.status).toBe("queued");
  });
});

describe("autonomy evidence from follow-up decisions", () => {
  const evidence = () => db.prepare("SELECT action_class, outcome, subject_id FROM autonomy_events ORDER BY created_at").all<Record<string, string>>().then((r) => r.results);

  /** The test database, refusing any statement that matches `pattern`. */
  function refusing(pattern: RegExp): D1Database {
    return new Proxy(db, {
      get(target, prop) {
        if (prop === "prepare")
          return (sql: string) => {
            if (pattern.test(sql)) throw new Error("the database refused the statement");
            return target.prepare(sql);
          };
        const value: unknown = Reflect.get(target, prop);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  it("counts an approval as written toward the follow-up's own earnable class, once", async () => {
    const person = await productUser("signed_up", 25 * HOUR);
    await sweep();
    const id = await idOf(person.id);
    expect(await evidence()).toEqual([]);
    expect(await command(`fu-approve-${id}`)).toContain("Sent");
    expect(await command(`fu-approve-${id}`)).toContain("is sent");
    expect(await evidence()).toEqual([{ action_class: "lifecycle_activation", outcome: "approved_unchanged", subject_id: id }]);
  });

  it("counts an approval after an edit as edited, and a rejection as rejected", async () => {
    const edited = await productUser("activated", 3 * HOUR);
    const dropped = await productUser("stalled", 2 * HOUR);
    await sweep();
    const editedId = await idOf(edited.id);
    const droppedId = await idOf(dropped.id);
    await db.prepare("UPDATE drafts SET body = body || ' Edited.' WHERE contact_id = ?1").bind(edited.id).run();
    expect(await command(`fu-approve-${editedId}`)).toContain("review the version above");
    expect(await evidence()).toEqual([]);
    expect(await command(`fu-approve-${editedId}`)).toContain("Sent");
    expect(await command(`fu-reject-${droppedId}`)).toContain("Dropped");
    const rows = await evidence();
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        { action_class: "feedback", outcome: "approved_edited", subject_id: editedId },
        { action_class: "reengage", outcome: "rejected", subject_id: droppedId },
      ]),
    );
  });

  it("records nothing for an offer, approved or rejected, under any class", async () => {
    const approved = await productUser("at_wall", 20 * 60_000);
    const rejected = await productUser("at_wall", 25 * 60_000);
    await sweep({}, { "autonomy:offers": "3", "autonomy:lifecycle_activation": "3" });
    expect(await command(`fu-approve-${await idOf(approved.id)}`)).toContain("Sent the upgrade offer");
    expect(await command(`fu-reject-${await idOf(rejected.id)}`)).toContain("Dropped");
    expect(h.provider.messages()).toHaveLength(1);
    expect(await evidence()).toEqual([]);
  });

  it("counts a send at an earned level as auto_sent for its class", async () => {
    const person = await productUser("signed_up", 25 * HOUR);
    expect((await sweep({}, { "autonomy:lifecycle_activation": "2" })).sent).toBe(1);
    expect(await evidence()).toEqual([{ action_class: "lifecycle_activation", outcome: "auto_sent", subject_id: await idOf(person.id) }]);
  });

  it("never blocks or fails a send when the evidence cannot be written", async () => {
    const person = await productUser("signed_up", 25 * HOUR);
    await sweep();
    const parsed = parseFollowupCommand(`fu-approve-${await idOf(person.id)}`);
    if (!parsed) throw new Error("not a follow-up command");
    const reply = await runFollowupCommand({ db: refusing(/INSERT INTO autonomy_events/), flags: flagReader(ON), config, send: createOutreachSender(h.deps), operator: operator.channel, chatId: CHAT, userId: CHAT, now: () => NOW }, parsed);
    expect(reply).toContain("Sent the first-use nudge");
    expect(h.provider.messages()).toHaveLength(1);
    expect((await followups(person.id))[0]?.status).toBe("sent");
    expect(await evidence()).toEqual([]);
    const auto = await productUser("signed_up", 26 * HOUR);
    const result = await sweep({ db: refusing(/INSERT INTO autonomy_events/) }, { "autonomy:lifecycle_activation": "2" });
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect((await followups(auto.id))[0]?.status).toBe("sent");
    expect(await evidence()).toEqual([]);
  });
});
