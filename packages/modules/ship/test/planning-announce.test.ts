// GTM-agents: AnnounceShipped and the "you asked, it is live" notes: the theme is marked shipped and
// the operator paged once; notes are drafted from the approved template for requesters who are
// product users, skipping anyone who cannot be resolved, is erased or suppressed; they go out only
// through the send function on the lifecycle path with the draft's digest, automatically only at
// ship_notification level 2; ship-note-approve sends exactly the version its code names, and a
// failure never fails the caller. Every person and address is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "@gtm-agents/core";
import { memoryKv, recordingOperator, type RecordingOperator } from "@gtm-agents/core/agents/testing";
import { fakeSendOutreach, silentLogger, type FakeSend } from "@gtm-agents/core/outreach/testing";
import { draftDigest } from "@gtm-agents/core/security";
import { addSuppression, type OutreachOutcome } from "@gtm-agents/core/sending";
import { createAnnounceShipped } from "../src/announce.ts";
import { createShipCommands } from "../src/planning-commands.ts";
import { parseSpec, storedSpec } from "../src/spec.ts";
import { SHIP_LIVE_TEMPLATE, SHIP_ON, SHIP_TEST_REPO, recordingBuild, resetShipTables, seedFeedback, seedPerson, seedTheme, shipTestConfig, specAnswer } from "../src/planning-testing.ts";

const db = (env as unknown as { DB: D1Database }).DB;
const config = shipTestConfig();
const NOW = new Date("2026-11-10T15:00:00.000Z");

function harness(options: { flags?: Record<string, string>; send?: FakeSend | null; operator?: RecordingOperator } = {}) {
  const kv = memoryKv(options.flags ?? { ...SHIP_ON });
  const operator = options.operator ?? recordingOperator();
  const send = options.send === null ? undefined : (options.send ?? fakeSendOutreach());
  const testEnv = { DB: db, KV: kv, PRODUCT_APP_URL: "https://app.acme.example" } as unknown as Env;
  const announce = createAnnounceShipped<Env>({
    config,
    flags: (e) => ({ get: (key) => (e.KV as unknown as typeof kv).get(key) }),
    operator: () => operator.channel,
    send: () => send?.send,
    templates: [SHIP_LIVE_TEMPLATE],
    templateId: "ship-live",
    maxNotes: 50,
    chatId: "4251001",
    log: silentLogger,
  });
  const commands = createShipCommands<Env>({ config, startBuild: recordingBuild<Env>().start, send: () => send?.send, baseBranch: "main", repo: SHIP_TEST_REPO, log: silentLogger });
  const say = (text: string) => {
    const handler = commands.match(text);
    if (!handler) throw new Error(`not a ship command: ${text}`);
    return handler({ env: testEnv, now: NOW, actor: "operator:4251001", sessionKey: "s1" });
  };
  return { announce: (taskId: string) => announce(testEnv, taskId, NOW), say, operator, send, kv };
}

async function shippedTask(): Promise<{ themeId: string; taskId: string }> {
  const spec = parseSpec(specAnswer())!;
  const themeId = await seedTheme(db, { status: "merged", title: "Export quarantined tests as CSV", spec: storedSpec(spec) });
  const taskId = `st_${themeId}`;
  await db.prepare("INSERT INTO ship_tasks (id, theme_id, repo, base_branch, status, pr_number) VALUES (?1, ?2, ?3, 'main', 'deployed', 42)").bind(taskId, themeId, SHIP_TEST_REPO).run();
  return { themeId, taskId };
}

const notes = (themeId: string) =>
  db.prepare("SELECT n.id, n.status, n.reason, n.contact_id, d.status AS draft_status, d.kind, d.action_class, d.subject, d.body, d.recipient_email, d.approved_digest FROM ship_notes n LEFT JOIN drafts d ON d.id = n.draft_id WHERE n.theme_id = ?1").bind(themeId).all<Record<string, string | null>>().then((r) => r.results);
const codeIn = (text: string, id: string) => new RegExp(`ship-note-approve-${id} ([0-9a-f]{32})`).exec(text)?.[1] ?? "";

beforeEach(async () => {
  await resetShipTables(db);
});

