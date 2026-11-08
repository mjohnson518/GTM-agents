// GTM-agents: requests cannot reach internal addresses, and once a session has read anything from outside, they cannot carry data out.
import { executeToolCall } from "@gtm-agents/core/runtime";
import { checkEgress, collectStrings, urlExfiltrationReason, validateUrl } from "@gtm-agents/core/security";
import { describe, expect, it } from "vitest";
import { deps, session, spy } from "./helpers.ts";

const BLOCKED = [
  "http://localhost/",
  "http://LOCALHOST./admin",
  "http://api.localhost/",
  "http://127.0.0.1/",
  "http://127.1/",
  "http://2130706433/",
  "http://0x7f000001/",
  "http://0177.0.0.1/",
  "http://0.0.0.0/",
  "http://10.1.2.3/",
  "http://172.16.0.1/",
  "http://172.31.255.255/",
  "http://192.168.1.1/",
  "http://169.254.169.254/latest/meta-data/",
  "http://100.100.100.200/",
  "http://198.18.0.1/",
  "http://224.0.0.1/",
  "http://255.255.255.255/",
  "http://[::1]/",
  "http://[::]/",
  "http://[::ffff:127.0.0.1]/",
  "http://[::ffff:7f00:1]/",
  "http://[fc00::1]/",
  "http://[fd00::1]/",
  "http://[fdff:ffff::1]/",
  "http://[fe80::1]/",
  "http://[febf::1]/",
  "http://[fec0::1]/",
  "http://[ff02::1]/",
  "http://[64:ff9b::7f00:1]/",
  "http://[100::1]/",
  "http://[2001:db8::1]/",
  "http://[2001:0:4136:e378::1]/",
  "http://[2002:7f00:1::1]/",
  "http://metadata.google.internal/computeMetadata/v1/",
  "http://intranet/",
  "http://printer.local/",
  "http://router.home.arpa/",
  "http://build.corp/",
  "http://wiki.intranet/",
  "ftp://files.example.com/",
  "file:///etc/passwd",
  "javascript:alert(1)",
  "data:text/plain,hello",
  "https://user:pass@www.example.com/",
  `https://www.example.com/${"a".repeat(2100)}`,
  "not a url",
  "",
];

const ALLOWED = [
  "https://www.example.com/pricing?plan=team",
  "https://fdic.gov/",
  "https://fd.example.com/",
  "https://fc00.example.org/",
  "https://fe80.example.net/",
  "http://8.8.8.8/",
  "https://172.15.0.1/",
  "https://172.32.0.1/",
  "https://100.63.255.255/",
  "https://100.128.0.1/",
  "https://[2606:4700:4700::1111]/",
  "https://xn--nxasmq6b.example/",
];

describe("URL validation", () => {
  it("refuses internal, reserved and non-web addresses", () => {
    for (const url of BLOCKED) expect(validateUrl(url).ok, url).toBe(false);
  });

  it("allows public web addresses, including hostnames that merely start like reserved ranges", () => {
    for (const url of ALLOWED) expect(validateUrl(url), url).toMatchObject({ ok: true });
  });

  it("finds URLs in every spelling the fetch parser accepts", async () => {
    const spellings = [
      "http:/169.254.169.254/latest/meta-data/",
      "http:\\\\169.254.169.254\\latest",
      `${String.fromCharCode(1)}http://169.254.169.254/`,
      "ht\ttp://169.254.169.254/",
      "HTTP:169.254.169.254/x",
      " https://localhost/",
    ];
    for (const url of spellings) {
      const fetch = spy("page");
      const result = await executeToolCall(deps({ web_fetch: fetch.handler }), session(), { name: "web_fetch", input: { url } });
      expect(result, JSON.stringify(url)).toMatchObject({ status: "blocked", code: "unsafe_url" });
      expect(fetch.calls).toEqual([]);
    }
  });

  it("is enforced by the dispatcher for egress tools at every taint level", async () => {
    const fetch = spy("page");
    const result = await executeToolCall(deps({ web_fetch: fetch.handler }), session(), {
      name: "web_fetch",
      input: { url: "http://169.254.169.254/latest/meta-data/" },
    });
    expect(result).toMatchObject({ status: "blocked", code: "unsafe_url" });
    expect(fetch.calls).toEqual([]);
  });
});

