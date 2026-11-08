// GTM-agents: suppression is keyed by address hash, blocks unparseable addresses, and fails closed.
import { contactEmailFields, eraseContact } from "@gtm-agents/core/data";
import { addSuppression, addressHash, checkSendGates, checkSuppression, normalizeAddress } from "@gtm-agents/core/sending";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MemoryKv, failingDb, uid } from "./helpers.ts";

const address = (name: string) => `${name}@prospect.example`;

describe("address normalization", () => {
  it("lowercases plain addresses and strips display names", () => {
    expect(normalizeAddress("Jane.Doe@Prospect.Example")).toBe("jane.doe@prospect.example");
    expect(normalizeAddress('"Doe, Jane" <Jane.Doe@prospect.example>')).toBe("jane.doe@prospect.example");
    expect(normalizeAddress("Jane <jane+news@prospect.example> ")).toBe("jane+news@prospect.example");
    expect(normalizeAddress('"Doe; <Jane>" <jane@prospect.example>')).toBe("jane@prospect.example");
  });

  it("refuses anything that is not exactly one plain address", () => {
    const bad = [
      "<victim@prospect.example>, Bob <bob@other.example>",
      "Bob\r\nBcc: <victim@prospect.example>\r\nX: <bob@other.example>",
      "victim@prospect.example <bob@other.example>",
      "Bob; Eve <bob@other.example>",
      'Bob "unterminated <bob@other.example>',
      "",
      "jane",
      "jane@",
      "@prospect.example",
      "jane@prospect",
      "a@b@prospect.example",
      "jane doe@prospect.example",
      "a@one.example, b@two.example",
      "jane@prospect.example\r\nBcc: other@two.example",
      ".jane@prospect.example",
      "ja..ne@prospect.example",
      `j${String.fromCodePoint(0xe9)}@prospect.example`,
      "jane@-prospect.example",
      42,
      null,
    ];
    for (const value of bad) expect(normalizeAddress(value), String(value)).toBeNull();
  });
});

