// GTM-agents: tests for the outreach metrics over the send ledger: sends, replies, reply depth,
// first-touch outcomes and their slices, matured samples, and the cohort definition. Every row is
// synthetic, and each test works in its own days of 2022 so it sees only its own rows.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  NON_REPLY_INTENTS,
  POSITIVE_INTENTS,
  REPLY_INTENTS,
  SEND_COHORTS,
  UNKNOWN_SLICE,
  cohortFor,
  countReplies,
  countSends,
  countsAsReply,
  deliveryHealth,
  firstTouchOutcomes,
  firstTouchOutcomesBy,
  maturedSamples,
  maturedTotals,
  replyRate,
  metricWindow,
  replyDepth,
  sendCohort,
  signalledContacts,
  templateIsTargeted,
} from "../src/metrics/index.ts";
import { LEDGER_POSITIVE_INTENTS, LEDGER_REPLY_INTENTS, humanReplySql, sqlList } from "../src/metrics/sql.ts";
import { failingOn } from "../src/sequences/testing.ts";
import { insertContact, uid } from "./delivery-fakes.ts";

const db = env.DB;
const DAY = 86_400_000;

interface SendRow {
  id?: string;
  contactId?: string | null;
  accountKey?: string | null;
  step?: number | null;
  path?: string;
  sentAt: string;
  templateId?: string | null;
  templateSha?: string | null;
  cohort?: string | null;
  subject?: string;
  bouncedAt?: string | null;
  repliedAt?: string | null;
  replyIntent?: string | null;
  replyAfterStep?: number | null;
  positiveAt?: string | null;
}

async function insertSend(r: SendRow): Promise<string> {
  const id = r.id ?? uid("os");
  await db
    .prepare(
      `INSERT INTO outreach_sends (id, contact_id, account_key, template_id, template_sha256, cohort, subject, sequence_step, send_path, provider, sent_at,
         bounced_at, replied_at, reply_intent, reply_after_step, positive_reply_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'test-ledger', ?10, ?11, ?12, ?13, ?14, ?15)`,
    )
    .bind(
      id,
      r.contactId ?? null,
      r.accountKey ?? null,
      r.templateId ?? null,
      r.templateSha ?? null,
      r.cohort ?? null,
      r.subject ?? "Flaky builds at Globex",
      r.step === undefined ? 1 : r.step,
      r.path ?? (r.step && r.step > 1 ? "sequence" : "cold"),
      r.sentAt,
      r.bouncedAt ?? null,
      r.repliedAt ?? null,
      r.replyIntent ?? null,
      r.replyAfterStep ?? null,
      r.positiveAt ?? null,
    )
    .run();
  return id;
}

const at = (base: string, days: number) => new Date(Date.parse(base) + days * DAY).toISOString();

describe("the SQL conditions", () => {
  it("are generated from the one definition of a reply and a positive reply", () => {
    expect([...LEDGER_REPLY_INTENTS]).toEqual(REPLY_INTENTS.filter((i) => countsAsReply({ intent: i })));
    for (const intent of NON_REPLY_INTENTS) expect(LEDGER_REPLY_INTENTS).not.toContain(intent);
    expect([...LEDGER_POSITIVE_INTENTS].sort()).toEqual([...POSITIVE_INTENTS].sort());
    expect(humanReplySql("os")).toContain("'not_a_fit'");
  });

  it("refuse to interpolate anything but a constant identifier", () => {
    expect(() => sqlList(["interested", "x' OR 1=1 --"])).toThrow();
    expect(() => sqlList([])).toThrow();
  });
});