describe("data-carrying URLs", () => {
  const carrying = [
    "https://collector.example/?u=jane.doe@acme.example",
    "https://collector.example/?u=jane.doe%40acme.example",
    "https://collector.example/jane.doe@acme.example/page",
    "https://collector.example/page#jane.doe@acme.example",
    `https://collector.example/${"QUJD".repeat(20)}`,
    `https://collector.example/search?q=${"word+".repeat(30)}`,
    `https://${"a".repeat(45)}.collector.example/`,
    "https://a.b.c.d.e.collector.example/",
    "http:/a.b.c.d.e.f.g.collector.example/",
    `http:/collector.example/?q=${"word+".repeat(30)}`,
  ];

  it("are recognized", () => {
    for (const url of carrying) expect(urlExfiltrationReason(new URL(url).href), url).not.toBeNull();
    expect(urlExfiltrationReason("https://shop.example.com/products/outdoor/camping/tents/fourperson/ultralight/reviews/latest")).toBeNull();
    expect(urlExfiltrationReason("https://blog.example.com/2026/11/how-we-cut-flaky-tests-in-half?ref=newsletter")).toBeNull();
  });

  it("are refused at full taint, without reaching the handler", async () => {
    for (const url of carrying) {
      const fetch = spy("page");
      const result = await executeToolCall(deps({ web_fetch: fetch.handler }), session("full"), { name: "web_fetch", input: { url } });
      expect(result, url).toMatchObject({ status: "blocked", code: "egress" });
      expect(fetch.calls).toEqual([]);
    }
  });

  it("are refused once the session holds third-party records or snippets, not only raw pages", async () => {
    const fetch = spy("page");
    const result = await executeToolCall(deps({ web_fetch: fetch.handler }), session("metadata"), {
      name: "web_fetch",
      input: { url: "https://www.example.com/team?contact=jane.doe%40acme.example" },
    });
    expect(result).toMatchObject({ status: "blocked", code: "egress" });
    expect(fetch.calls).toEqual([]);
  });

  it("are allowed in a clean session, which holds nothing from outside", async () => {
    const fetch = spy("page");
    const result = await executeToolCall(deps({ web_fetch: fetch.handler }), session("none"), {
      name: "web_fetch",
      input: { url: "https://www.example.com/team?contact=jane.doe%40acme.example" },
    });
    expect(result.status).toBe("ok");
    expect(fetch.calls).toHaveLength(1);
  });

  it("are found inside nested input", () => {
    expect(checkEgress("url", { pages: [{ link: "https://collector.example/?u=jane.doe@acme.example" }] }).ok).toBe(false);
  });
});

describe("search queries at full taint", () => {
  it("may not carry an email address or an encoded blob", async () => {
    for (const query of ["contact jane.doe@acme.example", "jane.doe%40acme.example", "QUJD".repeat(20)]) {
      const search = spy("results");
      const result = await executeToolCall(deps({ web_search: search.handler }), session("full"), { name: "web_search", input: { query } });
      expect(result, query).toMatchObject({ status: "blocked", code: "egress" });
      expect(search.calls).toEqual([]);
    }
  });

  it("may carry an ordinary query", async () => {
    const result = await executeToolCall(deps({ web_search: spy("results").handler }), session("full"), {
      name: "web_search",
      input: { query: "flaky test quarantine for monorepos" },
    });
    expect(result.status).toBe("ok");
  });

  it("are refused when the input is too deeply nested or too large to check", () => {
    let nested: unknown = "jane";
    for (let i = 0; i < 8; i++) nested = { next: nested };
    expect(collectStrings(nested)).toBeNull();
    expect(checkEgress("query", nested).ok).toBe(false);
    expect(checkEgress("query", { terms: Array.from({ length: 3000 }, () => "x") }).ok).toBe(false);
  });
});
