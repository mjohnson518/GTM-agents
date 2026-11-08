// GTM-agents: the free account prescore, from data already held, through the one title classifier.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { contactEmailFields } from "../src/data/contacts.ts";
import { computePrescore, runPrescore } from "../src/scoring/prescore.ts";
import { loadSourcingBrain, type SourcingBrain } from "../src/sourcing/brain.ts";
import { resetSourcingTables, uploadBrain } from "./sourcing-fakes.ts";

let brain: SourcingBrain;
beforeAll(async () => {
  await uploadBrain(env.KV);
  brain = await loadSourcingBrain(env.KV);
});
beforeEach(() => resetSourcingTables(env.DB));

const aggregate = (titles: Array<string | null>, extra: Partial<Parameters<typeof computePrescore>[0]> = {}) => ({
  accountKey: "brightloop.example",
  accountName: "Brightloop Labs",
  titles,
  deliverableContacts: 0,
  recentSignalSeverity: null,
  hasFacts: false,
  ...extra,
});

describe("computePrescore", () => {
  it("scores team size, a decision maker, persona coverage, signals, reachability and facts", () => {
    const score = computePrescore(aggregate(["VP Engineering", "Staff Engineer", "Engineering Manager", "Account Executive"], { deliverableContacts: 2, recentSignalSeverity: 0.6, hasFacts: true }), brain);
    expect(score.parts).toEqual({ team: 20, seniority: 25, coverage: 15, signal: 20, reachable: 10, facts: 10 });
    expect(score.total).toBe(100);
    expect(score.buyerCount).toBe(1);
  });

  it("gives senior people without a decision maker less, and a weak signal half", () => {
    const score = computePrescore(aggregate(["Director of Sales"], { recentSignalSeverity: 0.3 }), brain);
    expect(score.parts).toMatchObject({ team: 5, seniority: 15, coverage: 0, signal: 10 });
  });

  it("scores an account on the never list 0", () => {
    const score = computePrescore(aggregate(["VP Engineering"], { accountKey: "globex.example" }), brain);
    expect(score).toMatchObject({ total: 0, never: true });
  });
});

describe("runPrescore", () => {
  it("writes account_fit from contacts, signals and facts, and keeps an existing model score", async () => {
    const add = async (id: string, email: string, title: string, verified: string | null) => {
      const f = await contactEmailFields(email);
      await env.DB.prepare("INSERT INTO contacts (id, email, email_sha256, mailbox_sha256, account_key, job_title, verification_status) VALUES (?1, ?2, ?3, ?4, 'brightloop.example', ?5, ?6)")
        .bind(id, f?.email, f?.email_sha256, f?.mailbox_sha256, title, verified)
        .run();
    };
    await env.DB.prepare("INSERT INTO accounts (account_key, name) VALUES ('brightloop.example', 'Brightloop Labs')").run();
    await add("c1", "vp@brightloop.example", "VP Engineering", "deliverable");
    await add("c2", "staff@brightloop.example", "Staff Engineer", null);
    await env.DB.prepare("INSERT INTO account_fit (account_key, status, fit_score, prescore) VALUES ('brightloop.example', 'scored', 8, 0)").run();
    await env.DB.prepare("INSERT INTO signal_events (id, type, account_key, headline, severity, detected_at) VALUES ('s1', 'hiring', 'brightloop.example', 'Hiring platform engineers', 0.6, ?1)")
      .bind(new Date("2026-11-01T00:00:00.000Z").toISOString())
      .run();
    const written = await runPrescore({ db: env.DB, brain, now: new Date("2026-11-04T04:00:00.000Z"), maxAccounts: 100 });
    expect(written).toBe(1);
    const row = await env.DB.prepare("SELECT * FROM account_fit WHERE account_key = 'brightloop.example'").first<Record<string, unknown>>();
    expect(row).toMatchObject({ account_name: "Brightloop Labs", contacts_count: 2, buyer_count: 1, status: "scored", fit_score: 8 });
    expect(row?.prescore).toBe(15 + 25 + 10 + 20 + 10);
    expect(JSON.parse(String(row?.prescore_detail))).toMatchObject({ team: 15, seniority: 25, coverage: 10, signal: 20, reachable: 10, facts: 0, never: false });
  });

  it("writes nothing when there are no contacts", async () => {
    expect(await runPrescore({ db: env.DB, brain, now: new Date(), maxAccounts: 100 })).toBe(0);
  });
});
