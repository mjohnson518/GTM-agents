// GTM-agents: tests for the sending-domain DNS preflight in `gtm doctor --remote`: the TXT lookup over
// Cloudflare's JSON DNS and the SPF, DKIM and DMARC checks. Every response is recorded and synthetic
// (outreach.acme.example); nothing here reaches the network.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctorCommand } from "../src/commands/doctor.ts";
import { dkimCheck, dmarcCheck, domainSeparationCheck, resolveTxt, spfCheck, type DnsFetch, type TxtLookup } from "../src/lib/dns.ts";
import type { CommandRunner } from "../src/lib/io.ts";
import { ADAPTERS_DIR, makeDeployment } from "./deployment.ts";
import { captureIo } from "./helpers.ts";

const DOMAIN = "outreach.acme.example";

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("DNS tests must not reach the network");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A recorded Cloudflare JSON DNS answer for a TXT query, with these TXT data strings. */
function answer(name: string, data: string[], extra: Array<{ name: string; type: number; data: string }> = []) {
  return {
    Status: 0, TC: false, RD: true, RA: true, AD: false, CD: false,
    Question: [{ name, type: 16 }],
    Answer: [...extra.map((e) => ({ ...e, TTL: 300 })), ...data.map((d) => ({ name, type: 16, TTL: 300, data: d }))],
  };
}

/** A recorded NXDOMAIN answer. */
function nxdomain(name: string) {
  return {
    Status: 3, TC: false, RD: true, RA: true, AD: false, CD: false,
    Question: [{ name, type: 16 }],
    Authority: [{ name: "acme.example", type: 6, TTL: 1800, data: "ns1.acme.example. hostmaster.acme.example. 1 10000 2400 604800 1800" }],
  };
}

type Recorded = Record<string, unknown> | "network" | number;

/** A fetch that answers from recorded responses by query name, and records each request. */
function recordedFetch(responses: Record<string, Recorded>): DnsFetch & { requests: Array<{ url: string; headers: Record<string, string> }> } {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const fn = (async (url: string, init: { headers: Record<string, string> }) => {
    requests.push({ url, headers: init.headers });
    const name = new URL(url).searchParams.get("name") ?? "";
    const r = responses[name] ?? nxdomain(name);
    if (r === "network") throw new TypeError("fetch failed");
    if (typeof r === "number") return { ok: false, status: r, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => r };
  }) as DnsFetch & { requests: typeof requests };
  fn.requests = requests;
  return fn;
}

const SPF = '"v=spf1 include:_spf.mail.example -all"';
const DMARC_REJECT = '"v=DMARC1; p=reject; rua=mailto:dmarc@acme.example"';

