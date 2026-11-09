// GTM-agents: the dashboard's /ws upgrade admits only a valid Cloudflare Access token for an
// allowlisted email, and refuses everything else before the Durable Object is reached. Keys are
// generated at runtime; every address is invented.
import { AccessKeyCache, KEY_REFETCH_MS, NOT_ALLOWED_CLOSE, admitUpgrade, certsUrl, verifyAccessToken, type AdminConfig } from "@gtm-agents/core/gateway";
import { replyTestConfig } from "@gtm-agents/core/replies/testing";
import { describe, expect, it } from "vitest";
import { MemoryKv } from "./helpers.ts";

const TEAM = "acme.cloudflareaccess.com";
const AUD = "a".repeat(64);
const admin: AdminConfig = { accessTeamDomain: TEAM, accessAud: AUD, allowedEmails: ["ops@acme.example"], allowedOrigins: [] };
const NOW = new Date("2026-11-04T17:00:00.000Z");
const nowS = Math.floor(NOW.getTime() / 1000);

const b64url = (bytes: Uint8Array | string): string => {
  const raw = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

interface Signer {
  kid: string;
  jwk: JsonWebKey;
  sign(payload: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
}

async function signer(kid: string): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    kid,
    jwk: { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", use: "sig", kid } as JsonWebKey,
    async sign(payload, header = { alg: "RS256", kid, typ: "JWT" }) {
      const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
      const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input)));
      return `${input}.${b64url(sig)}`;
    },
  };
}

function certs(signers: Signer[]): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fake = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url !== certsUrl(TEAM)) return new Response("not found", { status: 404 });
    return Response.json({ keys: signers.map((s) => s.jwk) });
  }) as typeof fetch;
  return { fetch: fake, calls };
}

const claims = (over: Record<string, unknown> = {}) => ({ iss: `https://${TEAM}`, aud: [AUD], email: "ops@acme.example", sub: "user-1", iat: nowS - 10, nbf: nowS - 10, exp: nowS + 3600, type: "app", ...over });

const key = await signer("kid-1");

const reasonOf = (r: { ok: boolean; reason?: string }): string => (r.ok ? "" : (r.reason ?? ""));

async function verify(token: string, signers: Signer[] = [key]) {
  const { fetch } = certs(signers);
  return verifyAccessToken(token, admin, { fetch, now: () => NOW, cache: new AccessKeyCache() });
}

describe("Access token verification", () => {
  it("admits a valid token for an allowlisted email, case-insensitively", async () => {
    const result = await verify(await key.sign(claims({ email: "Ops@Acme.example" })));
    expect(result).toMatchObject({ ok: true, identity: { email: "ops@acme.example", sub: "user-1" } });
  });

  it("refuses an expired token", async () => {
    expect((await verify(await key.sign(claims({ exp: nowS - 120 })))).ok).toBe(false);
  });

  it("refuses a token for another Access application", async () => {
    expect(reasonOf(await verify(await key.sign(claims({ aud: ["b".repeat(64)] }))))).toContain("another Access application");
  });

  it("refuses a token from another team", async () => {
    expect(reasonOf(await verify(await key.sign(claims({ iss: "https://globex.cloudflareaccess.com" }))))).toContain("another team");
  });

  it("refuses a token that is not valid yet", async () => {
    expect((await verify(await key.sign(claims({ nbf: nowS + 600 })))).ok).toBe(false);
  });

  it("refuses a token signed with a key the team does not publish", async () => {
    const stranger = await signer("kid-unknown");
    expect(reasonOf(await verify(await stranger.sign(claims())))).toContain("does not publish");
  });

  it("refuses a valid token for an email that is not allowlisted", async () => {
    expect(reasonOf(await verify(await key.sign(claims({ email: "intruder@globex.example" }))))).toContain("allowedEmails");
  });

  it("refuses a service token (no email), alg none, HS256 and a tampered payload", async () => {
    const noEmail = claims();
    delete (noEmail as Record<string, unknown>).email;
    expect((await verify(await key.sign(noEmail))).ok).toBe(false);
    expect((await verify(await key.sign(claims(), { alg: "none", kid: "kid-1" }))).ok).toBe(false);
    expect((await verify(await key.sign(claims(), { alg: "HS256", kid: "kid-1" }))).ok).toBe(false);
    const [h, , s] = (await key.sign(claims())).split(".");
    const forged = `${h}.${b64url(JSON.stringify(claims({ email: "ops@acme.example", exp: nowS + 999_999 })))}.${s}`;
    expect((await verify(forged)).ok).toBe(false);
    expect((await verify("")).ok).toBe(false);
    expect((await verify("a.b")).ok).toBe(false);
  });

  it("fetches the keys again on an unknown key id, but not more than once per interval", async () => {
    const rotated = await signer("kid-2");
    const cache = new AccessKeyCache();
    const first = certs([key]);
    expect((await verifyAccessToken(await key.sign(claims()), admin, { fetch: first.fetch, now: () => NOW, cache })).ok).toBe(true);
    // Access rotated its key later: the new kid is unknown, so the keys are fetched again, once.
    const later = new Date(NOW.getTime() + KEY_REFETCH_MS + 1000);
    const second = certs([key, rotated]);
    const flood = await Promise.all([1, 2, 3].map(async () => verifyAccessToken(await rotated.sign(claims()), admin, { fetch: second.fetch, now: () => later, cache })));
    expect(flood.every((r) => r.ok)).toBe(true);
    expect(second.calls.length).toBe(1);
    // Made-up key ids right after do not fetch again.
    const bogus = await signer("kid-bogus");
    for (let i = 0; i < 5; i++) expect((await verifyAccessToken(await bogus.sign(claims()), admin, { fetch: second.fetch, now: () => later, cache })).ok).toBe(false);
    expect(second.calls.length).toBe(1);
  });

  it("fails closed when the certs cannot be fetched", async () => {
    const down = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
    expect((await verifyAccessToken(await key.sign(claims()), admin, { fetch: down, now: () => NOW, cache: new AccessKeyCache() })).ok).toBe(false);
  });
});

