// GTM-agents: the lifecycle's harder failure cases: an implied sign-up whose side effects failed is
// finished on retry; a person erased while their event routes is not left behind; an erasure push
// is honored with the lifecycle off and keeps no extra fields; a mailbox with several contacts is
// erased in one pass; parked payloads expire; a check never starves on rows it already handled.
// Every person and company is invented, on *.example domains.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env.ts";
import { purgeRoutedPayloads, recordEvent } from "../src/events/spine.ts";
import { runLifecycleChecks } from "../src/lifecycle/checks.ts";
import { createProductRouter, routeProductEnvelope } from "../src/product-bridge/route.ts";
import { eraseIfTombstoned, eraseProductUser, writeTombstone } from "../src/product-bridge/erasure.ts";
import { parseEnvelope, type ProductEnvelope } from "../src/product-bridge/envelope.ts";
import { resolveProductUser } from "../src/product-bridge/identity.ts";
import { addressHash } from "../src/sending/suppression.ts";
import { bucket, call, coldOutreach, count, db, envelope, failingDb, lifecycleWorker, person, push, resetLifecycle, routeContext, state, testEnv, uid } from "./lifecycle-fixtures.ts";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const parsed = (e: Record<string, unknown>): ProductEnvelope => {
  const r = parseEnvelope(e);
  if (!r.ok) throw new Error(r.error);
  return r.envelope;
};

beforeEach(resetLifecycle);

