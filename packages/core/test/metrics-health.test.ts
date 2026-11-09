// GTM-agents: tests for measurement health: ledger coverage from the provider's evidence (sent
// funnel events and delivered events), the product bridge, and failing closed. Every row is
// synthetic, and each test works in its own days of 2022.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MIN_SENDS_FOR_COVERAGE, judgeHealth, ledgerCoverage, measurementHealth, unreadableHealth } from "../src/metrics/index.ts";
import { EMAIL_EVENT_EFFECT } from "../src/sending/webhook.ts";
import { failingOn } from "../src/sequences/testing.ts";
import { uid } from "./delivery-fakes.ts";

const db = env.DB;
const HOUR = 3_600_000;
const DAY = 86_400_000;

async function ledgerRow(provider: string, messageId: string, sentAt: string): Promise<void> {
  await db.prepare("INSERT INTO outreach_sends (id, send_path, provider, provider_message_id, sequence_step, sent_at) VALUES (?1, 'cold', ?2, ?3, 1, ?4)").bind(uid("os"), provider, messageId, sentAt).run();
}

async function sentEvent(provider: string, messageId: string, at: string): Promise<void> {
  await db
    .prepare("INSERT INTO funnel_events (id, event_type, source, metadata, occurred_at) VALUES (?1, 'outreach_sent', 'agent', ?2, ?3)")
    .bind(uid("fe"), JSON.stringify({ provider, provider_message_id: messageId, path: "cold" }), at)
    .run();
}

async function deliveredEvent(provider: string, messageId: string, at: string): Promise<void> {
  await db.prepare("INSERT INTO event_effects (event_id, effect, created_at) VALUES (?1, ?2, ?3)").bind(`email:${provider}:${messageId}:delivered`, EMAIL_EVENT_EFFECT, at).run();
}

describe("ledger coverage", () => {
  it("matches sent and delivered events to ledger rows by provider and message id, once per message", async () => {
    const now = new Date("2022-11-15T12:00:00.000Z");
    const t = new Date(now.getTime() - DAY).toISOString();
    const provider = uid("esp");
    for (let i = 0; i < 18; i++) {
      await ledgerRow(provider, `m${i}`, t);
      await sentEvent(provider, `m${i}`, t);
      await deliveredEvent(provider, `m${i}`, t);
    }
    // Two messages the provider delivered but the ledger never recorded, and their sent events were lost too.
    await deliveredEvent(provider, "lost-1", t);
    await deliveredEvent(provider, "lost-2", t);
    // The same id under another provider is a different message.
    await ledgerRow(`${provider}-other`, "lost-3", t);
    await deliveredEvent(provider, "lost-3", t);
    // Events outside the window and other effects are not evidence.
    await sentEvent(provider, "old", new Date(now.getTime() - 8 * DAY).toISOString());
    await db.prepare("INSERT INTO event_effects (event_id, effect, created_at) VALUES (?1, ?2, ?3)").bind(`email:${provider}:x:bounced`, EMAIL_EVENT_EFFECT, t).run();
    await db.prepare("INSERT INTO event_effects (event_id, effect, created_at) VALUES (?1, 'page', ?2)").bind(`email:${provider}:y:delivered`, t).run();

    const coverage = await ledgerCoverage(db, new Date(now.getTime() - 7 * DAY).toISOString(), now.toISOString());
    expect(coverage).toEqual({ evidence: 21, matched: 18, coverage: 18 / 21, ledgerRows: 19 });
    const health = await measurementHealth(db, now);
    expect(health.blocksReplyConclusions).toBe(true);
    expect(health.blocksProductConclusions).toBe(true);
    expect(health.reasons[0]).toContain("18 of 21");
  });

  it("does not judge under 20 sent messages, and passes at 95% or more", async () => {
    const few = judgeHealth({ ledger: { evidence: MIN_SENDS_FOR_COVERAGE - 1, matched: 0, coverage: null, ledgerRows: 0 }, bridgeUnrouted: 0, productEventsSeen: false });
    expect(few).toMatchObject({ blocksReplyConclusions: false, blocksProductConclusions: false, reasons: [] });
    const ok = judgeHealth({ ledger: { evidence: 20, matched: 19, coverage: 0.95, ledgerRows: 20 }, bridgeUnrouted: 0, productEventsSeen: true });
    expect(ok.blocksReplyConclusions).toBe(false);
    const short = judgeHealth({ ledger: { evidence: 100, matched: 94, coverage: 0.94, ledgerRows: 94 }, bridgeUnrouted: 0, productEventsSeen: true });
    expect(short.blocksReplyConclusions).toBe(true);
    // Few evidence events beside a busy ledger means the evidence is missing, not the volume.
    const missing = judgeHealth({ ledger: { evidence: 0, matched: 0, coverage: null, ledgerRows: 40 }, bridgeUnrouted: 0, productEventsSeen: false });
    expect(missing.blocksReplyConclusions).toBe(true);
    expect(missing.reasons[0]).toContain("sent events missing");
  });
});

describe("the product bridge", () => {
  it("blocks product conclusions while a product event is unrouted after 6 hours, and only product conclusions", async () => {
    const now = new Date("2022-12-01T12:00:00.000Z");
    const event = (receivedAt: string, routedAt: string | null, source = "product") =>
      db
        .prepare("INSERT INTO events (id, source, type, occurred_at, received_at, taint, routed_at) VALUES (?1, ?2, 'user.signed_up', ?3, ?3, 'structured', ?4)")
        .bind(uid("ev"), source, receivedAt, routedAt)
        .run();
    await event(new Date(now.getTime() - 2 * HOUR).toISOString(), null);
    await event(new Date(now.getTime() - 9 * HOUR).toISOString(), new Date(now.getTime() - 8 * HOUR).toISOString());
    await event(new Date(now.getTime() - 9 * HOUR).toISOString(), null, "git");
    const fresh = await measurementHealth(db, now);
    expect(fresh).toMatchObject({ bridgeUnrouted: 0, productEventsSeen: true, blocksProductConclusions: false });

    await event(new Date(now.getTime() - 7 * HOUR).toISOString(), null);
    const stuck = await measurementHealth(db, now);
    expect(stuck).toMatchObject({ bridgeUnrouted: 1, blocksReplyConclusions: false, blocksProductConclusions: true });
    expect(stuck.reasons.join(" ")).toContain("unrouted after 6 hours");
  });
});

describe("failing closed", () => {
  it("blocks every conclusion when health cannot be read", async () => {
    const health = await measurementHealth(failingOn(db, /./), new Date("2022-12-10T00:00:00.000Z"));
    expect(health).toMatchObject({ ledger: null, bridgeUnrouted: null, productEventsSeen: null, blocksReplyConclusions: true, blocksProductConclusions: true });
    expect(health.reasons).toContain("ledger coverage could not be read");
    expect(unreadableHealth()).toEqual(health);
  });

  it("blocks product conclusions alone when only the bridge cannot be read", async () => {
    const health = await measurementHealth(failingOn(db, /FROM events/), new Date("2022-12-11T00:00:00.000Z"));
    expect(health.blocksReplyConclusions).toBe(false);
    expect(health.blocksProductConclusions).toBe(true);
  });
});
