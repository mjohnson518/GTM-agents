// GTM-agents: angles, and the milestone's gate: most first touches carry a dated reason. Over
// synthetic data, a batch's first touches carry a dated reason from a real signal when one exists,
// a template using the angle variables is no longer held when the angle is available, and is still
// held when it is not. Every person, account and headline is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { defineConfig } from "../src/config/index.ts";
import { cohortFor, signalledContacts } from "../src/metrics/cohort.ts";
import { createRotation } from "../src/outreach/allocate.ts";
import { composeColdDraft, type ComposeContext } from "../src/outreach/compose.ts";
import type { SelectionRow } from "../src/outreach/select.ts";
import { seedContact, templateFile } from "../src/outreach/testing.ts";
import { DEFAULT_ANGLE_OPENERS, angleAge, angleConfidence, loadAngles, openerFor, quotableHeadline, validOpener } from "../src/signals/angles.ts";
import { recordSignal } from "../src/signals/record.ts";
import { serveTemplateFiles, type ServedTemplate } from "../src/templates/index.ts";
import { acmeConfig } from "./fixtures.ts";
import { NOW, daysAgo, newSignal, resetSignalTables, seedAccount } from "./signals-fakes.ts";

const db = env.DB;
const config = defineConfig(acmeConfig);

const ANGLE_BODY = [
  "Hi {{first_name}},",
  "",
  "{{angle_opener}} Teams that grow {{angle_age}} usually find their test suite grows faster than their patience with reruns.",
  "",
  "Is flaky-test time something your team tracks at {{account_name}}, or does it mostly show up as frustration in standup?",
  "",
  "{{sender_name}}",
].join("\n");

async function angleTemplate(): Promise<ServedTemplate[]> {
  return (await serveTemplateFiles([templateFile("cold-angle", { body: ANGLE_BODY })], { companyDomain: "acme.example" })).templates;
}

const ctx = (angles: ComposeContext["angles"]): ComposeContext => ({
  config,
  copyLines: { segment: new Map(), team_size: new Map(), persona: new Map() },
  playbooks: new Map(),
  links: { domains: ["acme.example"], exactUrls: [] },
  approvedClaims: [],
  ...(angles ? { angles } : {}),
});

async function selectionRow(id: string): Promise<SelectionRow> {
  const row = await db
    .prepare("SELECT c.id, c.email, c.first_name, c.last_name, c.job_title, c.account_key, c.attributes, a.name AS account_name, a.attributes AS account_attributes, NULL AS segment, NULL AS team_size, NULL AS persona, c.email_confidence, c.verification_status FROM contacts c LEFT JOIN accounts a ON a.account_key = c.account_key WHERE c.id = ?1")
    .bind(id)
    .first<SelectionRow>();
  if (!row) throw new Error("no row");
  return row;
}

beforeEach(async () => {
  await resetSignalTables(db);
});

describe("angle rules", () => {
  it("dates the age from the event: this week, last week, or the month", () => {
    expect(angleAge(daysAgo(2), NOW)).toBe("this week");
    expect(angleAge(daysAgo(9), NOW)).toBe("last week");
    expect(angleAge("2026-10-01T00:00:00.000Z", NOW)).toBe("in October");
  });

  it("is high confidence within 14 days, medium within 45, and none after", () => {
    expect(angleConfidence(daysAgo(14), NOW)).toBe("high");
    expect(angleConfidence(daysAgo(30), NOW)).toBe("medium");
    expect(angleConfidence(daysAgo(46), NOW)).toBeNull();
    expect(angleConfidence("not a date", NOW)).toBeNull();
  });

  it("uses fixed openers with only the account name substituted, and refuses openers with anything else", () => {
    expect(openerFor("funding", "Brightloop Labs")).toBe(DEFAULT_ANGLE_OPENERS.funding.replace("{account}", "Brightloop Labs"));
    expect(openerFor("hiring", "Brightloop Labs", { openers: { hiring: "Saw {account} is hiring." } })).toBe("Saw Brightloop Labs is hiring.");
    for (const bad of ["Hi {{first_name}}", "See https://x.example", "Saw {headline} at {account}", "", "x".repeat(201)]) expect(validOpener(bad)).toBeNull();
  });

  it("quotes a headline only cleaned, capped and without links or markup", () => {
    expect(quotableHeadline("Brightloop Labs raises Series B")).toBe("Brightloop Labs raises Series B");
    expect(quotableHeadline("Read more at https://news.example/x")).toBeNull();
    expect(quotableHeadline("<script>x</script>")).toBeNull();
    expect((quotableHeadline(`Brightloop ${"word ".repeat(60)}`) ?? "").length).toBeLessThanOrEqual(120);
  });
});