describe("announcing a shipped task", () => {
  it("marks the theme and its feedback shipped and pages the operator once", async () => {
    const { themeId, taskId } = await shippedTask();
    const fb = await seedFeedback(db, { text: "please add export", status: "themed", themeId, summary: "Users want an export." });
    const h = harness();
    await h.announce(taskId);
    await h.announce(taskId);
    const theme = await db.prepare("SELECT status, shipped_at FROM themes WHERE id = ?1").bind(themeId).first<{ status: string; shipped_at: string }>();
    expect(theme).toMatchObject({ status: "shipped", shipped_at: NOW.toISOString() });
    expect((await db.prepare("SELECT status FROM feedback_items WHERE id = ?1").bind(fb).first<{ status: string }>())?.status).toBe("shipped");
    const pages = h.operator.messages.filter((m) => m.text.startsWith("Shipped:"));
    expect(pages).toHaveLength(1);
    expect(pages[0]?.text).toContain("pull request #42");
    expect(pages[0]?.text).not.toContain("please add export");
  });

  it("never fails its caller, whatever goes wrong", async () => {
    const h = harness();
    await expect(h.announce("st_missing")).resolves.toBeUndefined();
    await expect(h.announce("'; DROP TABLE themes; --")).resolves.toBeUndefined();
    const broken = createAnnounceShipped<Env>({
      config,
      flags: () => ({ get: () => Promise.resolve("true") }),
      operator: () => {
        throw new Error("channel misconfigured");
      },
      send: () => undefined,
      templates: [SHIP_LIVE_TEMPLATE],
      templateId: "ship-live",
      maxNotes: 50,
      chatId: undefined,
      log: silentLogger,
    });
    const failingDb = { prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error("database unavailable")) }) }) } as unknown as D1Database;
    await expect(broken({ DB: failingDb } as unknown as Env, "st_x", NOW)).resolves.toBeUndefined();
  });

  it("changes nothing while ship:enabled is off", async () => {
    const { themeId, taskId } = await shippedTask();
    await harness({ flags: {} }).announce(taskId);
    expect((await db.prepare("SELECT status FROM themes WHERE id = ?1").bind(themeId).first<{ status: string }>())?.status).toBe("merged");
  });

  it("still ships the theme and pages, but drafts no note, while ship:notes_enabled is off", async () => {
    const { themeId, taskId } = await shippedTask();
    const ada = await seedPerson(db);
    await seedFeedback(db, { text: "x", contactId: ada.id, status: "themed", themeId });
    const h = harness({ flags: { "ship:enabled": "true" } });
    await h.announce(taskId);
    expect(await notes(themeId)).toHaveLength(0);
    expect(h.operator.texts().join("\n")).toContain("ship:notes_enabled is off");
  });
});