describe("sends and replies", () => {
  const base = "2022-01-10T00:00:00.000Z";
  const window = metricWindow(new Date(base), new Date(at(base, 7)));

  it("counts first touches and follow-ups on the outreach paths only, inside the window", async () => {
    await insertSend({ sentAt: at(base, 1) });
    await insertSend({ sentAt: at(base, 2) });
    await insertSend({ sentAt: at(base, 3), step: 2 });
    await insertSend({ sentAt: at(base, 4), step: 3 });
    await insertSend({ sentAt: at(base, 2), step: null, path: "reply" });
    await insertSend({ sentAt: at(base, 2), step: null, path: "lifecycle" });
    await insertSend({ sentAt: at(base, 7) });
    await insertSend({ sentAt: at(base, -1) });
    await insertSend({ sentAt: at(base, 5), step: null, path: "cold" });
    const counts = await countSends(db, window);
    expect(counts).toEqual({ firstTouches: 2, followUps: 2, unnumbered: 1 });
    // One rule for a send with no step: it is outreach, so delivery health counts it too.
    expect(counts.firstTouches + counts.followUps + counts.unnumbered).toBe((await deliveryHealth(db, window)).sends);
  });

  it("counts replies by when they arrived, never an opt-out or automatic reply, once per conversation", async () => {
    const b = "2022-02-10T00:00:00.000Z";
    const w = metricWindow(new Date(b), new Date(at(b, 7)));
    await insertSend({ sentAt: at(b, -20), repliedAt: at(b, 1), replyIntent: "interested", replyAfterStep: 2, positiveAt: at(b, 1) });
    await insertSend({ sentAt: at(b, -5), repliedAt: at(b, 2), replyIntent: "not_a_fit", replyAfterStep: 1 });
    await insertSend({ sentAt: at(b, -5), repliedAt: at(b, 3), replyIntent: "warm", replyAfterStep: 2, positiveAt: at(b, 9) });
    await insertSend({ sentAt: at(b, -5), repliedAt: at(b, 3), replyIntent: "opt_out", replyAfterStep: 1 });
    await insertSend({ sentAt: at(b, -40), repliedAt: at(b, -2), replyIntent: "objection", replyAfterStep: 3, positiveAt: at(b, 4) });
    await insertSend({ sentAt: at(b, -5), step: 2, repliedAt: at(b, 2), replyIntent: "interested", positiveAt: at(b, 2) });
    expect(await countReplies(db, w)).toEqual({ humanReplies: 3, positiveReplies: 2 });
    expect(await replyDepth(db, w)).toEqual([
      { step: 1, humanReplies: 1 },
      { step: 2, humanReplies: 2 },
    ]);
  });
});

