// GTM-agents: tests for the data model: the schema, its enums, account keys, forward-only warmth
// and deal transitions.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  CANDIDATE_STATUSES,
  DEAL_STAGES,
  EXPERIMENT_METRICS,
  DEAL_TRANSITIONS,
  DRAFT_KINDS,
  DRAFT_STATUSES,
  LIFECYCLE_STATES,
  SEND_PATHS,
  SIGNAL_TYPES,
  TEMPLATE_KINDS,
  VERIFICATION_STATUSES,
  WARMTH_STATES,
  accountKey,
  advanceWarmth,
  canAdvanceWarmth,
  canTransitionDeal,
  contactEmailFields,
  eraseByHash,
  eraseContact,
  inChunks,
  placeholders,
  transitionDeal,
  type Warmth,
} from "../src/data/index.ts";
import { TAINT_LEVELS } from "../src/ports/types.ts";

const DIGEST = "a".repeat(64);
const randomHex = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
let seq = 0;
const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${++seq}`;

async function contact(warmth: Warmth = "cold"): Promise<string> {
  const id = uid("contact");
  const fields = await contactEmailFields(`${id}@prospect.example`);
  if (!fields) throw new Error("fixture address did not normalize");
  await env.DB.prepare("INSERT INTO contacts (id, email, email_sha256, mailbox_sha256, warmth) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(id, fields.email, fields.email_sha256, fields.mailbox_sha256, warmth)
    .run();
  return id;
}

async function deal(stage: string = "prospecting"): Promise<string> {
  const id = uid("deal");
  await env.DB.prepare("INSERT INTO deals (id, name, stage) VALUES (?1, 'Acme pilot', ?2)").bind(id, stage).run();
  return id;
}

async function tables(): Promise<Map<string, string>> {
  const { results } = await env.DB.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all<{ name: string; sql: string }>();
  return new Map(results.map((r) => [r.name, r.sql]));
}

describe("the schema", () => {
  it("creates every table its migrations declare, each with created_at", async () => {
    const declared = env.TEST_MIGRATIONS.flatMap((m) => m.queries.join("\n").match(/CREATE TABLE IF NOT EXISTS (\w+)/g) ?? []).map((s) => s.split(" ").at(-1) ?? "");
    expect(declared.length).toBeGreaterThan(90);
    const existing = await tables();
    for (const name of declared) {
      expect(existing.has(name), name).toBe(true);
      const { results } = await env.DB.prepare(`PRAGMA table_info(${name})`).all<{ name: string }>();
      expect(results.map((c) => c.name), name).toContain("created_at");
    }
    expect(existing.has("memory_fts")).toBe(true);
  });

  it("can apply every migration again without error", async () => {
    for (const migration of env.TEST_MIGRATIONS) {
      await env.DB.batch(migration.queries.map((q) => env.DB.prepare(q)));
    }
  });

  it("keeps each enum CHECK exactly in step with its TypeScript constant", async () => {
    const schema = await tables();
    const checkValues = (table: string, column: string): string[] => {
      const sql = schema.get(table) ?? "";
      const match = new RegExp(`CHECK \\(${column} (?:IS NULL OR ${column} )?IN \\(([^)]*)\\)`).exec(sql);
      if (!match?.[1]) throw new Error(`no CHECK list for ${table}.${column}`);
      return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1] ?? "");
    };
    const parity: Array<[string, string, readonly string[]]> = [
      ["contacts", "warmth", WARMTH_STATES],
      ["contacts", "verification_status", VERIFICATION_STATUSES],
      ["deals", "stage", DEAL_STAGES],
      ["deal_stage_history", "from_stage", DEAL_STAGES],
      ["deal_stage_history", "to_stage", DEAL_STAGES],
      ["candidates", "status", CANDIDATE_STATUSES],
      ["drafts", "status", DRAFT_STATUSES],
      ["drafts", "kind", DRAFT_KINDS],
      ["templates", "kind", TEMPLATE_KINDS],
      ["contact_lifecycle", "state", LIFECYCLE_STATES],
      ["signal_events", "type", SIGNAL_TYPES],
      ["email_verifications", "status", VERIFICATION_STATUSES],
      ["outreach_sends", "send_path", SEND_PATHS],
      ["deferred_sends", "send_path", SEND_PATHS],
      ["events", "taint", TAINT_LEVELS],
      ["delegation_tasks", "final_taint", TAINT_LEVELS],
      ["experiments", "primary_metric", EXPERIMENT_METRICS],
    ];
    for (const [table, column, values] of parity) expect(checkValues(table, column), `${table}.${column}`).toEqual([...values]);
  });

  it("refuses a value outside an enum", async () => {
    await expect(env.DB.prepare("INSERT INTO deals (id, name, stage) VALUES (?1, 'n', 'won_maybe')").bind(uid("d")).run()).rejects.toThrow(/CHECK/);
    await expect(
      env.DB.prepare("INSERT INTO contacts (id, email, email_sha256, mailbox_sha256, warmth) VALUES (?1, ?2, ?3, ?3, 'lukewarm')").bind(uid("c"), `${uid("x")}@prospect.example`, randomHex()).run(),
    ).rejects.toThrow(/CHECK/);
  });

  it("refuses uppercase or malformed hashes and unnormalized addresses", async () => {
    const insert = (email: string, hash: string) =>
      env.DB.prepare("INSERT INTO contacts (id, email, email_sha256, mailbox_sha256) VALUES (?1, ?2, ?3, ?3)").bind(uid("c"), email, hash).run();
    await expect(insert(`${uid("x")}@prospect.example`, randomHex().toUpperCase())).rejects.toThrow(/CHECK/);
    await expect(insert(`${uid("x")}@prospect.example`, "g".repeat(64))).rejects.toThrow(/CHECK/);
    await expect(insert(`Mixed.${uid("x")}@Prospect.Example`, randomHex())).rejects.toThrow(/CHECK/);
  });

  it("rejects invalid JSON attributes, approvals without a digest and malformed account keys", async () => {
    await expect(env.DB.prepare("INSERT INTO deals (id, name, attributes) VALUES (?1, 'n', 'not json')").bind(uid("d")).run()).rejects.toThrow(/CHECK/);
    await expect(env.DB.prepare("INSERT INTO drafts (id, kind, status) VALUES (?1, 'reply', 'approved')").bind(uid("dr")).run()).rejects.toThrow(/CHECK/);
    for (const key of ["Acme.example", "acme"]) {
      await expect(env.DB.prepare("INSERT INTO accounts (account_key, name) VALUES (?1, 'Acme')").bind(key).run(), key).rejects.toThrow(/CHECK/);
    }
  });

  it("decides, for every foreign key to contacts, whether erasure deletes or clears", async () => {
    const expected: Record<string, "CASCADE" | "SET NULL"> = {
      accounts: "SET NULL", contact_tags: "CASCADE", contact_lifecycle: "CASCADE", contact_scores: "CASCADE", contact_engagement: "CASCADE",
      contact_angles: "CASCADE", contact_evidence: "CASCADE", contact_fit: "CASCADE", account_contacts: "CASCADE", deals: "SET NULL",
      meetings: "CASCADE", calendar_meetings: "CASCADE", proof_of_value_requests: "CASCADE", subscriptions: "SET NULL", billing_customers: "SET NULL",
      referrals: "CASCADE", ref_tokens: "CASCADE", campaign_contacts: "CASCADE", drafts: "CASCADE", outreach_log: "CASCADE", outreach_sends: "SET NULL",
      outreach_sequence_runs: "CASCADE", outreach_holdout: "CASCADE", deferred_sends: "CASCADE", send_slot_schedules: "CASCADE", followups: "CASCADE",
      followup_touches: "CASCADE", manual_touches: "CASCADE", reply_qualifications: "CASCADE", experiment_assignments: "SET NULL",
      subject_assignments: "SET NULL", candidates: "SET NULL", monitor_items: "SET NULL", signal_events: "CASCADE", inbound_emails: "CASCADE",
      events: "SET NULL", funnel_events: "SET NULL", engagement_events: "CASCADE", lifecycle_transitions: "CASCADE", feedback_items: "CASCADE",
    };
    const actual: Record<string, string> = {};
    for (const table of (await tables()).keys()) {
      if (table.startsWith("_cf") || table.startsWith("sqlite_") || table.startsWith("memory_fts") || table === "d1_migrations") continue;
      const { results } = await env.DB.prepare(`SELECT "table" AS target, on_delete FROM pragma_foreign_key_list('${table}')`).all<{ target: string; on_delete: string }>();
      for (const fk of results) if (fk.target === "contacts") actual[table] = fk.on_delete;
    }
    expect(actual).toEqual(expected);
  });

  it("erases a person completely: no table keeps their address, and a tombstone remains", async () => {
    const id = await contact("contacted");
    const row = await env.DB.prepare("SELECT email FROM contacts WHERE id = ?1").bind(id).first<{ email: string }>();
    const email = row?.email ?? "";
    const sendId = uid("send");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contact_tags (contact_id, tag) VALUES (?1, 'pilot')").bind(id),
      env.DB.prepare("INSERT INTO candidates (id, source, email, first_name, promoted_contact_id) VALUES (?1, 'test', ?2, 'Jane', ?3)").bind(uid("cand"), email.toUpperCase(), id),
      env.DB.prepare("INSERT INTO candidates (id, source, email) VALUES (?1, 'test', ?2)").bind(uid("cand2"), email),
      env.DB.prepare("INSERT INTO drafts (id, kind, recipient_email, body) VALUES (?1, 'reply', ?2, 'Hello')").bind(uid("dr"), email),
      env.DB.prepare("INSERT INTO inbound_emails (id, provider, provider_message_id, sender_email, received_at) VALUES (?1, 'test', ?1, ?2, 'x')").bind(uid("in"), email),
      env.DB.prepare("INSERT INTO meetings (id, contact_id, summary) VALUES (?1, ?2, 'notes')").bind(uid("m"), id),
      env.DB.prepare("INSERT INTO referrals (id, referrer_contact_id, referee_email) VALUES (?1, ?2, ?3)").bind(uid("r"), await contact(), email),
      env.DB.prepare("INSERT INTO outreach_sends (id, contact_id, send_path, provider, sent_at) VALUES (?1, ?2, 'cold', 'test', '2026-11-04T00:00:00.000Z')").bind(sendId, id),
    ]);
    const result = await eraseContact(env.DB, email, { source: "operator" });
    expect(result.contactsDeleted).toBe(1);
    for (const [table] of await tables()) {
      if (table.startsWith("memory_fts") || table.startsWith("_cf") || table.startsWith("sqlite_") || table === "d1_migrations") continue;
      const { results: cols } = await env.DB.prepare(`SELECT name, type FROM pragma_table_info('${table}')`).all<{ name: string; type: string }>();
      for (const col of cols.filter((c) => c.type === "TEXT")) {
        const hit = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE lower("${col.name}") = ?1`).bind(email).first<{ n: number }>();
        expect(hit?.n, `${table}.${col.name}`).toBe(0);
      }
    }
    expect(await env.DB.prepare("SELECT contact_id FROM outreach_sends WHERE id = ?1").bind(sendId).first()).toEqual({ contact_id: null });
    expect(await env.DB.prepare("SELECT source FROM erasure_tombstones WHERE email_sha256 = ?1").bind(result.emailSha256).first()).toEqual({ source: "operator" });
  });

  it("erases the whole mailbox, whichever subaddress is named, in any spelling", async () => {
    const base = uid("mailbox");
    const tagged = await contactEmailFields(`${base}+news@prospect.example`);
    if (!tagged) throw new Error("fixture address did not normalize");
    const contactId = uid("contact");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contacts (id, email, email_sha256, mailbox_sha256) VALUES (?1, ?2, ?3, ?4)").bind(contactId, tagged.email, tagged.email_sha256, tagged.mailbox_sha256),
      env.DB.prepare("INSERT INTO drafts (id, kind, recipient_email) VALUES (?1, 'reply', ?2)").bind(uid("dr"), `Jane <${base}@prospect.example>`),
      env.DB.prepare("INSERT INTO candidates (id, source, email) VALUES (?1, 'test', ?2)").bind(uid("cand"), `  ${base.toUpperCase()}@Prospect.example `),
    ]);
    const result = await eraseContact(env.DB, `${base}@prospect.example`, { source: "operator" });
    expect(result.contactsDeleted).toBe(1);
    const left = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM contacts WHERE id = ?1) AS contacts,
              (SELECT COUNT(*) FROM drafts WHERE instr(lower(recipient_email), ?2) > 0) AS drafts,
              (SELECT COUNT(*) FROM candidates WHERE instr(lower(email), ?2) > 0) AS candidates`,
    )
      .bind(contactId, base.toLowerCase())
      .first();
    expect(left).toEqual({ contacts: 0, drafts: 0, candidates: 0 });
  });

  it("erases by address hash alone, fully when a contact holds the hash", async () => {
    const id = await contact("engaged");
    const row = await env.DB.prepare("SELECT email_sha256 FROM contacts WHERE id = ?1").bind(id).first<{ email_sha256: string }>();
    expect((await eraseByHash(env.DB, row?.email_sha256 ?? "", { source: "product" })).contactsDeleted).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM contacts WHERE id = ?1").bind(id).first()).toEqual({ n: 0 });
    const unknown = randomHex();
    expect(await eraseByHash(env.DB, unknown, { source: "product" })).toEqual({ emailSha256: unknown, contactsDeleted: 0 });
    expect(await env.DB.prepare("SELECT source FROM erasure_tombstones WHERE email_sha256 = ?1").bind(unknown).first()).toEqual({ source: "product" });
    await expect(eraseByHash(env.DB, "ABC", { source: "product" })).rejects.toThrow(TypeError);
  });

  it("refuses to delete an opted-out contact until the opt-out is kept elsewhere", async () => {
    const id = await contact("opted_out");
    await expect(env.DB.prepare("DELETE FROM contacts WHERE id = ?1").bind(id).run()).rejects.toThrow(/opt-out/);
    const row = await env.DB.prepare("SELECT email FROM contacts WHERE id = ?1").bind(id).first<{ email: string }>();
    expect((await eraseContact(env.DB, row?.email ?? "", { source: "operator" })).contactsDeleted).toBe(1);
  });

  it("keeps terminal warmth terminal in the database, whatever code writes it", async () => {
    const opted = await contact("opted_out");
    await expect(env.DB.prepare("UPDATE contacts SET warmth = 'cold' WHERE id = ?1").bind(opted).run()).rejects.toThrow(/terminal/);
    const churned = await contact("churned");
    await expect(env.DB.prepare("UPDATE contacts SET warmth = 'hot' WHERE id = ?1").bind(churned).run()).rejects.toThrow(/terminal/);
    await env.DB.prepare("UPDATE contacts SET warmth = 'opted_out' WHERE id = ?1").bind(churned).run();
  });

  it("returns an approved draft to review when its content is edited in the database", async () => {
    const id = uid("dr");
    await env.DB.prepare("INSERT INTO drafts (id, kind, status, approved_digest, body) VALUES (?1, 'reply', 'approved', ?2, 'Approved text')").bind(id, DIGEST).run();
    await env.DB.prepare("UPDATE drafts SET body = 'Changed text' WHERE id = ?1").bind(id).run();
    expect(await env.DB.prepare("SELECT status, approved_digest FROM drafts WHERE id = ?1").bind(id).first()).toEqual({ status: "pending_approval", approved_digest: null });
    const sneaky = uid("dr");
    await env.DB.prepare("INSERT INTO drafts (id, kind, status, approved_digest, body) VALUES (?1, 'reply', 'approved', ?2, 'Approved text')").bind(sneaky, DIGEST).run();
    await env.DB.prepare("UPDATE drafts SET body = 'Changed text', status = 'sent' WHERE id = ?1").bind(sneaky).run();
    expect(await env.DB.prepare("SELECT status FROM drafts WHERE id = ?1").bind(sneaky).first()).toEqual({ status: "pending_approval" });
  });
});

describe("account keys", () => {
  it("reduce URLs, addresses and domains to the lowercased registrable domain", () => {
    expect(accountKey("https://www.Acme.example/pricing")).toBe("acme.example");
    expect(accountKey("jane@eu.acme.example")).toBe("acme.example");
    expect(accountKey("acme.example")).toBe("acme.example");
    expect(accountKey("http://shop.globex.co.uk/")).toBe("globex.co.uk");
    expect(accountKey("ops@initech.com.au")).toBe("initech.com.au");
    expect(accountKey("jane@acme.com.co")).toBe("acme.com.co");
    expect(accountKey("https://shop.globex.co.th/")).toBe("globex.co.th");
  });

  it("are null for personal mailboxes, shared hosts and anything unusable", () => {
    for (const input of [
      "jane@gmail.com", "someone@hotmail.co.uk", "a@yahoo.fr", "b@outlook.de", "c@hotmail.co.jp", "d@gmx.net", "e@t-online.de", "x@privaterelay.appleid.com",
      "https://acme.github.io/", "https://www.linkedin.com/company/acme", "https://sites.google.com/view/acme", "https://acme.myshopify.com/",
      "a@acme.example, b@globex.example", "localhost", "http://10.0.0.1/", "", null, "not a domain",
    ]) {
      expect(accountKey(input), String(input)).toBeNull();
    }
  });
});

describe("contact email fields", () => {
  it("store the normalized address with exact and mailbox hashes, and refuse what does not parse", async () => {
    const tagged = await contactEmailFields("Jane <Jane+News@Prospect.Example>");
    const plain = await contactEmailFields("jane@prospect.example");
    expect(tagged?.email).toBe("jane+news@prospect.example");
    expect(tagged?.mailbox_sha256).toBe(plain?.email_sha256);
    expect(tagged?.email_sha256).not.toBe(plain?.email_sha256);
    expect(await contactEmailFields("jane at prospect")).toBeNull();
  });
});

describe("warmth", () => {
  it("only moves forward, and never leaves a terminal state", () => {
    expect(canAdvanceWarmth("cold", "engaged")).toBe(true);
    expect(canAdvanceWarmth("engaged", "contacted")).toBe(false);
    expect(canAdvanceWarmth("hot", "hot")).toBe(false);
    expect(canAdvanceWarmth("warming", "opted_out")).toBe(true);
    expect(canAdvanceWarmth("hot", "churned")).toBe(false);
    expect(canAdvanceWarmth("customer", "churned")).toBe(true);
    expect(canAdvanceWarmth("churned", "opted_out")).toBe(true);
    for (const to of WARMTH_STATES) expect(canAdvanceWarmth("opted_out", to), `opted_out -> ${to}`).toBe(false);
    for (const to of WARMTH_STATES.filter((w) => w !== "opted_out")) expect(canAdvanceWarmth("churned", to), `churned -> ${to}`).toBe(false);
  });

  it("is written by compare-and-set, so racing writers cannot move a contact backwards", async () => {
    const id = await contact("cold");
    const results = await Promise.all([advanceWarmth(env.DB, id, "warming"), advanceWarmth(env.DB, id, "contacted")]);
    expect(results.some((r) => r.changed)).toBe(true);
    const row = await env.DB.prepare("SELECT warmth FROM contacts WHERE id = ?1").bind(id).first<{ warmth: string }>();
    expect(row?.warmth).toBe("warming");
    // Whichever writer loses the race re-reads and either retries forward or stops; the higher state wins.
    const other = await contact("cold");
    await Promise.all([advanceWarmth(env.DB, other, "contacted"), advanceWarmth(env.DB, other, "hot")]);
    expect((await env.DB.prepare("SELECT warmth FROM contacts WHERE id = ?1").bind(other).first<{ warmth: string }>())?.warmth).toBe("hot");
    expect(await advanceWarmth(env.DB, id, "cold")).toEqual({ changed: false, reason: "not_forward", current: "warming" });
    expect(await advanceWarmth(env.DB, "missing", "hot")).toEqual({ changed: false, reason: "not_found" });
  });
});

describe("deal transitions", () => {
  it("allow forward moves and closed_lost from any open stage, and nothing out of a closed stage", () => {
    expect(canTransitionDeal("engaged", "closed_won")).toBe(true);
    expect(canTransitionDeal("trial", "engaged")).toBe(false);
    expect(canTransitionDeal("prospecting", "closed_lost")).toBe(true);
    expect(canTransitionDeal("closed_lost", "prospecting")).toBe(false);
    expect(DEAL_TRANSITIONS.some(([from]) => from === "closed_won" || from === "closed_lost")).toBe(false);
  });

  it("record each move in the stage history, once, even when two writers race", async () => {
    const id = await deal("engaged");
    const results = await Promise.all([transitionDeal(env.DB, id, "proposal", { reason: "sent proposal" }), transitionDeal(env.DB, id, "closed_lost", { reason: "no budget" })]);
    const changed = results.filter((r) => r.changed).length;
    expect(changed).toBeGreaterThanOrEqual(1);
    const { results: history } = await env.DB.prepare("SELECT from_stage, to_stage FROM deal_stage_history WHERE deal_id = ?1").bind(id).all();
    expect(history).toHaveLength(changed);
    expect(await transitionDeal(env.DB, id, "prospecting")).toMatchObject({ changed: false, reason: "not_allowed" });
  });
});

describe("D1 helpers", () => {
  it("chunk values to fit the 100-parameter limit and number placeholders", () => {
    expect(inChunks(Array.from({ length: 250 }, (_, i) => i)).map((c) => c.length)).toEqual([100, 100, 50]);
    expect(inChunks(Array.from({ length: 100 }, (_, i) => i), { perValue: 2, reserved: 10 }).map((c) => c.length)).toEqual([45, 45, 10]);
    expect(placeholders(3)).toBe("?1, ?2, ?3");
    expect(placeholders(2, 4)).toBe("?4, ?5");
  });
});