describe("drafting notes", () => {
  it("drafts a plain-text note from the template for each requester who is a product user", async () => {
    const { themeId, taskId } = await shippedTask();
    const ada = await seedPerson(db, { first: "Ada" });
    const grace = await seedPerson(db, { first: "Grace", productUserId: "pu-grace-1" });
    await seedFeedback(db, { text: "x", contactId: ada.id, status: "themed", themeId });
    await seedFeedback(db, { text: "y", contactId: ada.id, status: "themed", themeId });
    await seedFeedback(db, { text: "z", productUserId: "pu-grace-1", status: "themed", themeId });
    const h = harness();
    await h.announce(taskId);
    const rows = await notes(themeId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.contact_id))).toEqual(new Set([ada.id, grace.id]));
    for (const r of rows) {
      expect(r).toMatchObject({ status: "drafted", draft_status: "pending_approval", kind: "lifecycle", action_class: "ship_notification", subject: "The change you asked for is live" });
      expect(r.body).toContain("it is live now: Export quarantined tests as CSV.");
      expect(r.body).not.toMatch(/<[a-z]/i);
    }
    expect(h.send?.calls).toHaveLength(0);
    const previews = h.operator.messages.filter((m) => m.text.includes("Send exactly this: ship-note-approve-"));
    expect(previews).toHaveLength(2);
  });

  it("skips anyone it cannot resolve or may not write to", async () => {
    const { themeId, taskId } = await shippedTask();
    const prospect = await seedPerson(db, { productUser: false });
    const erased = await seedPerson(db, { productUserId: "pu-erased-1" });
    const suppressed = await seedPerson(db);
    const nameless = await seedPerson(db, { first: null });
    await db
      .prepare("INSERT INTO erasure_tombstones (email_sha256, product_user_id, source, erased_at) VALUES (?1, 'pu-erased-1', 'product', ?2)")
      .bind("e".repeat(64), NOW.toISOString())
      .run();
    await addSuppression(db, { email: suppressed.email, reason: "opt_out", source: "test" });
    for (const p of [prospect, erased, suppressed, nameless]) await seedFeedback(db, { text: "x", contactId: p.id, status: "themed", themeId });
    await seedFeedback(db, { text: "anonymous", status: "themed", themeId });
    await seedFeedback(db, { text: "unknown user", productUserId: "pu-nobody", status: "themed", themeId });
    const h = harness();
    await h.announce(taskId);
    const rows = await notes(themeId);
    expect(rows.every((r) => r.status === "skipped")).toBe(true);
    const reason = (id: string) => rows.find((r) => r.contact_id === id)?.reason ?? "";
    expect(reason(prospect.id)).toContain("not a product user");
    expect(reason(erased.id)).toContain("erased");
    expect(reason(suppressed.id)).toContain("suppressed");
    expect(reason(nameless.id)).toContain("first_name");
    expect(h.operator.texts().join("\n")).toContain("2 could not be resolved");
    expect(h.send?.calls).toHaveLength(0);
  });

  it("drafts nothing new when the same theme is announced again, and never leaves a claim without its draft", async () => {
    const { themeId, taskId } = await shippedTask();
    const ada = await seedPerson(db);
    await seedFeedback(db, { text: "x", contactId: ada.id, status: "themed", themeId });
    const h = harness();
    await h.announce(taskId);
    await h.announce(taskId);
    expect(await notes(themeId)).toHaveLength(1);
    expect(Number((await db.prepare("SELECT COUNT(*) AS n FROM drafts").first<{ n: number }>())?.n)).toBe(1);
    // The claim and its draft are written together: the one note has its draft, waiting.
    expect((await notes(themeId))[0]).toMatchObject({ status: "drafted", draft_status: "pending_approval" });
  });

  it("sends automatically only at ship_notification level 2, through the send function on the lifecycle path with the draft's digest", async () => {
    const { themeId, taskId } = await shippedTask();
    const ada = await seedPerson(db);
    await seedFeedback(db, { text: "x", contactId: ada.id, status: "themed", themeId });
    const h = harness({ flags: { ...SHIP_ON, "autonomy:ship_notification": "2" } });
    await h.announce(taskId);
    const [row] = await notes(themeId);
    expect(row).toMatchObject({ status: "sent", draft_status: "approved" });
    const items = h.send?.items() ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ path: "lifecycle", contactId: ada.id, to: ada.email, idempotencyKey: `ship_note:${row?.id}` });
    expect(items[0]?.approvedDigest).toBe(await draftDigest({ to: row?.recipient_email, subject: row?.subject, body: row?.body }));
    const evidence = await db.prepare("SELECT outcome FROM autonomy_events WHERE action_class = 'ship_notification'").all<{ outcome: string }>();
    expect(evidence.results.map((e) => e.outcome)).toEqual(["auto_sent"]);
    expect(h.operator.texts().join("\n")).toContain("level 2");
  });

  it("returns a note the send function definitely did not take to the operator as a draft", async () => {
    const { themeId, taskId } = await shippedTask();
    const ada = await seedPerson(db);
    await seedFeedback(db, { text: "x", contactId: ada.id, status: "themed", themeId });
    const failing = fakeSendOutreach((item): OutreachOutcome => ({ idempotencyKey: item.idempotencyKey, status: "failed", retryable: true, message: "[SEND BLOCKED:disabled] delivery is off" }));
    const h = harness({ flags: { ...SHIP_ON, "autonomy:ship_notification": "2" }, send: failing });
    await h.announce(taskId);
    const [row] = await notes(themeId);
    expect(row).toMatchObject({ status: "drafted", draft_status: "pending_approval", approved_digest: null });
    expect(h.operator.texts().join("\n")).toContain("waits for you");
  });

  it("drafts at level 2 when no send function is wired, and never sends", async () => {
    const { themeId, taskId } = await shippedTask();
    const ada = await seedPerson(db);
    await seedFeedback(db, { text: "x", contactId: ada.id, status: "themed", themeId });
    await harness({ flags: { ...SHIP_ON, "autonomy:ship_notification": "2" }, send: null }).announce(taskId);
    expect((await notes(themeId))[0]).toMatchObject({ status: "drafted", draft_status: "pending_approval" });
  });
});