describe("first-touch outcomes", () => {
  it("counts what the window's first touches earned, and slices add up to the total", async () => {
    const b = "2022-03-10T00:00:00.000Z";
    const w = metricWindow(new Date(b), new Date(at(b, 10)));
    const account = `${uid("globex")}.example`;
    const contact = (await insertContact(db, { accountKey: account })).id;
    await db.prepare("INSERT INTO accounts (account_key, name, domain, segment) VALUES (?1, 'Globex', ?1, 'saas')").bind(account).run();
    await db.prepare("INSERT INTO account_contacts (account_key, contact_id, persona) VALUES (?1, ?2, 'platform-champion')").bind(account, contact).run();
    await db.prepare("INSERT INTO templates (id, kind, status, subject, body_sha256) VALUES ('tpl-a', 'cold_intro', 'approved', 'Flaky builds at {{account_name}}', ?1)").bind("a".repeat(64)).run();
    await insertSend({ sentAt: at(b, 1), templateId: "tpl-a", cohort: "generic", accountKey: account, contactId: contact, repliedAt: at(b, 3), replyIntent: "question", positiveAt: at(b, 3) });
    await insertSend({ sentAt: at(b, 2), templateId: "tpl-a", cohort: "segment_routed", accountKey: account, repliedAt: at(b, 30), replyIntent: "not_a_fit" });
    await insertSend({ sentAt: at(b, 3), templateId: "tpl-b", cohort: "generic", bouncedAt: at(b, 3) });
    await insertSend({ sentAt: at(b, 4), templateId: null, cohort: null });
    await insertSend({ sentAt: at(b, 4), step: 2, templateId: "tpl-a", repliedAt: at(b, 5), replyIntent: "interested" });
    await insertSend({ sentAt: at(b, 11), templateId: "tpl-a" });

    const total = await firstTouchOutcomes(db, w);
    expect(total).toEqual({ sends: 4, bounced: 1, humanReplies: 2, positiveReplies: 1 });
    expect((await countSends(db, w)).firstTouches).toBe(total.sends);

    for (const dimension of ["template", "subject", "cohort", "segment", "persona"] as const) {
      const slices = await firstTouchOutcomesBy(db, w, dimension);
      const sum = slices.reduce((acc, s) => ({ sends: acc.sends + s.sends, bounced: acc.bounced + s.bounced, humanReplies: acc.humanReplies + s.humanReplies, positiveReplies: acc.positiveReplies + s.positiveReplies }), { sends: 0, bounced: 0, humanReplies: 0, positiveReplies: 0 });
      expect(sum, dimension).toEqual(total);
    }
    expect(await firstTouchOutcomesBy(db, w, "template")).toEqual([
      { key: UNKNOWN_SLICE, sends: 1, bounced: 0, humanReplies: 0, positiveReplies: 0 },
      { key: "tpl-a", sends: 2, bounced: 0, humanReplies: 2, positiveReplies: 1 },
      { key: "tpl-b", sends: 1, bounced: 1, humanReplies: 0, positiveReplies: 0 },
    ]);
    const subjects = await firstTouchOutcomesBy(db, w, "subject");
    expect(subjects.map((s) => s.key)).toEqual([UNKNOWN_SLICE, "Flaky builds at {{account_name}}"]);
    expect((await firstTouchOutcomesBy(db, w, "segment")).find((s) => s.key === "saas")?.sends).toBe(2);
    expect((await firstTouchOutcomesBy(db, w, "persona")).find((s) => s.key === "platform-champion")).toMatchObject({ sends: 1, positiveReplies: 1 });
    expect((await firstTouchOutcomesBy(db, w, "cohort")).map((s) => [s.key, s.sends])).toEqual([
      [UNKNOWN_SLICE, 1],
      ["generic", 2],
      ["segment_routed", 1],
    ]);
  });

  it("refuses a dimension it does not know", async () => {
    await expect(firstTouchOutcomesBy(db, metricWindow(new Date(0), new Date(1)), "tier" as never)).rejects.toThrow(/unknown outcome dimension/);
  });
});

describe("matured samples", () => {
  it("count only first touches of the current copy, not bounced, at least 10 days old", async () => {
    const b = "2022-04-01T00:00:00.000Z";
    const now = new Date(at(b, 30));
    const current = "c".repeat(64);
    await db.prepare("INSERT INTO templates (id, kind, status, body_sha256) VALUES ('tpl-matured', 'cold_intro', 'approved', ?1)").bind(current).run();
    const sha = (s: string) => ({ templateId: "tpl-matured", templateSha: s });
    await insertSend({ sentAt: at(b, 1), ...sha(current), repliedAt: at(b, 4), replyIntent: "referral", positiveAt: at(b, 4) });
    await insertSend({ sentAt: at(b, 2), ...sha(current), repliedAt: at(b, 4), replyIntent: "objection" });
    await insertSend({ sentAt: at(b, 3), ...sha(current) });
    await insertSend({ sentAt: at(b, 3), ...sha("d".repeat(64)), repliedAt: at(b, 5), replyIntent: "interested", positiveAt: at(b, 5) });
    await insertSend({ sentAt: at(b, 3), ...sha(current), bouncedAt: at(b, 3) });
    await insertSend({ sentAt: at(b, 3), step: 2, ...sha(current) });
    await insertSend({ sentAt: at(b, 25), ...sha(current) });
    await insertSend({ sentAt: at(b, 4), templateId: "tpl-matured", templateSha: null });
    const samples = await maturedSamples(db, metricWindow(new Date(b), now), now);
    expect(samples).toEqual([{ templateId: "tpl-matured", sends: 3, humanReplies: 2, positiveReplies: 1 }]);
    expect(await maturedTotals(db, metricWindow(new Date(b), now), now)).toEqual({ sends: 3, humanReplies: 2, positiveReplies: 1 });
    expect(replyRate(2, 3)).toBe(2 / 3);
    expect(replyRate(0, 0)).toBeNull();
  });
});

