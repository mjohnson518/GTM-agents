// GTM-agents: employment checks and champion moves, held to the privacy and untrusted-text rules
// (docs/SIGNALS.md#employment-checks). A champion who moved is one person at two addresses: erasing
// either address erases the contacts, candidates and data held under both, and tombstones both. The
// provider's text (a title, a company name) is data: it never reaches a notice or a signal headline,
// and what is stored of it is one cleaned line. A flag that cannot be read checks nobody.
import { contactEmailFields, eraseContact } from "@gtm-agents/core/data";
import type { EmploymentChecker } from "@gtm-agents/core/ports";
import { checkSuppression } from "@gtm-agents/core/sending";
import { CHAMPION_SOURCE, SIGNAL_FLAGS, createSignalJobs, runEmploymentChecks } from "@gtm-agents/core/signals";
import { createSpendGate } from "@gtm-agents/core/sourcing";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { INJECTED_PAGE, uid } from "./helpers.ts";

const db = env.DB;
const NOW = new Date("2026-11-04T09:00:00.000Z");
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const noFlags = { get: () => Promise.resolve(null) };

async function contact(warmth: string): Promise<{ id: string; email: string; account: string; profile: string }> {
  const account = `${uid("brightloop").replace(/_/g, "-")}.example`;
  const fields = await contactEmailFields(`${uid("erin").replace(/_/g, ".")}@${account}`);
  if (!fields) throw new Error("bad synthetic address");
  const id = uid("contact");
  const profile = `https://profiles.example/in/${id}`;
  await db.prepare("INSERT OR IGNORE INTO accounts (account_key, name, domain) VALUES (?1, 'Brightloop Labs', ?1)").bind(account).run();
  await db
    .prepare("INSERT INTO contacts (id, first_name, last_name, email, email_sha256, mailbox_sha256, account_key, warmth, attributes) VALUES (?1, 'Erin', 'Lane', ?2, ?3, ?4, ?5, ?6, ?7)")
    .bind(id, fields.email, fields.email_sha256, fields.mailbox_sha256, account, warmth, JSON.stringify({ profile_url: profile }))
    .run();
  return { id, email: fields.email, account, profile };
}

function checker(newEmail: string, text = `${INJECTED_PAGE} Chief Exfiltration Officer`): EmploymentChecker {
  const domain = newEmail.slice(newEmail.indexOf("@") + 1);
  return {
    name: "fake-employment",
    checkEmployment: () => Promise.resolve({ status: "moved", title: text, cost: { provider: "fake-employment", capability: "job_change", usd: 0.06 } }),
    findCurrentWorkEmail: () => Promise.resolve({ email: newEmail, domain, companyName: text, sources: [], cost: { provider: "fake-employment", capability: "email_find", usd: 0.02 } }),
  };
}

async function moveChampion(warmth = "engaged", operator?: { notify(m: { text: string }): Promise<{ messageId: string }> }) {
  const old = await contact(warmth);
  const newDomain = `${uid("initech").replace(/_/g, "-")}.example`;
  const newEmail = `erin.lane@${newDomain}`;
  await runEmploymentChecks({
    db,
    checker: checker(newEmail),
    // Each simulated run spends against its own job name, so the file's runs never share a daily cap.
    gate: createSpendGate({ db, flags: noFlags, job: uid("employment_test"), jobCapCents: 60, now: () => NOW }),
    now: NOW,
    log: silent,
    champions: true,
    maxChecks: 50,
    ...(operator ? { operator: operator as never } : {}),
  });
  return { old, newEmail, newDomain };
}

/** Promote the champion candidate the way promotion does: a contact at the new address, linked. */
async function promoteChampion(oldId: string, newEmail: string, newDomain: string): Promise<string> {
  const fields = await contactEmailFields(newEmail);
  if (!fields) throw new Error("bad synthetic address");
  const id = uid("contact");
  await db.prepare("INSERT OR IGNORE INTO accounts (account_key, name, domain) VALUES (?1, 'Initech', ?1)").bind(newDomain).run();
  await db
    .prepare("INSERT INTO contacts (id, first_name, last_name, email, email_sha256, mailbox_sha256, account_key, warmth) VALUES (?1, 'Erin', 'Lane', ?2, ?3, ?4, ?5, 'cold')")
    .bind(id, fields.email, fields.email_sha256, fields.mailbox_sha256, newDomain)
    .run();
  await db.prepare("UPDATE candidates SET status = 'promoted', promoted_contact_id = ?2 WHERE source_contact_id = ?1").bind(oldId, id).run();
  return id;
}

