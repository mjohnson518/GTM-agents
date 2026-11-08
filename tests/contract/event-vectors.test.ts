// GTM-agents: the host event contract's published test vectors. Recomputes every signature in
// docs/EVENT-CONTRACT.md and checks that the document still shows the same values, so the
// specification and the reference algorithm cannot drift apart.
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const doc = readFileSync(resolve(import.meta.dirname, "../../docs/EVENT-CONTRACT.md"), "utf8");

const WEBHOOK_SECRET = "test-secret-do-not-use";
const READ_SECRET = "test-read-secret-do-not-use";

const pushBody =
  '{"id":"evt_01J9ZK3Q8R5T7V2W4X6Y8Z0A1B","version":1,"type":"user.signed_up","occurred_at":"2026-03-01T12:00:00Z","user":{"id":"usr_7f3a","email":"ada@acme.example","name":"Ada Lovelace","role":"owner"},"org":{"id":"acc_19c2","name":"Acme","domain":"acme.example","plan_tier":"free"},"ref":"ref_q1launch","data":{"plan":"free","source":"google"}}';

const erasureBody =
  '{"id":"evt_01J9ZK4D2E6F8G0H2J4K6M8N0P","version":1,"type":"user.deleted","occurred_at":"2026-03-02T09:30:00Z","user":{"id":"usr_7f3a","email_sha256":"2a1322415fff1b1aceaebe7855b2c5bd6e9efa5e787d46391f971aea65062ce3"},"org":null,"ref":null,"data":{}}';

const hmacHex = (secret: string, message: string) => createHmac("sha256", secret).update(message).digest("hex");

/** Canonical string for a signed read: METHOD, PATH, query sorted bytewise by key, timestamp. */
function readCanonical(method: string, pathWithQuery: string, timestamp: number): string {
  const [path = "", query = ""] = pathWithQuery.split("?");
  const key = (pair: string) => pair.split("=")[0] ?? "";
  const sortedQuery = query
    .split("&")
    .filter(Boolean)
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
    .join("&");
  return [method, path, sortedQuery, String(timestamp)].join("\n");
}

describe("host event contract test vectors", () => {
  it("signs the push example over its exact raw bytes", () => {
    expect(Buffer.byteLength(pushBody, "utf8")).toBe(344);
    const signature = hmacHex(WEBHOOK_SECRET, pushBody);
    expect(signature).toBe("6c2586c78f28c1b314a9769809173887cdc8a5822fb0239baf948fd84aca0a19");
    expect(doc).toContain(pushBody);
    expect(doc).toContain(`sha256=${signature}`);
  });

  it("hashes the erased address lowercased and trimmed", () => {
    const hash = createHash("sha256").update("  Ada@Acme.example ".trim().toLowerCase()).digest("hex");
    expect(hash).toBe("2a1322415fff1b1aceaebe7855b2c5bd6e9efa5e787d46391f971aea65062ce3");
    expect(erasureBody).toContain(hash);
  });

  it("signs the erasure example", () => {
    const signature = hmacHex(WEBHOOK_SECRET, erasureBody);
    expect(signature).toBe("8e8880eb7971dcfaa9d3682c40b57e661ad7eafd41d7d146451dc5e370363272");
    expect(doc).toContain(erasureBody);
    expect(doc).toContain(`sha256=${signature}`);
  });

  it("signs a reconciliation read over the canonical string with sorted query keys", () => {
    const canonical = readCanonical("GET", "/api/internal/gtm/users?since=2026-03-01T00%3A00%3A00Z&limit=200", 1772366400);
    expect(canonical).toBe("GET\n/api/internal/gtm/users\nlimit=200&since=2026-03-01T00%3A00%3A00Z\n1772366400");
    const signature = hmacHex(READ_SECRET, canonical);
    expect(signature).toBe("4e1acd1ab4d0f676df2045bdf5767b49afc849de516b3b3b4dd91898d3aeac7a");
    expect(doc).toContain(`sha256=${signature}`);
  });
});
