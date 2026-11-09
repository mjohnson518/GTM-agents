// GTM-agents: the SDK reproduces every test vector in docs/EVENT-CONTRACT.md, and the agent's own
// signer and verifier agree with it byte for byte, so the host side and the agent side cannot drift
// from the published contract or from each other.
import { describe, expect, it } from "vitest";
import { pushSignatureValid, readSignatureHeaders } from "../../packages/core/src/product-bridge/signature.ts";
import { emailSha256, readCanonical, signPush, signRead, sortedQuery, userDeleted, verifyReadSignature } from "../../packages/sdk/src/index.ts";

const WEBHOOK_SECRET = "test-secret-do-not-use";
const READ_SECRET = "test-read-secret-do-not-use";

const pushBody =
  '{"id":"evt_01J9ZK3Q8R5T7V2W4X6Y8Z0A1B","version":1,"type":"user.signed_up","occurred_at":"2026-03-01T12:00:00Z","user":{"id":"usr_7f3a","email":"ada@acme.example","name":"Ada Lovelace","role":"owner"},"org":{"id":"acc_19c2","name":"Acme","domain":"acme.example","plan_tier":"free"},"ref":"ref_q1launch","data":{"plan":"free","source":"google"}}';
const pushSignature = "sha256=6c2586c78f28c1b314a9769809173887cdc8a5822fb0239baf948fd84aca0a19";

const erasureBody =
  '{"id":"evt_01J9ZK4D2E6F8G0H2J4K6M8N0P","version":1,"type":"user.deleted","occurred_at":"2026-03-02T09:30:00Z","user":{"id":"usr_7f3a","email_sha256":"2a1322415fff1b1aceaebe7855b2c5bd6e9efa5e787d46391f971aea65062ce3"},"org":null,"ref":null,"data":{}}';
const erasureSignature = "sha256=8e8880eb7971dcfaa9d3682c40b57e661ad7eafd41d7d146451dc5e370363272";

const readUrl = "https://app.acme.example/api/internal/gtm/users?since=2026-03-01T00%3A00%3A00Z&limit=200";
const readTimestamp = 1772366400;
const readCanonicalString = "GET\n/api/internal/gtm/users\nlimit=200&since=2026-03-01T00%3A00%3A00Z\n1772366400";
const readSignature = "sha256=4e1acd1ab4d0f676df2045bdf5767b49afc849de516b3b3b4dd91898d3aeac7a";

describe("the SDK and the published vectors", () => {
  it("signs the push and erasure examples over their exact bytes", async () => {
    expect(await signPush(pushBody, WEBHOOK_SECRET)).toBe(pushSignature);
    expect(await signPush(erasureBody, WEBHOOK_SECRET)).toBe(erasureSignature);
  });

  it("hashes the erased address lowercased and trimmed, and never puts the address in the event", async () => {
    expect(await emailSha256("  Ada@Acme.example ")).toBe("2a1322415fff1b1aceaebe7855b2c5bd6e9efa5e787d46391f971aea65062ce3");
    const event = await userDeleted({ userId: "usr_7f3a", email: "Ada@Acme.example", id: "evt_01J9ZK4D2E6F8G0H2J4K6M8N0P", occurredAt: "2026-03-02T09:30:00Z" });
    expect(event.user).toEqual({ id: "usr_7f3a", email_sha256: "2a1322415fff1b1aceaebe7855b2c5bd6e9efa5e787d46391f971aea65062ce3" });
    expect(JSON.stringify(event)).not.toContain("acme.example");
  });

  it("builds the read's canonical string with sorted keys and values as sent, and signs it", async () => {
    expect(sortedQuery("?since=2026-03-01T00%3A00%3A00Z&limit=200")).toBe("limit=200&since=2026-03-01T00%3A00%3A00Z");
    expect(readCanonical("GET", readUrl, readTimestamp)).toBe(readCanonicalString);
    const headers = await signRead({ secret: READ_SECRET, method: "GET", url: readUrl, timestamp: readTimestamp });
    expect(headers).toEqual({ "X-Timestamp": String(readTimestamp), "X-Signature": readSignature });
  });

  it("verifies the read vector inside the 5-minute window and refuses it outside, tampered or unsigned", async () => {
    const at = (seconds: number) => new Date(seconds * 1000);
    const base = { secret: READ_SECRET, method: "GET", url: readUrl, timestamp: String(readTimestamp), signature: readSignature };
    expect(await verifyReadSignature({ ...base, now: at(readTimestamp + 299) })).toEqual({ ok: true });
    expect(await verifyReadSignature({ ...base, now: at(readTimestamp - 299) })).toEqual({ ok: true });
    expect(await verifyReadSignature({ ...base, now: at(readTimestamp + 301) })).toEqual({ ok: false, reason: "stale" });
    expect(await verifyReadSignature({ ...base, url: readUrl.replace("limit=200", "limit=201"), now: at(readTimestamp) })).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verifyReadSignature({ ...base, method: "POST", now: at(readTimestamp) })).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verifyReadSignature({ ...base, signature: null, now: at(readTimestamp) })).toEqual({ ok: false, reason: "missing" });
    expect(await verifyReadSignature({ ...base, secret: "", now: at(readTimestamp) })).toEqual({ ok: false, reason: "not_configured" });
    expect(await verifyReadSignature({ ...base, secret: "another-secret", now: at(readTimestamp) })).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("the agent's side of the same vectors", () => {
  it("accepts the push and erasure signatures and refuses one byte of difference", async () => {
    expect(await pushSignatureValid(pushBody, pushSignature, WEBHOOK_SECRET)).toBe(true);
    expect(await pushSignatureValid(erasureBody, erasureSignature, WEBHOOK_SECRET)).toBe(true);
    expect(await pushSignatureValid(`${pushBody} `, pushSignature, WEBHOOK_SECRET)).toBe(false);
    expect(await pushSignatureValid(pushBody, pushSignature.replace("sha256=", ""), WEBHOOK_SECRET)).toBe(false);
    expect(await pushSignatureValid(pushBody, pushSignature, "")).toBe(false);
  });

  it("signs a read exactly as the SDK verifies it", async () => {
    const headers = await readSignatureHeaders({ secret: READ_SECRET, method: "GET", url: new URL(readUrl), timestamp: readTimestamp });
    expect(headers).toEqual({ "X-Timestamp": String(readTimestamp), "X-Signature": readSignature });
  });
});
