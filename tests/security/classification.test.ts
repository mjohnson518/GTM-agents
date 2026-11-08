// GTM-agents: every tool is classified, and anything unclassified is treated as fully tainted.
import { executeToolCall } from "@gtm-agents/core/runtime";
import { CORE_TOOL_CLASSES, PERMANENT_HUMAN_TOOLS, ToolRegistryError, UNKNOWN_TOOL_CLASS, createToolRegistry } from "@gtm-agents/core/security";
import { describe, expect, it } from "vitest";
import { deps, session, spy } from "./helpers.ts";

const exampleManifest = {
  name: "search-example",
  tools: {
    example_lookup: { taint: "metadata", gate: "never", egress: "query", rateCategory: "search" },
    example_publish: { taint: "none" },
    example_purge: { taint: "none", gate: "metadata", humanOnly: true },
  },
};

describe("tool classification", () => {
  it("classifies every core tool with a known taint and gate", () => {
    const registry = createToolRegistry();
    expect(registry.names).toEqual(Object.keys(CORE_TOOL_CLASSES).sort());
    for (const name of registry.names) {
      expect(registry.isDeclared(name)).toBe(true);
      expect(registry.sourceOf(name)).toBe("core");
    }
  });

  it("treats an undeclared tool as fully tainted and refused once anything untrusted is read", () => {
    const registry = createToolRegistry();
    for (const name of ["mystery_tool", "Email_Send", "email_send ", "constructor", "__proto__", "toString", "", ["email_send"] as never]) {
      expect(registry.classify(name), name).toBe(UNKNOWN_TOOL_CLASS);
    }
    expect(UNKNOWN_TOOL_CLASS).toEqual({ taint: "full", gate: "metadata" });
  });

  it("runs an undeclared tool only in a clean session, then fences its output and taints the session", async () => {
    const handler = spy("whatever it returns");
    const clean = session();
    const ok = await executeToolCall(deps({ mystery_tool: handler.handler }), clean, { name: "mystery_tool", input: {} });
    expect(ok.status).toBe("ok");
    expect(ok.content).toContain('trust="untrusted"');
    expect(clean.taint).toBe("full");

    const refused = await executeToolCall(deps({ mystery_tool: handler.handler }), session("metadata"), { name: "mystery_tool", input: {} });
    expect(refused).toMatchObject({ status: "blocked", code: "tainted" });
    expect(handler.calls).toHaveLength(1);
  });

  it("does not run a declared tool that has no handler", async () => {
    const result = await executeToolCall(deps({}), session(), { name: "contacts_search", input: {} });
    expect(result).toMatchObject({ status: "blocked", code: "unavailable" });
  });

  it("adds adapter tools, defaulting an omitted gate to metadata", () => {
    const registry = createToolRegistry({ manifests: [exampleManifest] });
    expect(registry.classify("example_lookup")).toEqual({ taint: "metadata", gate: "never", egress: "query", rateCategory: "search" });
    expect(registry.classify("example_publish")).toEqual({ taint: "none", gate: "metadata" });
    expect(registry.classify("example_purge")).toEqual({ taint: "none", gate: "metadata", humanOnly: true });
    expect(registry.sourceOf("example_lookup")).toBe('adapter "search-example"');
  });

  it("refuses an adapter tool that reuses a core name or another adapter's name", () => {
    expect(() => createToolRegistry({ manifests: [{ name: "shadow", tools: { email_send: { taint: "none", gate: "never" } } }] })).toThrow(ToolRegistryError);
    expect(() => createToolRegistry({ manifests: [exampleManifest, { ...exampleManifest, name: "search-copy" }] })).toThrow(/declared by both/);
  });

  it("refuses an invalid adapter tool declaration instead of guessing", () => {
    const bad = [
      { taint: "trusted" },
      { taint: "none", gate: "sometimes" },
      { gate: "never" },
      { taint: "none", extra: true },
      "full",
    ];
    for (const declaration of bad) {
      expect(() => createToolRegistry({ manifests: [{ name: "bad", tools: { bad_tool: declaration } }] })).toThrow(ToolRegistryError);
    }
    expect(() => createToolRegistry({ manifests: [{ name: "bad", tools: { "Bad-Tool": { taint: "none" } } }] })).toThrow(/snake_case/);
  });

  it("treats records a tainted session can write as third-party text when read back", () => {
    const registry = createToolRegistry();
    for (const write of ["contacts_update", "contacts_log_outreach", "deals_update", "drafts_create", "task_create"]) {
      expect(registry.classify(write).gate, write).not.toBe("metadata");
    }
    for (const read of ["contacts_get", "contacts_search", "deals_list", "drafts_list", "task_list", "task_get"]) {
      expect(registry.classify(read).taint, read).toBe("metadata");
    }
  });

  it("refuses to start when a permanently human tool is not human-only", () => {
    expect(PERMANENT_HUMAN_TOOLS).toMatchObject({ repo_pr_merge: "merge_code", contact_erase: "data_deletion" });
    const loosened = { ...CORE_TOOL_CLASSES, repo_pr_merge: { taint: "none", gate: "metadata" } } as const;
    expect(() => createToolRegistry({ core: loosened })).toThrow(/permanently human/);
    expect(() =>
      createToolRegistry({ core: {}, manifests: [{ name: "billing-example", tools: { checkout_create: { taint: "none", gate: "structured" } } }] }),
    ).toThrow(/permanently human/);
    expect(Object.isFrozen(CORE_TOOL_CLASSES)).toBe(true);
    expect(createToolRegistry({ core: {} }).classify("repo_pr_merge")).toEqual({ taint: "full", gate: "metadata", humanOnly: true });
    expect(Object.isFrozen(CORE_TOOL_CLASSES.repo_pr_merge)).toBe(true);
  });

  it("returns frozen classes that callers cannot loosen", () => {
    const registry = createToolRegistry();
    const cls = registry.classify("email_send") as { gate: string };
    expect(() => {
      cls.gate = "never";
    }).toThrow(TypeError);
    expect(registry.classify("email_send").gate).toBe("structured");
  });
});
