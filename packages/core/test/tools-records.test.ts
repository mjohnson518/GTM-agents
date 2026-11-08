// GTM-agents: tests for the contacts_search and drafts_create tools against the local D1 schema.
// Every person and address is invented, on *.example domains.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { contactEmailFields } from "../src/data/contacts.ts";
import { executeToolCall, type ToolHandlerResult } from "../src/runtime/dispatcher.ts";
import { createToolRegistry } from "../src/security/registry.ts";
import { CONTACTS_SEARCH_MAX_ROWS, createContactsSearchHandler } from "../src/tools/contacts-search.ts";
import { DRAFT_BODY_MAX_CHARS, createDraftsCreateHandler, type CreatedDraft } from "../src/tools/drafts-create.ts";

const db = env.DB;
const text = (r: ToolHandlerResult): string => (typeof r === "string" ? r : r.text);
const ctx = { taint: "none" as const };
let n = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${(n += 1)}`;

async function addContact(first: string, last: string, email: string, extra: { account?: string; title?: string } = {}): Promise<string> {
  const fields = await contactEmailFields(email);
  if (!fields) throw new Error("fixture address did not normalize");
  const id = uid("ct");
  await db
    .prepare("INSERT INTO contacts (id, first_name, last_name, email, email_sha256, mailbox_sha256, account_key, job_title) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
    .bind(id, first, last, fields.email, fields.email_sha256, fields.mailbox_sha256, extra.account ?? null, extra.title ?? null)
    .run();
  return id;
}

describe("contacts_search", () => {
  const search = createContactsSearchHandler({ db });

  it("finds contacts by surname, address, account or title", async () => {
    const tag = uid("q").toLowerCase();
    await addContact("Jane", `Okafor${tag}`, `jane.${tag}@acme.example`, { account: "acme.example", title: "VP Engineering" });
    const out = await search({ query: `okafor${tag}` }, ctx);
    expect(out).toContain(`Jane Okafor${tag} <jane.${tag}@acme.example>`);
    expect(out).toContain("account acme.example, title VP Engineering, warmth cold");
    expect(await search({ query: `jane.${tag}@acme` }, ctx)).toContain("1 contact(s)");
  });

  it("treats LIKE wildcards in the query as literal text", async () => {
    expect(await search({ query: "%%" }, ctx)).toMatch(/No contacts match/);
    expect(await search({ query: "__" }, ctx)).toMatch(/No contacts match/);
  });

  it("returns at most twenty rows and refuses queries that are too short or too long", async () => {
    const tag = uid("bulk").toLowerCase();
    for (let i = 0; i < CONTACTS_SEARCH_MAX_ROWS + 3; i++) await addContact("Sam", `Rivera${tag}`, `sam${i}.${tag}@globex.example`);
    const out = text(await search({ query: `rivera${tag}`, limit: 500 }, ctx));
    expect(out.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(CONTACTS_SEARCH_MAX_ROWS);
    await expect(search({ query: "a" }, ctx)).rejects.toThrow(/at least two/);
    await expect(search({ query: "x".repeat(101) }, ctx)).rejects.toThrow(/at most/);
  });
});

describe("drafts_create", () => {
  function handler(created: CreatedDraft[] = []) {
    return createDraftsCreateHandler({ db, onCreated: (d) => created.push(d) });
  }

  it("inserts a pending_approval draft with the normalized recipient and links an existing contact", async () => {
    const tag = uid("d").toLowerCase();
    const contactId = await addContact("Jane", "Okafor", `jane.${tag}@acme.example`);
    const created: CreatedDraft[] = [];
    const out = await handler(created)({ recipient_email: `Jane Okafor <JANE.${tag}@Acme.Example>`, subject: "Faster CI at Acme", body: "Hi Jane,\r\nsetup takes under an hour." }, ctx);
    expect(created).toHaveLength(1);
    expect(out).toContain("has not been sent");
    const row = await db.prepare("SELECT * FROM drafts WHERE id = ?1").bind(created[0]?.id).first<Record<string, unknown>>();
    expect(row).toMatchObject({ status: "pending_approval", recipient_email: `jane.${tag}@acme.example`, contact_id: contactId, kind: "warm_intro", body: "Hi Jane,\nsetup takes under an hour.", approved_digest: null });
  });

  it("skips rather than guesses: a recipient that does not normalize is refused and nothing is written", async () => {
    const created: CreatedDraft[] = [];
    for (const recipient_email of ["jane at acme", "jane@acme.example, ops@acme.example", "Jane <jane@acme.example>\nBcc: x@evil.example", ""]) {
      await expect(handler(created)({ recipient_email, subject: "s", body: "b" }, ctx), recipient_email).rejects.toThrow();
    }
    expect(created).toEqual([]);
  });

  it("refuses a multi-line subject, an oversized body and a cold sequence kind", async () => {
    const h = handler();
    await expect(h({ recipient_email: "a@acme.example", subject: "one\ntwo", body: "b" }, ctx)).rejects.toThrow(/one line/);
    await expect(h({ recipient_email: "a@acme.example", subject: "s", body: "x".repeat(DRAFT_BODY_MAX_CHARS + 1) }, ctx)).rejects.toThrow(/body/);
    await expect(h({ recipient_email: "a@acme.example", subject: "s", body: "b", kind: "cold_intro" }, ctx)).rejects.toThrow(/kind/);
  });

  it("removes zero-width and bidirectional controls, so the preview shows the bytes the digest binds", async () => {
    const created: CreatedDraft[] = [];
    const hidden = String.fromCharCode(0x202e) + String.fromCharCode(0x200b);
    await handler(created)({ recipient_email: "c@acme.example", subject: `Hi${hidden}`, body: `Plain${hidden} text.` }, ctx);
    expect(await db.prepare("SELECT subject, body FROM drafts WHERE id = ?1").bind(created[0]?.id).first()).toEqual({ subject: "Hi", body: "Plain text." });
  });

  it("replaces long dashes in model-written copy with commas", async () => {
    const created: CreatedDraft[] = [];
    const dash = String.fromCharCode(0x2014);
    await handler(created)({ recipient_email: "b@acme.example", subject: `Setup ${dash} fast`, body: `One hour${dash}not a week.` }, ctx);
    const row = await db.prepare("SELECT subject, body FROM drafts WHERE id = ?1").bind(created[0]?.id).first();
    expect(row).toEqual({ subject: "Setup, fast", body: "One hour, not a week." });
  });

  it("through the dispatcher, is refused at full taint before its handler runs", async () => {
    const created: CreatedDraft[] = [];
    const session = { taint: "full" as const };
    const result = await executeToolCall({ registry: createToolRegistry(), handlers: { drafts_create: handler(created) } }, session, {
      name: "drafts_create",
      input: { recipient_email: "jane@acme.example", subject: "s", body: "b" },
    });
    expect(result).toMatchObject({ status: "blocked", code: "tainted" });
    expect(created).toEqual([]);
  });

  it("through the dispatcher, is allowed after a contact lookup (metadata taint)", async () => {
    const created: CreatedDraft[] = [];
    const session = { taint: "metadata" as const };
    const result = await executeToolCall({ registry: createToolRegistry(), handlers: { drafts_create: handler(created) } }, session, {
      name: "drafts_create",
      input: { recipient_email: "jane@acme.example", subject: "Hello", body: "Short note." },
    });
    expect(result.status).toBe("ok");
    expect(created).toHaveLength(1);
  });
});