describe("the /ws upgrade", () => {
  const config = replyTestConfig({ admin });
  const upgrade = (headers: Record<string, string>) => new Request("https://agent.acme.example/ws", { headers: { Upgrade: "websocket", Origin: "https://agent.acme.example", ...headers } });

  it("answers 503 with no admin config, whatever the token", async () => {
    const kv = new MemoryKv();
    kv.map.set("admin:enabled", "true");
    const result = await admitUpgrade(upgrade({ "Cf-Access-Jwt-Assertion": await key.sign(claims()) }), { KV: kv as unknown as KVNamespace }, replyTestConfig(), { fetch: certs([key]).fetch, now: () => NOW, cache: new AccessKeyCache() });
    expect(result.ok ? 200 : result.response.status).toBe(503);
  });

  it("answers 503 while admin:enabled is off or unreadable", async () => {
    const off = await admitUpgrade(upgrade({}), { KV: new MemoryKv() as unknown as KVNamespace }, config);
    expect(off.ok ? 200 : off.response.status).toBe(503);
    const broken = new MemoryKv();
    broken.failing = true;
    const unreadable = await admitUpgrade(upgrade({}), { KV: broken as unknown as KVNamespace }, config);
    expect(unreadable.ok ? 200 : unreadable.response.status).toBe(503);
  });

  it("refuses another origin, a missing token and a non-allowlisted email; admits a valid one", async () => {
    const kv = new MemoryKv();
    kv.map.set("admin:enabled", "true");
    const options = { fetch: certs([key]).fetch, now: () => NOW, cache: new AccessKeyCache() };
    const env = { KV: kv as unknown as KVNamespace };
    const status = async (request: Request) => {
      const r = await admitUpgrade(request, env, config, options);
      return r.ok ? 101 : r.response.status;
    };
    const token = await key.sign(claims());
    expect(await status(upgrade({ Origin: "https://evil.example", "Cf-Access-Jwt-Assertion": token }))).toBe(403);
    expect(await status(new Request("https://agent.acme.example/ws", { headers: { Upgrade: "websocket", "Cf-Access-Jwt-Assertion": token } }))).toBe(403);
    expect(await status(upgrade({}))).toBe(403);
    expect(await status(new Request("https://agent.acme.example/ws", { headers: { Origin: "https://agent.acme.example", "Cf-Access-Jwt-Assertion": token } }))).toBe(426);

    // Signed in through Access but not allowlisted: the Worker accepts the upgrade itself and closes
    // it with 4403, so the dashboard can say why; the Durable Object is never reached.
    const intruder = await key.sign(claims({ email: "intruder@globex.example" }));
    const refused = await admitUpgrade(upgrade({ "Cf-Access-Jwt-Assertion": intruder }), env, config, options);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.notAllowed).toBe(true);
    const socket = refused.response.webSocket;
    expect(socket).toBeTruthy();
    const closed = new Promise<number>((resolve) => socket?.addEventListener("close", (e) => resolve(e.code)));
    socket?.accept();
    expect(await closed).toBe(NOT_ALLOWED_CLOSE);
    // Without an upgrade header the same operator gets a plain 403.
    expect(await status(new Request("https://agent.acme.example/ws", { headers: { Origin: "https://agent.acme.example", "Cf-Access-Jwt-Assertion": intruder } }))).toBe(403);
    expect(await status(upgrade({ "Cf-Access-Jwt-Assertion": token }))).toBe(101);
  });
});