describe("loadAngles", () => {
  beforeEach(async () => {
    await seedAccount(db, "brightloop.example", "Brightloop Labs", { score: 8 });
  });

  it("builds an angle only from a live, dated, sourced signal of a category with an angle", async () => {
    const id = await seedContact(db, { first: "Ada", last: "One", email: "ada@brightloop.example", accountName: "Brightloop Labs" });
    const subject = [{ contactId: id, accountKey: "brightloop.example", accountName: "Brightloop Labs" }];
    expect((await loadAngles(db, subject, NOW)).size).toBe(0);

    await recordSignal(db, newSignal("brightloop.example", { type: "product_usage", eventKey: "pu" }), NOW);
    await recordSignal(db, newSignal("brightloop.example", { type: "post", eventKey: "post" }), NOW);
    await recordSignal(db, newSignal("brightloop.example", { eventDate: daysAgo(60), eventKey: "old" }), NOW);
    expect((await loadAngles(db, subject, NOW)).size).toBe(0);

    await recordSignal(db, newSignal("brightloop.example", { type: "hiring", source: "hiring_board", eventDate: daysAgo(9), eventKey: "hire" }), NOW);
    const angle = (await loadAngles(db, subject, NOW)).get(id);
    expect(angle).toMatchObject({ kind: "hiring", confidence: "high", age: "last week", opener: "I noticed Brightloop Labs is growing the team." });
    expect(angle?.headline).toBeUndefined();
  });

  it("stops at expiry, and a dismissed signal gives none", async () => {
    const id = await seedContact(db, { first: "Ada", last: "One", email: "ada@brightloop.example", accountName: "Brightloop Labs" });
    await recordSignal(db, newSignal("brightloop.example"), NOW);
    const subject = [{ contactId: id, accountKey: "brightloop.example", accountName: "Brightloop Labs" }];
    expect((await loadAngles(db, subject, new Date(NOW.getTime() + 31 * 86_400_000))).size).toBe(0);
    await db.prepare("UPDATE signal_events SET status = 'dismissed'").run();
    expect((await loadAngles(db, subject, NOW)).size).toBe(0);
  });

  it("quotes the headline only for a whitelisted source", async () => {
    const id = await seedContact(db, { first: "Ada", last: "One", email: "ada@brightloop.example", accountName: "Brightloop Labs" });
    await recordSignal(db, newSignal("brightloop.example"), NOW);
    const subject = [{ contactId: id, accountKey: "brightloop.example", accountName: "Brightloop Labs" }];
    expect((await loadAngles(db, subject, NOW)).get(id)?.headline).toBeUndefined();
    expect((await loadAngles(db, subject, NOW, { quoteSources: ["exa_news"] })).get(id)?.headline).toBe("Brightloop Labs raises Series B");
  });

  it("gives no angle without a usable account name", async () => {
    const id = await seedContact(db, { first: "Ada", last: "One", email: "ada@brightloop.example" });
    await recordSignal(db, newSignal("brightloop.example"), NOW);
    expect((await loadAngles(db, [{ contactId: id, accountKey: "brightloop.example", accountName: null }], NOW)).size).toBe(0);
  });
});