/** A Wrangler runner for --remote: every secret is set and every stop flag is unset. */
const remoteRunner: CommandRunner = async (_cmd, args) => {
  if (args.includes("secret")) {
    const names = ["GATEWAY_TOKEN", "UNSUBSCRIBE_SIGNING_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "ANTHROPIC_API_KEY", "EXA_API_KEY", "HUNTER_API_KEY", "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN", "GOOGLE_CALENDAR_REFRESH_TOKEN", "STRIPE_WEBHOOK_SECRET", "STRIPE_SECRET_KEY"];
    return { code: 0, stdout: JSON.stringify(names.map((name) => ({ name }))), stderr: "" };
  }
  const keys = JSON.parse(readFileSync(args[args.indexOf("get") + 1] ?? "", "utf8")) as string[];
  return { code: 0, stdout: JSON.stringify(Object.fromEntries(keys.map((k) => [k, null]))), stderr: "" };
};

async function doctorRemote(fetch: DnsFetch): Promise<{ code: number; text: string }> {
  const io = captureIo();
  const code = await doctorCommand(["--config", "apps/worker", "--remote"], io, { runner: remoteRunner, fetch });
  return { code, text: io.text() };
}

describe("gtm doctor DNS preflight", () => {
  it("reports FAIL when the sending domain has no DMARC record, WARN when DMARC is p=none, and WARN (not PASS) when DNS cannot be reached", async () => {
    const missing = await doctorRemote(recordedFetch({ [DOMAIN]: answer(DOMAIN, [SPF]) }));
    expect(missing.code).toBe(1);
    expect(missing.text).toMatch(/FAIL\s+DMARC\s+no DMARC record at _dmarc\.outreach\.acme\.example/);
    expect(missing.text).toMatch(/PASS\s+SPF/);

    const none = await doctorRemote(recordedFetch({
      [DOMAIN]: answer(DOMAIN, [SPF]),
      [`_dmarc.${DOMAIN}`]: answer(`_dmarc.${DOMAIN}`, ['"v=DMARC1; p=none; rua=mailto:dmarc@acme.example"']),
    }));
    expect(none.code).toBe(0);
    expect(none.text).toMatch(/WARN\s+DMARC\s+.*p=none/);

    const offline = await doctorRemote(recordedFetch({ [DOMAIN]: "network", [`_dmarc.${DOMAIN}`]: "network" }));
    expect(offline.code).toBe(0);
    expect(offline.text).toMatch(/WARN\s+SPF\s+could not resolve/);
    expect(offline.text).toMatch(/WARN\s+DMARC\s+could not resolve/);
    expect(offline.text).not.toMatch(/PASS\s+(SPF|DMARC)/);
    expect(offline.text).not.toMatch(/FAIL\s+(SPF|DMARC)/);
  });

  it("passes SPF and DMARC p=reject, and asks for a selector instead of guessing one for DKIM", async () => {
    const fetch = recordedFetch({ [DOMAIN]: answer(DOMAIN, [SPF]), [`_dmarc.${DOMAIN}`]: answer(`_dmarc.${DOMAIN}`, [DMARC_REJECT]) });
    const { code, text } = await doctorRemote(fetch);
    expect(code).toBe(0);
    expect(text).toMatch(/PASS\s+SPF/);
    expect(text).toMatch(/PASS\s+DMARC\s+.*p=reject/);
    expect(text).toMatch(/INFO\s+DKIM\s+set sending\.dkimSelector/);
    expect(text).toMatch(/INFO\s+sending domain\s+cold mail goes from outreach\.acme\.example, a subdomain of acme\.example/);
    expect(fetch.requests.map((r) => new URL(r.url).searchParams.get("name")).sort()).toEqual([`_dmarc.${DOMAIN}`, DOMAIN]);
    expect(fetch.requests.every((r) => r.url.startsWith("https://cloudflare-dns.com/dns-query?") && new URL(r.url).searchParams.get("type") === "TXT")).toBe(true);
    expect(fetch.requests[0]?.headers.Accept).toBe("application/dns-json");
  });

  it("checks DKIM at <selector>._domainkey.<domain> once sending.dkimSelector is set", async () => {
    const dir = makeDeployment();
    const path = join(dir, "gtm.config.ts");
    writeFileSync(path, readFileSync(path, "utf8").replace("sending: {", `sending: { domain: "${DOMAIN}", dkimSelector: "s1",`));
    const runner: CommandRunner = async (cmd, args, options) => (args.includes("secret") ? { code: 0, stdout: "[]", stderr: "" } : remoteRunner(cmd, args, options));
    const key = `s1._domainkey.${DOMAIN}`;
    const io = captureIo(dir);
    await doctorCommand(["--remote"], io, { runner, adaptersDir: ADAPTERS_DIR, fetch: recordedFetch({ [key]: answer(key, ['"v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3"']) }) });
    expect(io.text()).toMatch(/PASS\s+DKIM\s+s1\._domainkey\.outreach\.acme\.example publishes a key/);
    const missing = captureIo(dir);
    await doctorCommand(["--remote"], missing, { runner, adaptersDir: ADAPTERS_DIR, fetch: recordedFetch({}) });
    expect(missing.text()).toMatch(/FAIL\s+DKIM\s+no DKIM key at s1\._domainkey\.outreach\.acme\.example/);
  });

  it("does not resolve DNS without --remote", async () => {
    const fetch = recordedFetch({});
    const io = captureIo();
    await doctorCommand(["--config", "apps/worker"], io, { runner: async () => ({ code: 1, stdout: "", stderr: "not expected" }), fetch });
    expect(fetch.requests).toEqual([]);
    expect(io.text()).toMatch(/INFO\s+DNS\s+.*pass --remote/);
  });
});

describe("resolveTxt", () => {
  it("keeps TXT answers only, joins split segments and strips quotes", async () => {
    const key = `s1._domainkey.${DOMAIN}`;
    const fetch = recordedFetch({
      [key]: answer(key, ['"v=DKIM1; k=rsa; p=MIIBIjANBgkqh" "kiG9w0BAQEFAAOCAQ8AMIIBCgKC"'], [{ name: key, type: 5, data: "s1.dkim.mail.example." }]),
    });
    expect(await resolveTxt(key, fetch)).toEqual({ ok: true, records: ["v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC"] });
  });

  it("unescapes quotes inside a segment", async () => {
    const fetch = recordedFetch({ [DOMAIN]: answer(DOMAIN, ['"say \\"hi\\""']) });
    expect(await resolveTxt(DOMAIN, fetch)).toEqual({ ok: true, records: ['say "hi"'] });
  });

  it("treats a non-zero Status as no records, and a network error or non-200 answer as unreadable", async () => {
    expect(await resolveTxt(DOMAIN, recordedFetch({}))).toEqual({ ok: true, records: [] });
    expect(await resolveTxt(DOMAIN, recordedFetch({ [DOMAIN]: { Status: 2, Question: [] } }))).toEqual({ ok: true, records: [] });
    expect(await resolveTxt(DOMAIN, recordedFetch({ [DOMAIN]: "network" }))).toMatchObject({ ok: false });
    expect(await resolveTxt(DOMAIN, recordedFetch({ [DOMAIN]: 503 }))).toEqual({ ok: false, error: "DNS over HTTPS answered 503" });
    expect(await resolveTxt(DOMAIN, recordedFetch({ [DOMAIN]: { Answer: "nonsense" } }))).toMatchObject({ ok: false });
  });
});

const found = (...records: string[]): TxtLookup => ({ ok: true, records });

/** Assert a check's status and that its detail mentions `text`. */
function expectCheck(check: { status: string; detail: string }, status: string, text: string): void {
  expect(check.status).toBe(status);
  expect(check.detail).toContain(text);
}
const unreadable: TxtLookup = { ok: false, error: "fetch failed" };

describe("SPF, DMARC and DKIM checks", () => {
  it("SPF: one record PASS, none or several FAIL, +all FAIL, ?all WARN, unreadable WARN", () => {
    expect(spfCheck(found("v=spf1 include:_spf.mail.example -all"), DOMAIN).status).toBe("PASS");
    expect(spfCheck(found("v=spf1 include:_spf.mail.example ~all", "google-site-verification=abc"), DOMAIN).status).toBe("PASS");
    expectCheck(spfCheck(found("google-site-verification=abc"), DOMAIN), "FAIL", "no SPF record");
    expectCheck(spfCheck(found("v=spf1 -all", "v=spf1 include:_spf.mail.example -all"), DOMAIN), "FAIL", "2 SPF records");
    expect(spfCheck(found("v=spf1 +all"), DOMAIN).status).toBe("FAIL");
    expect(spfCheck(found("v=spf1 include:_spf.mail.example ?all"), DOMAIN).status).toBe("WARN");
    expect(spfCheck(found("v=spf10 -all"), DOMAIN).status).toBe("FAIL");
    expectCheck(spfCheck(unreadable, DOMAIN), "WARN", "could not resolve");
  });

  it("DMARC: missing FAIL, p=none WARN, quarantine or reject PASS, unreadable WARN", () => {
    expect(dmarcCheck(found(), DOMAIN).status).toBe("FAIL");
    expect(dmarcCheck(found("v=DMARC1; p=none; rua=mailto:dmarc@acme.example"), DOMAIN).status).toBe("WARN");
    expect(dmarcCheck(found("v=DMARC1;p=quarantine"), DOMAIN).status).toBe("PASS");
    expect(dmarcCheck(found("v=DMARC1; p=reject"), DOMAIN).status).toBe("PASS");
    expect(dmarcCheck(found("v=DMARC1; rua=mailto:dmarc@acme.example"), DOMAIN).status).toBe("FAIL");
    expect(dmarcCheck(found("v=DMARC1; p=reject", "v=DMARC1; p=none"), DOMAIN).status).toBe("FAIL");
    expectCheck(dmarcCheck(unreadable, DOMAIN), "WARN", "could not resolve");
  });

  it("DKIM: a key PASS, missing or revoked FAIL, no selector INFO, unreadable WARN", () => {
    expect(dkimCheck(found("v=DKIM1; k=rsa; p=MIGfMA0"), DOMAIN, "s1").status).toBe("PASS");
    expect(dkimCheck(found(), DOMAIN, "s1").status).toBe("FAIL");
    expectCheck(dkimCheck(found("v=DKIM1; p="), DOMAIN, "s1"), "FAIL", "revoked");
    expectCheck(dkimCheck(undefined, DOMAIN, undefined), "INFO", "set sending.dkimSelector");
    expectCheck(dkimCheck(unreadable, DOMAIN, "s1"), "WARN", "could not resolve");
  });

  it("domain separation: an INFO confirming the subdomain", () => {
    expect(domainSeparationCheck(DOMAIN, "acme.example")).toMatchObject({ status: "INFO" });
    expect(domainSeparationCheck("acme.example", "acme.example")).toMatchObject({ status: "WARN" });
  });
});