describe("the suppression list", () => {
  it("blocks a suppressed address in any spelling, and only that address", async () => {
    const name = uid("optout");
    expect(await addSuppression(env.DB, { email: address(name), reason: "opt_out", source: "reply" })).toMatchObject({ added: true });
    const result = await checkSuppression(env.DB, [`Someone <${address(name).toUpperCase()}>`, address(uid("other"))]);
    expect(result.ok).toBe(false);
    expect(result.blocked).toEqual([{ recipient: `Someone <${address(name).toUpperCase()}>`, reason: "opt_out" }]);
  });

  it("treats subaddresses as the same mailbox, in both directions", async () => {
    const base = uid("sub");
    await addSuppression(env.DB, { email: `${base}+news@prospect.example`, reason: "opt_out" });
    for (const variant of [`${base}@prospect.example`, `${base}+other@prospect.example`, `${base}+news@prospect.example`]) {
      expect((await checkSuppression(env.DB, [variant])).ok, variant).toBe(false);
    }
    const plain = uid("plain");
    await addSuppression(env.DB, { email: `${plain}@prospect.example`, reason: "bounce" });
    expect((await checkSuppression(env.DB, [`${plain}+tag@prospect.example`])).blocked).toEqual([{ recipient: `${plain}+tag@prospect.example`, reason: "bounce" }]);
  });

  it("blocks a contact marked opted_out even without a list entry, in every subaddress", async () => {
    const base = uid("optedout");
    const fields = await contactEmailFields(`${base}+work@prospect.example`);
    if (!fields) throw new Error("fixture address did not normalize");
    await env.DB.prepare("INSERT INTO contacts (id, email, email_sha256, mailbox_sha256, warmth) VALUES (?1, ?2, ?3, ?4, 'opted_out')")
      .bind(uid("contact"), fields.email, fields.email_sha256, fields.mailbox_sha256)
      .run();
    for (const variant of [`${base}+work@prospect.example`, `${base}@prospect.example`, `${base}+other@prospect.example`]) {
      expect((await checkSuppression(env.DB, [variant])).blocked, variant).toEqual([{ recipient: variant, reason: "opt_out" }]);
    }
  });

  async function insertContact(address: string, warmth = "cold"): Promise<string> {
    const fields = await contactEmailFields(address);
    if (!fields) throw new Error("fixture address did not normalize");
    const id = uid("contact");
    await env.DB.prepare("INSERT INTO contacts (id, email, email_sha256, mailbox_sha256, warmth) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(id, fields.email, fields.email_sha256, fields.mailbox_sha256, warmth)
      .run();
    return id;
  }

  it("does not block a contact who has not opted out", async () => {
    const fine = address(uid("cold"));
    await insertContact(fine, "engaged");
    expect(await checkSuppression(env.DB, [fine])).toMatchObject({ ok: true, blocked: [] });
  });

  it("blocks a contact whose lifecycle state is opted_out or deleted", async () => {
    for (const state of ["opted_out", "deleted"]) {
      const base = uid(`lifecycle_${state}`);
      const id = await insertContact(`${base}+x@prospect.example`, "contacted");
      await env.DB.prepare("INSERT INTO contact_lifecycle (contact_id, state) VALUES (?1, ?2)").bind(id, state).run();
      for (const variant of [`${base}+x@prospect.example`, `${base}@prospect.example`]) {
        expect((await checkSuppression(env.DB, [variant])).ok, `${state} ${variant}`).toBe(false);
      }
    }
  });

  it("blocks every subaddress of a person erased by address", async () => {
    const base = uid("erased_sub");
    await eraseContact(env.DB, `${base}+app@prospect.example`, { source: "product" });
    for (const variant of [`${base}+app@prospect.example`, `${base}@prospect.example`, `${base}+other@prospect.example`]) {
      expect((await checkSuppression(env.DB, [variant])).blocked, variant).toEqual([{ recipient: variant, reason: "erasure" }]);
    }
  });

  it("blocks anyone with an erasure tombstone", async () => {
    const erased = address(uid("tombstoned"));
    await env.DB.prepare("INSERT INTO erasure_tombstones (email_sha256, source, erased_at) VALUES (?1, 'product', '2026-11-04T00:00:00.000Z')")
      .bind(await addressHash(normalizeAddress(erased) ?? ""))
      .run();
    expect((await checkSuppression(env.DB, [erased])).blocked).toEqual([{ recipient: erased, reason: "erasure" }]);
  });

  it("keeps an erased person suppressed without keeping their address", async () => {
    const erased = address(uid("erased"));
    const hash = await addressHash(normalizeAddress(erased) ?? "");
    await addSuppression(env.DB, { emailSha256: hash, reason: "erasure", source: "erasure-request" });
    const row = await env.DB.prepare("SELECT email, reason FROM suppression WHERE email_sha256 = ?1").bind(hash).first<{ email: string | null; reason: string }>();
    expect(row).toEqual({ email: null, reason: "erasure" });
    expect((await checkSuppression(env.DB, [erased])).blocked).toEqual([{ recipient: erased, reason: "erasure" }]);
  });

  it("is idempotent and keeps the first reason", async () => {
    const email = address(uid("bounced"));
    expect((await addSuppression(env.DB, { email, reason: "bounce" })).added).toBe(true);
    expect((await addSuppression(env.DB, { email, reason: "manual" })).added).toBe(false);
    expect((await checkSuppression(env.DB, [email])).blocked[0]?.reason).toBe("bounce");
  });

  it("blocks recipients it cannot parse", async () => {
    const fine = address(uid("fine"));
    const result = await checkSuppression(env.DB, ["not an address", fine]);
    expect(result).toEqual({ ok: false, blocked: [{ recipient: "not an address", reason: "unparseable" }], allowed: [fine] });
  });

  it("fails closed: a database error blocks every recipient", async () => {
    const list = [address(uid("a")), address(uid("b"))];
    expect(await checkSuppression(failingDb(), list)).toEqual({ ok: false, blocked: list.map((recipient) => ({ recipient, reason: "check_failed" })), allowed: [] });
  });

  it("checks large batches in chunks", async () => {
    const list = Array.from({ length: 150 }, (_, i) => address(uid(`bulk${i}`)));
    await addSuppression(env.DB, { email: list[120] ?? "", reason: "complaint" });
    expect((await checkSuppression(env.DB, list)).blocked).toEqual([{ recipient: list[120], reason: "complaint" }]);
  });

  it("refuses invalid entries instead of storing them", async () => {
    await expect(addSuppression(env.DB, { email: "nobody", reason: "manual" })).rejects.toThrow(TypeError);
    await expect(addSuppression(env.DB, { email: address(uid("x")), reason: "whatever" as never })).rejects.toThrow(TypeError);
    await expect(addSuppression(env.DB, { emailSha256: "ABC", reason: "manual" })).rejects.toThrow(TypeError);
    await expect(addSuppression(failingDb(), { email: address(uid("x")), reason: "manual" })).rejects.toThrow();
  });

  it("hands the send path only normalized addresses, never the raw strings", async () => {
    const name = uid("clean");
    const result = await checkSendGates({ kv: new MemoryKv(), db: env.DB }, { path: "reply", recipients: [`Jane <${name.toUpperCase()}@Prospect.Example>`, `${name}@prospect.example`] });
    expect(result).toEqual({ ok: true, recipients: [`${name}@prospect.example`] });
    const victim = address(uid("victim"));
    await addSuppression(env.DB, { email: victim, reason: "opt_out" });
    const smuggled = await checkSendGates({ kv: new MemoryKv(), db: env.DB }, { path: "cold", recipients: [`<${victim}>, Bob <bob@other.example>`] });
    expect(smuggled).toMatchObject({ ok: false, reason: "suppressed" });
  });

  it("is checked by the send gates for every path", async () => {
    const email = address(uid("gated"));
    await addSuppression(env.DB, { email, reason: "opt_out" });
    for (const path of ["cold", "reply", "lifecycle"] as const) {
      const result = await checkSendGates({ kv: new MemoryKv(), db: env.DB }, { path, recipients: [email] });
      expect(result, path).toMatchObject({ ok: false, reason: "suppressed" });
      if (!result.ok) expect(result.message.startsWith("[SEND BLOCKED:suppressed]")).toBe(true);
    }
    expect(await checkSendGates({ kv: new MemoryKv(), db: failingDb() }, { path: "reply", recipients: [address(uid("y"))] })).toMatchObject({ ok: false, reason: "suppressed" });
  });
});