describe("the gate: most first touches carry a dated reason", () => {
  it("composes every signalled contact with a dated reason from its real signal, holds the rest, and records the signalled cohort", async () => {
    const accounts = [
      { key: "brightloop.example", name: "Brightloop Labs", signal: { type: "funding" as const, days: 4 } },
      { key: "quillstack.example", name: "Quillstack", signal: { type: "hiring" as const, days: 10 } },
      { key: "tidewater.example", name: "Tidewater Systems", signal: { type: "launch" as const, days: 25 } },
      { key: "northwind-tools.example", name: "Northwind Tools", signal: null },
    ];
    const contacts: Array<{ id: string; account: (typeof accounts)[number] }> = [];
    for (const [i, account] of accounts.entries()) {
      await seedAccount(db, account.key, account.name, { score: 8 });
      const id = await seedContact(db, { first: ["Ada", "Ben", "Cy", "Dee"][i] ?? "Eve", last: "Test", email: `person${i}@${account.key}`, accountName: account.name });
      contacts.push({ id, account });
      if (account.signal) {
        const outcome = await recordSignal(
          db,
          newSignal(account.key, { type: account.signal.type, source: account.signal.type === "hiring" ? "hiring_board" : "exa_news", eventDate: daysAgo(account.signal.days), url: `https://news.example/${account.key}`, eventKey: `e-${account.key}` }),
          NOW,
        );
        expect(outcome.status).toBe("recorded");
      }
    }
    const rows = await Promise.all(contacts.map((c) => selectionRow(c.id)));
    const angles = await loadAngles(db, rows.map((r) => ({ contactId: r.id, accountKey: r.account_key, accountName: r.account_name })), NOW);
    const templates = await angleTemplate();
    const signalled = await signalledContacts(db, rows.map((r) => ({ contactId: r.id, accountKey: r.account_key })), NOW);

    let withReason = 0;
    for (const [i, row] of rows.entries()) {
      const account = contacts[i]?.account;
      const outcome = composeColdDraft(row, templates, createRotation(), ctx(angles));
      if (account?.signal) {
        expect(outcome.status, account.key).toBe("composed");
        if (outcome.status !== "composed") continue;
        expect(outcome.result.verdict).not.toBe("block");
        const angle = angles.get(row.id);
        expect(angle).toBeDefined();
        expect(outcome.body).toContain(angle?.opener ?? "missing");
        expect(outcome.body).toContain(angle?.age ?? "missing");
        // The reason is the real signal's: its event date gives the age.
        const signal = await db.prepare("SELECT event_date, source_url FROM signal_events WHERE id = ?1").bind(angle?.signalId).first<{ event_date: string; source_url: string }>();
        expect(signal?.source_url).toBe(`https://news.example/${account.key}`);
        expect(angleAge(signal?.event_date ?? "", NOW)).toBe(angle?.age);
        expect(cohortFor(signalled, row.id, false)).toBe("signalled");
        withReason += 1;
      } else {
        expect(outcome.status).toBe("held");
        expect(JSON.stringify(outcome.result.findings)).toContain("{{angle_opener}}");
        expect(cohortFor(signalled, row.id, false)).toBe("generic");
      }
    }
    expect(withReason / rows.length).toBeGreaterThan(0.5);
  });

  it("still holds a template using angle variables when no angles are loaded", async () => {
    await seedAccount(db, "brightloop.example", "Brightloop Labs", { score: 8 });
    const id = await seedContact(db, { first: "Ada", last: "One", email: "ada@brightloop.example", accountName: "Brightloop Labs" });
    await recordSignal(db, newSignal("brightloop.example"), NOW);
    const outcome = composeColdDraft(await selectionRow(id), await angleTemplate(), createRotation(), ctx(undefined));
    expect(outcome.status).toBe("held");
  });

  it("marks a draft quoting a headline for per-draft review", async () => {
    await seedAccount(db, "brightloop.example", "Brightloop Labs", { score: 8 });
    const id = await seedContact(db, { first: "Ada", last: "One", email: "ada@brightloop.example", accountName: "Brightloop Labs" });
    await recordSignal(db, newSignal("brightloop.example"), NOW);
    const row = await selectionRow(id);
    const angles = await loadAngles(db, [{ contactId: id, accountKey: row.account_key, accountName: row.account_name }], NOW, { quoteSources: ["exa_news"] });
    const body = ANGLE_BODY.replace("{{angle_opener}}", "{{angle_opener}} ({{angle_headline}})");
    const templates = (await serveTemplateFiles([templateFile("cold-quote", { body })], { companyDomain: "acme.example" })).templates;
    const outcome = composeColdDraft(row, templates, createRotation(), ctx(angles));
    expect(outcome.status).toBe("composed");
    if (outcome.status !== "composed") return;
    expect(outcome.perDraftReview).toBe(true);
    expect(outcome.body).toContain("Brightloop Labs raises Series B");
  });
});
