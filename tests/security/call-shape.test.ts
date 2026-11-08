// GTM-agents: the dispatcher checks exactly what the handler receives. A tool name must be a
// tool-name string, and the input is snapshotted once as plain JSON, so getters, proxies and
// non-string names cannot show the checks one thing and the handler another.
import { executeToolCall, type ToolCall } from "@gtm-agents/core/runtime";
import { toolInputDigest } from "@gtm-agents/core/security";
import { describe, expect, it } from "vitest";
import { deps, session, spy } from "./helpers.ts";

describe("the shape of a tool call", () => {
  it("refuses a tool name that is not a plain tool-name string", async () => {
    const merge = spy("merged");
    const fetch = spy("page");
    const d = deps({ repo_pr_merge: merge.handler, web_fetch: fetch.handler });
    const names: unknown[] = [["repo_pr_merge"], { toString: () => "web_fetch" }, 42, null, "Repo_PR_Merge", "web fetch", "a".repeat(80)];
    for (const name of names) {
      const result = await executeToolCall(d, session(), { name, input: { url: "http://169.254.169.254/" } } as unknown as ToolCall);
      expect(result, String(name)).toMatchObject({ status: "blocked", code: "invalid_input" });
    }
    expect(merge.calls).toEqual([]);
    expect(fetch.calls).toEqual([]);
  });

  it("refuses input that is not a JSON object", async () => {
    const handler = spy();
    for (const input of [null, "text", 3, [1, 2], { big: 1n }]) {
      const result = await executeToolCall(deps({ contacts_stats: handler.handler }), session(), { name: "contacts_stats", input });
      expect(result, JSON.stringify(input, (_k, v: unknown) => (typeof v === "bigint" ? "bigint" : v))).toMatchObject({ status: "blocked", code: "invalid_input" });
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect((await executeToolCall(deps({ contacts_stats: handler.handler }), session(), { name: "contacts_stats", input: cyclic })).status).toBe("blocked");
    expect(handler.calls).toEqual([]);
  });

  it("gives the handler the same values the approval check saw, even with getters", async () => {
    const erase = spy("erased");
    let reads = 0;
    const input = {
      get contact_id() {
        reads += 1;
        return reads === 1 ? "contact-acme-0001" : "contact-acme-ALL";
      },
    };
    const approval = { digest: await toolInputDigest("contact_erase", { contact_id: "contact-acme-0001" }) };
    const result = await executeToolCall(deps({ contact_erase: erase.handler }), session(), { name: "contact_erase", input }, { approval });
    expect(result.status).toBe("ok");
    expect(erase.calls).toEqual([{ contact_id: "contact-acme-0001" }]);
  });

  it("gives the handler the same URL the request-forgery check saw, even through a Proxy", async () => {
    const fetch = spy("page");
    let reads = 0;
    const target: Record<string, unknown> = { url: "" };
    const input = new Proxy(target, {
      get: (obj, key) => (key === "url" ? (reads++ === 0 ? "https://www.example.com/" : "http://169.254.169.254/") : obj[String(key)]),
    });
    await executeToolCall(deps({ web_fetch: fetch.handler }), session(), { name: "web_fetch", input });
    for (const call of fetch.calls) expect(call.url).toBe("https://www.example.com/");
  });
});