const exists = async (table: string, column: string, value: string) => (await db.prepare(`SELECT 1 AS hit FROM ${table} WHERE ${column} = ?1`).bind(value).first()) !== null;
const blocked = async (email: string) => !(await checkSuppression(db, [email])).ok;

describe("champion moves: erasure follows the person to both addresses", () => {
  it("erasing the old address deletes the champion candidate and tombstones the new address", async () => {
    const { old, newEmail } = await moveChampion();
    expect(await exists("candidates", "source_contact_id", old.id)).toBe(true);
    await eraseContact(db, old.email, { source: "operator", now: NOW, bucket: env.BUCKET });
    expect(await exists("contacts", "id", old.id)).toBe(false);
    expect(await exists("candidates", "source_contact_id", old.id)).toBe(false);
    expect(await exists("candidates", "email", newEmail)).toBe(false);
    expect(await blocked(newEmail)).toBe(true);
    expect(await blocked(old.email)).toBe(true);
  });

  it("erasing the old address deletes a champion candidate whose address enrichment already cleared", async () => {
    const { old } = await moveChampion();
    // A rejected candidate can lose its address and keep the name and profile URL.
    await db.prepare("UPDATE candidates SET status = 'rejected', email = NULL WHERE source_contact_id = ?1").bind(old.id).run();
    await eraseContact(db, old.email, { source: "operator", now: NOW, bucket: env.BUCKET });
    expect(await exists("candidates", "source_contact_id", old.id)).toBe(false);
  });

  it("erasing the old address erases the contact promoted at the new one", async () => {
    const { old, newEmail, newDomain } = await moveChampion();
    const promoted = await promoteChampion(old.id, newEmail, newDomain);
    const result = await eraseContact(db, old.email, { source: "operator", now: NOW, bucket: env.BUCKET });
    expect(result.contactsDeleted).toBe(2);
    expect(await exists("contacts", "id", promoted)).toBe(false);
    expect(await blocked(newEmail)).toBe(true);
  });

  it("erasing the new address erases the old contact too", async () => {
    const { old, newEmail, newDomain } = await moveChampion("hot");
    const promoted = await promoteChampion(old.id, newEmail, newDomain);
    await eraseContact(db, newEmail, { source: "reply", now: NOW, bucket: env.BUCKET });
    expect(await exists("contacts", "id", promoted)).toBe(false);
    expect(await exists("contacts", "id", old.id)).toBe(false);
    expect(await blocked(old.email)).toBe(true);
  });

  it("erasing the new address before the champion is promoted erases the old contact", async () => {
    const { old, newEmail } = await moveChampion();
    await eraseContact(db, newEmail, { source: "reply", now: NOW, bucket: env.BUCKET });
    expect(await exists("contacts", "id", old.id)).toBe(false);
    expect(await exists("candidates", "source_contact_id", old.id)).toBe(false);
    expect(await blocked(old.email)).toBe(true);
  });

  it("erasing the plain mailbox follows a link held at a +tag address", async () => {
    const { old, newEmail } = await moveChampion();
    await db.prepare("UPDATE candidates SET email = ?2 WHERE source_contact_id = ?1").bind(old.id, newEmail.replace("@", "+work@")).run();
    await eraseContact(db, newEmail, { source: "reply", now: NOW, bucket: env.BUCKET });
    expect(await exists("contacts", "id", old.id)).toBe(false);
    expect(await exists("candidates", "source_contact_id", old.id)).toBe(false);
  });

  it("erasing a +tag variant of the new address follows the link too", async () => {
    const { old, newEmail } = await moveChampion();
    const tagged = newEmail.replace("@", "+news@");
    await eraseContact(db, tagged, { source: "reply", now: NOW, bucket: env.BUCKET });
    expect(await exists("contacts", "id", old.id)).toBe(false);
    expect(await exists("candidates", "source_contact_id", old.id)).toBe(false);
  });

  async function withNamesake(): Promise<{ old: { id: string; email: string }; namesake: string; namesakeEmail: string }> {
    const { old, newDomain } = await moveChampion();
    // A different person with the same name already at the new company: promotion marks the
    // champion a duplicate of them by name.
    const fields = await contactEmailFields(`e.lane@${newDomain}`);
    if (!fields) throw new Error("bad synthetic address");
    const namesake = uid("contact");
    await db.prepare("INSERT OR IGNORE INTO accounts (account_key, name, domain) VALUES (?1, 'Initech', ?1)").bind(newDomain).run();
    await db
      .prepare("INSERT INTO contacts (id, first_name, last_name, email, email_sha256, mailbox_sha256, account_key, warmth) VALUES (?1, 'Erin', 'Lane', ?2, ?3, ?4, ?5, 'cold')")
      .bind(namesake, fields.email, fields.email_sha256, fields.mailbox_sha256, newDomain)
      .run();
    await db.prepare("UPDATE candidates SET status = 'duplicate', promoted_contact_id = ?2 WHERE source_contact_id = ?1").bind(old.id, namesake).run();
    return { old, namesake, namesakeEmail: fields.email };
  }

  it("erasing the champion never erases a namesake they were matched to by name", async () => {
    const { old, namesake, namesakeEmail } = await withNamesake();
    await eraseContact(db, old.email, { source: "operator", now: NOW, bucket: env.BUCKET });
    expect(await exists("contacts", "id", old.id)).toBe(false);
    expect(await exists("contacts", "id", namesake)).toBe(true);
    expect(await blocked(namesakeEmail)).toBe(false);
  });

  it("erasing the namesake never erases the champion", async () => {
    const { old, namesake, namesakeEmail } = await withNamesake();
    await eraseContact(db, namesakeEmail, { source: "operator", now: NOW, bucket: env.BUCKET });
    expect(await exists("contacts", "id", namesake)).toBe(false);
    expect(await exists("contacts", "id", old.id)).toBe(true);
    expect(await blocked(old.email)).toBe(false);
  });

  it("erasure deletes a held notice that names the person by contact id", async () => {
    const victim = await contact("engaged");
    await db
      .prepare("INSERT INTO operator_outbox (id, kind, text, silent, status, release_at, attempts) VALUES (?1, 'notice', ?2, 0, 'held', ?3, 0)")
      .bind(uid("ob"), `Erin Lane at ${victim.account} (contact ${victim.id}) has moved to another company.`, NOW.toISOString())
      .run();
    await eraseContact(db, victim.email, { source: "operator", now: NOW, bucket: env.BUCKET });
    expect(await db.prepare("SELECT 1 FROM operator_outbox WHERE instr(text, ?1) > 0").bind(victim.id).first()).toBeNull();
  });

  it("erasing someone unrelated touches neither", async () => {
    const { old } = await moveChampion();
    const bystander = await contact("engaged");
    await eraseContact(db, bystander.email, { source: "operator", now: NOW, bucket: env.BUCKET });
    expect(await exists("contacts", "id", old.id)).toBe(true);
    expect(await exists("candidates", "source_contact_id", old.id)).toBe(true);
  });
});