describe("retries", () => {
  it("finishes an implied sign-up's side effects when the event is routed again after the state moved on", async () => {
    const ada = await person({ email: "ada@retry.example" });
    await coldOutreach(ada.id);
    const event = parsed(envelope("billing.subscribed", { id: "usr_r", email: "ada@retry.example" }, { plan: "pro", interval: "month", amount: 4900, currency: "usd" }, { occurredAt: "2026-11-03T10:00:00.000Z" }));
    const broken = failingDb(db, /UPDATE campaign_contacts/);
    const ctx = { ...routeContext(undefined, NOW), db: broken.db };
    await expect(routeProductEnvelope(ctx, { id: "product:r1", payload_key: null }, event, {})).rejects.toThrow(/stop/);
    expect((await state(ada.id))?.state).toBe("paying");
    expect(await db.prepare("SELECT sequence_active FROM campaign_contacts WHERE contact_id = ?1").bind(ada.id).first()).toEqual({ sequence_active: 1 });
    broken.fail.on = false;
    await routeProductEnvelope(ctx, { id: "product:r1", payload_key: null }, event, {});
    expect(await db.prepare("SELECT sequence_active FROM campaign_contacts WHERE contact_id = ?1").bind(ada.id).first()).toEqual({ sequence_active: 0 });
    expect(await count("SELECT COUNT(*) AS n FROM funnel_events WHERE contact_id = ?1 AND event_type = 'signed_up'", ada.id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM lifecycle_transitions WHERE contact_id = ?1", ada.id)).toBe(2);
  });
});

describe("erasure races", () => {
  it("never creates a contact once a tombstone names the person, even past the first check", async () => {
    await writeTombstone(db, { emailSha256: "f".repeat(64), userId: "usr_gone", source: "product", erasedAt: NOW.toISOString() });
    expect(await resolveProductUser(db, { userId: "usr_gone", email: "new@race.example", name: null, ref: null }, { now: NOW, refTokens: false })).toEqual({ kind: "erased" });
    expect(await count("SELECT COUNT(*) AS n FROM contacts WHERE email = 'new@race.example'")).toBe(0);
  });

  it("erases what a route wrote when the person was erased while it ran", async () => {
    const ada = await person({ email: "ada@race.example" });
    expect(await eraseIfTombstoned({ db, bucket, now: NOW }, { contactId: ada.id, userId: "usr_race", source: "product" })).toBe(false);
    await writeTombstone(db, { emailSha256: await addressHash("ada@race.example"), userId: "usr_race", source: "product", erasedAt: NOW.toISOString() });
    expect(await eraseIfTombstoned({ db, bucket, now: NOW }, { contactId: ada.id, userId: "usr_race", source: "product" })).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM contacts WHERE id = ?1", ada.id)).toBe(0);
  });

  it("erases every contact on one mailbox in a single pass", async () => {
    const plain = await person({ email: "jo@mailbox.example" });
    const tagged = await person({ email: "jo+news@mailbox.example" });
    await db.prepare("INSERT INTO contact_lifecycle (contact_id, state, product_user_id) VALUES (?1, 'paying', 'usr_jo')").bind(tagged.id).run();
    const result = await eraseProductUser({ db, bucket, now: NOW }, { userId: "usr_jo", emailSha256: await addressHash("jo@mailbox.example"), erasedAt: NOW.toISOString(), eventKey: "product:jo", source: "product" });
    expect(result.contactsErased).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM contacts WHERE id IN (?1, ?2)", plain.id, tagged.id)).toBe(0);
  });
});

describe("an erasure with the lifecycle off", () => {
  it("is carried out in full at once: no contact, draft, inbound mail or payload about the person remains", async () => {
    const { worker } = lifecycleWorker();
    // What the deployment held about Ada before the lifecycle was ever turned on.
    const ada = await person({ email: "ada@off.example" });
    await coldOutreach(ada.id);
    await db.prepare("INSERT INTO drafts (id, contact_id, kind, status, recipient_email, subject, body) VALUES (?1, ?2, 'reply', 'draft', 'ada@off.example', 'Re: hello', 'Hi Ada')").bind(uid("dr"), ada.id).run();
    await bucket.put("inbound/ada-off.eml", "Hello from Ada");
    await db
      .prepare("INSERT INTO inbound_emails (id, provider, provider_message_id, sender_email, received_at, contact_id, body_key) VALUES (?1, 'test', ?2, 'ada@off.example', '2026-11-01T10:00:00.000Z', ?3, 'inbound/ada-off.eml')")
      .bind(uid("in"), uid("msg"), ada.id)
      .run();
    await recordEvent({ db, bucket }, { source: "product", providerId: uid("evt"), type: "user.signed_up", occurredAt: NOW.toISOString(), receivedAt: NOW, payload: '{"email":"ada@off.example"}', taint: "structured", subjectRef: "usr_off" });
    const hash = await addressHash("ada@off.example");
    const event = envelope("user.deleted", { id: "usr_off", email_sha256: hash }, {});
    (event.user as Record<string, unknown>).name = "Ada Lovelace";
    const response = await call(worker, await push(event), testEnv({ flags: {} }));
    expect(await response.json()).toEqual({ ok: true, duplicate: false });
    expect(await count("SELECT COUNT(*) AS n FROM erasure_tombstones WHERE email_sha256 = ?1 AND product_user_id = 'usr_off'", hash)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM suppression WHERE email_sha256 = ?1", hash)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM contacts WHERE id = ?1 OR email = 'ada@off.example'", ada.id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM drafts WHERE recipient_email = 'ada@off.example'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM inbound_emails WHERE sender_email = 'ada@off.example'")).toBe(0);
    expect(await bucket.get("inbound/ada-off.eml")).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM events WHERE subject_ref = 'usr_off' OR (type = 'user.signed_up' AND payload_key IS NOT NULL)")).toBe(0);
    const row = await db.prepare("SELECT payload_key, routed_at FROM events WHERE id = ?1").bind(`product:${String(event.id)}`).first<{ payload_key: string; routed_at: string | null }>();
    expect(row?.routed_at).not.toBeNull();
    expect(await (await bucket.get(row?.payload_key ?? ""))?.text()).not.toContain("Lovelace");
    // A non-erasure push is still refused while off.
    expect((await call(worker, await push(envelope("user.signed_up", { id: uid("usr"), email: "x@off.example" }, { plan: "free" })), testEnv({ flags: {} }))).status).toBe(503);
    expect(createProductRouter).toBeTypeOf("function");
  });

  it("is retried by the sweep, which needs no flag, while other events keep waiting", async () => {
    const { lifecycle } = lifecycleWorker();
    const sweep = lifecycle.jobs.find((j) => j.name === "event_sweep");
    expect(sweep?.flag).toBeUndefined();
    const ada = await person({ email: "ada@sweep.example" });
    const hash = await addressHash("ada@sweep.example");
    const old = new Date(NOW.getTime() - 10 * 60_000);
    const erasure = JSON.stringify(envelope("user.deleted", { id: "usr_sweep", email_sha256: hash }, {}, { id: "evt_sweep_del" }));
    const signup = JSON.stringify(envelope("user.signed_up", { id: uid("usr"), email: "new@sweep.example" }, { plan: "free" }, { id: "evt_sweep_new" }));
    await recordEvent({ db, bucket }, { source: "product", providerId: "evt_sweep_del", type: "user.deleted", occurredAt: old.toISOString(), receivedAt: old, payload: erasure, taint: "structured" });
    await recordEvent({ db, bucket }, { source: "product", providerId: "evt_sweep_new", type: "user.signed_up", occurredAt: old.toISOString(), receivedAt: old, payload: signup, taint: "structured" });
    const { sweepEvents } = await import("../src/events/spine.ts");
    expect(await sweepEvents(routeContext({}, NOW), lifecycle.routers(env as unknown as Env), { limit: 10 })).toMatchObject({ seen: 2, routed: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM contacts WHERE id = ?1", ada.id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM contacts WHERE email = 'new@sweep.example'")).toBe(0);
  });

  it("is applied by the nightly pull, which reads deletions only while the lifecycle is off", async () => {
    const ada = await person({ email: "ada@pulloff.example" });
    const hash = await addressHash("ada@pulloff.example");
    const reads: string[] = [];
    const host: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      reads.push(url.pathname.split("/").pop() ?? "");
      const items = url.pathname.endsWith("/deletions") ? [{ user_id: "usr_pull", email_sha256: hash, deleted_at: "2026-11-03T09:00:00Z" }] : [{ id: "usr_x", email: "x@pulloff.example", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" }];
      return new Response(JSON.stringify({ items }), { status: 200 });
    };
    const { lifecycle } = lifecycleWorker({ fetch: host });
    const job = lifecycle.jobs.find((j) => j.name === "lifecycle_reconcile");
    if (!job) throw new Error("no reconcile job");
    const { flagReader, silentLogger } = await import("../src/outreach/testing.ts");
    const { memoryKv } = await import("../src/agents/testing.ts");
    const bindings = { ...testEnv({ flags: {} }), KV: memoryKv() as unknown as KVNamespace, PRODUCT_APP_URL: "https://app.acme.example", PRODUCT_READ_SECRET: "r".repeat(40) };
    const { config } = await import("./lifecycle-fixtures.ts");
    await job.run({ env: bindings, config, job: job.name, now: NOW, signal: new AbortController().signal, ceilings: job.ceilings, flags: flagReader({ "lifecycle:reconcile_enabled": "true" }), log: silentLogger });
    expect(reads).toEqual(["deletions"]);
    expect(await count("SELECT COUNT(*) AS n FROM contacts WHERE id = ?1", ada.id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM contacts WHERE email = 'x@pulloff.example'")).toBe(0);
  });
});

describe("retention and checks", () => {
  it("deletes the payload of an event parked long ago", async () => {
    const { id } = await recordEvent({ db, bucket }, { source: "test", providerId: uid("evt"), type: "x", occurredAt: "2026-06-01T00:00:00.000Z", receivedAt: new Date("2026-06-01T00:00:00.000Z"), payload: "{}", taint: "structured" });
    await db.prepare("UPDATE events SET route_attempts = 5 WHERE id = ?1").bind(id).run();
    expect(await purgeRoutedPayloads({ db, bucket }, { now: NOW, days: 90, limit: 10 })).toBe(1);
  });

  it("never starves on a contact it already moved for the same idle period", async () => {
    const stuck = await person();
    const waiting = await person();
    const idle = "2026-10-01T00:00:00.000Z";
    await db.batch([
      db.prepare("INSERT INTO contact_lifecycle (contact_id, state, last_active_at, state_changed_at) VALUES (?1, 'paying', ?2, ?2)").bind(stuck.id, idle),
      db.prepare("INSERT INTO event_effects (event_id, effect) VALUES (?1, ?2)").bind(`check:dormant:${stuck.id}:${idle}`, `lifecycle:${stuck.id}`),
      db.prepare("INSERT INTO contact_lifecycle (contact_id, state, last_active_at, state_changed_at) VALUES (?1, 'paying', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z')").bind(waiting.id),
    ]);
    expect(await runLifecycleChecks({ db, now: NOW }, 1)).toMatchObject({ dormant: 1 });
    expect((await state(waiting.id))?.state).toBe("at_risk");
  });
});