describe("ship-note-approve and ship-note-decline", () => {
  async function drafted() {
    const { themeId, taskId } = await shippedTask();
    const ada = await seedPerson(db);
    await seedFeedback(db, { text: "x", contactId: ada.id, status: "themed", themeId });
    const h = harness();
    await h.announce(taskId);
    const [row] = await notes(themeId);
    const preview = h.operator.messages.find((m) => m.text.includes(`ship-note-approve-${row?.id}`))?.text ?? "";
    return { h, themeId, ada, id: row?.id ?? "", code: codeIn(preview, row?.id ?? "") };
  }

  it("sends exactly the version the code names, once", async () => {
    const { h, themeId, id, code } = await drafted();
    expect(code).toHaveLength(32);
    expect(await h.say(`ship-note-approve-${id} ${code}`)).toContain("Sent the note");
    expect(await h.say(`ship-note-approve-${id} ${code}`)).toContain("is sent");
    expect(h.send?.items()).toHaveLength(1);
    expect(h.send?.items()[0]).toMatchObject({ path: "lifecycle" });
    expect((await notes(themeId))[0]).toMatchObject({ status: "sent", draft_status: "approved" });
    const evidence = await db.prepare("SELECT outcome FROM autonomy_events WHERE action_class = 'ship_notification'").all<{ outcome: string }>();
    expect(evidence.results.map((e) => e.outcome)).toEqual(["approved_unchanged"]);
  });

  it("sends nothing without a code, or with a code for another version", async () => {
    const { h, themeId, id, code } = await drafted();
    expect(await h.say(`ship-note-approve-${id}`)).toContain(`ship-note-approve-${id} ${code}`);
    await db.prepare("UPDATE drafts SET body = body || ' Also, a discount.' WHERE status = 'pending_approval'").run();
    const text = await h.say(`ship-note-approve-${id} ${code}`);
    expect(text).toContain("not this note's current version");
    expect(text).toContain("Also, a discount.");
    expect(h.send?.items()).toHaveLength(0);
    expect((await notes(themeId))[0]?.status).toBe("drafted");
  });

  it("drops a note whose person was suppressed after it was drafted", async () => {
    const { h, themeId, ada, id, code } = await drafted();
    await addSuppression(db, { email: ada.email, reason: "opt_out", source: "test" });
    expect(await h.say(`ship-note-approve-${id} ${code}`)).toContain("suppressed or erased");
    expect(h.send?.items()).toHaveLength(0);
    expect((await notes(themeId))[0]).toMatchObject({ status: "skipped", draft_status: "rejected" });
  });

  it("leaves no approved draft when no send function is configured", async () => {
    const { themeId, taskId } = await shippedTask();
    const ada = await seedPerson(db);
    await seedFeedback(db, { text: "x", contactId: ada.id, status: "themed", themeId });
    const h = harness({ send: null });
    await h.announce(taskId);
    const [row] = await notes(themeId);
    const code = codeIn(h.operator.messages.map((m) => m.text).join("\n"), row?.id ?? "");
    expect(await h.say(`ship-note-approve-${row?.id} ${code}`)).toContain("No send function");
    expect((await notes(themeId))[0]).toMatchObject({ status: "drafted", draft_status: "pending_approval" });
  });

  it("drops a declined note and records the decision", async () => {
    const { h, themeId, id } = await drafted();
    expect(await h.say(`ship-note-decline-${id}`)).toContain("Nothing was sent");
    expect((await notes(themeId))[0]).toMatchObject({ status: "rejected", draft_status: "rejected" });
    const evidence = await db.prepare("SELECT outcome FROM autonomy_events WHERE action_class = 'ship_notification'").all<{ outcome: string }>();
    expect(evidence.results.map((e) => e.outcome)).toEqual(["rejected"]);
  });

  it("refuses while ship:notes_enabled is off", async () => {
    const { id, code } = await drafted();
    const off = harness({ flags: { "ship:enabled": "true" } });
    expect(await off.say(`ship-note-approve-${id} ${code}`)).toContain("ship:notes_enabled");
  });
});