describe("employment checks: provider text is data", () => {
  it("never reaches the notice or a signal headline, and is stored as one cleaned line", async () => {
    const sent: string[] = [];
    const operator = {
      notify(m: { text: string }) {
        sent.push(m.text);
        return Promise.resolve({ messageId: "m" });
      },
    };
    const { old } = await moveChampion("engaged", operator);
    const notice = sent.join("\n");
    expect(notice).toContain("has moved to another company");
    expect(notice).not.toMatch(/IGNORE|collector@|Exfiltration|tool_output/);
    const row = await db.prepare("SELECT job_title, account_name FROM candidates WHERE source = ?1 AND source_contact_id = ?2").bind(CHAMPION_SOURCE, old.id).first<{ job_title: string; account_name: string }>();
    for (const value of [row?.job_title ?? "", row?.account_name ?? ""]) {
      expect(value).not.toMatch(/[\r\n]/);
      expect(value).not.toContain("collector@attacker.example");
      expect(value.length).toBeLessThanOrEqual(120);
    }
    const headlines = await db.prepare("SELECT headline FROM signal_events WHERE contact_id = ?1").bind(old.id).all<{ headline: string }>();
    for (const h of headlines.results) expect(h.headline).not.toMatch(/IGNORE|Exfiltration/);
  });
});

describe("employment checks: the gate fails closed", () => {
  it("a flag that cannot be read checks nobody", async () => {
    await contact("hot");
    let calls = 0;
    const counting: EmploymentChecker = {
      name: "fake-employment",
      checkEmployment: () => {
        calls += 1;
        return Promise.resolve({ status: "current" });
      },
      findCurrentWorkEmail: () => Promise.resolve({ email: null }),
    };
    const [job] = createSignalJobs({ adapters: () => ({ employment: counting }) }).filter((j) => j.name === "signal_employment");
    const broken = { get: () => Promise.reject(new Error("kv down")) };
    const result = await job?.run({
      env: { DB: db, KV: env.KV },
      job: "signal_employment",
      now: NOW,
      signal: new AbortController().signal,
      ceilings: { maxDurationMs: 120_000, maxRows: 15, maxSpendCents: 60 },
      flags: broken,
      log: silent,
    } as never);
    expect(result).toEqual({ summary: "flag off" });
    expect(calls).toBe(0);
    expect(SIGNAL_FLAGS.jobChange).toBe("signals:job_change_enabled");
  });
});