describe("the cohort", () => {
  it("is signalled, then segment routed, then generic", () => {
    expect(sendCohort({ signalled: true, templateTargeted: true })).toBe("signalled");
    expect(sendCohort({ signalled: false, templateTargeted: true })).toBe("segment_routed");
    expect(sendCohort({ signalled: false, templateTargeted: false })).toBe("generic");
    expect(templateIsTargeted({ segments: ["saas"] })).toBe(true);
    expect(templateIsTargeted({ personas: ["economic-buyer"] })).toBe(true);
    expect(templateIsTargeted({ team_sizes: [] })).toBe(false);
    expect(templateIsTargeted(null)).toBe(false);
    expect(cohortFor(null, "c1", true)).toBeNull();
  });

  it("counts a contact's or its account's signal from the 90 days before, never a dismissed one", async () => {
    const send = new Date("2022-05-20T12:00:00.000Z");
    const account = `${uid("initech")}.example`;
    const signal = (contactId: string | null, accountKey: string | null, detected: string, status = "new") =>
      db.prepare("INSERT INTO signal_events (id, type, contact_id, account_key, headline, status, detected_at) VALUES (?1, 'funding', ?2, ?3, 'Raised a round', ?4, ?5)").bind(uid("sig"), contactId, accountKey, status, detected).run();
    const [own, colleague, stale, dismissed, none] = await Promise.all(Array.from({ length: 5 }, async () => (await insertContact(db)).id));
    if (!own || !colleague || !stale || !dismissed || !none) throw new Error("five contacts");
    await signal(own, null, "2022-04-01T00:00:00.000Z");
    await signal(null, account, "2022-05-19T00:00:00.000Z");
    await signal(stale, null, "2022-02-01T00:00:00.000Z");
    await signal(dismissed, null, "2022-05-01T00:00:00.000Z", "dismissed");
    await signal(none, null, "2022-05-21T00:00:00.000Z");
    const found = await signalledContacts(
      db,
      [
        { contactId: own, accountKey: null },
        { contactId: colleague, accountKey: account },
        { contactId: stale, accountKey: null },
        { contactId: dismissed, accountKey: null },
        { contactId: none, accountKey: null },
      ],
      send,
    );
    expect(found && [...found].sort()).toEqual([own, colleague].sort());
  });

  it("is unknown, never guessed, when the signals cannot be read", async () => {
    expect(await signalledContacts(failingOn(db, /signal_events/), [{ contactId: "c1", accountKey: "acme.example" }], new Date())).toBeNull();
  });

  it("is checked by the drafts table with exactly the cohorts this module defines", async () => {
    const sql = (await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'drafts'").first<{ sql: string }>())?.sql ?? "";
    const list = /CHECK \(cohort IS NULL OR cohort IN \(([^)]*)\)\)/.exec(sql)?.[1] ?? "";
    expect([...list.matchAll(/'([^']*)'/g)].map((m) => m[1])).toEqual([...SEND_COHORTS]);
    await expect(db.prepare("INSERT INTO drafts (id, kind, cohort) VALUES (?1, 'cold_intro', 'personalized')").bind(uid("dr")).run()).rejects.toThrow(/CHECK/);
    await expect(db.prepare("INSERT INTO drafts (id, kind, template_sha256) VALUES (?1, 'cold_intro', 'ABC')").bind(uid("dr")).run()).rejects.toThrow(/CHECK/);
  });
});
