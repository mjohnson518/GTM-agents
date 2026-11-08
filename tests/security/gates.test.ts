// GTM-agents: gates never loosen as taint rises, and taint only rises.
import { executeToolCall } from "@gtm-agents/core/runtime";
import {
  GATE_LEVELS,
  TAINT_LEVELS,
  checkActionGate,
  createToolRegistry,
  isRefusedAt,
  maxTaintLevel,
  raiseTaint,
  toTaintLevel,
  type TaintLevel,
} from "@gtm-agents/core/security";
import { runSecurityContract, securityContractViolations } from "@gtm-agents/core/testing";
import { describe, expect, it } from "vitest";
import { deps, session, spy } from "./helpers.ts";

const adapterManifest = {
  name: "email-example",
  tools: {
    email_send_batch: { taint: "none", gate: "structured", rateCategory: "esp" },
    email_lookup_delivery: { taint: "metadata", gate: "never" },
    page_snapshot: { taint: "full", gate: "never", egress: "url", rateCategory: "web" },
  },
};

describe("gate thresholds", () => {
  it("refuse at every level at or above the gate, and never below it", () => {
    const expected: Record<string, TaintLevel[]> = {
      never: [],
      metadata: ["metadata", "structured", "full"],
      structured: ["structured", "full"],
      full: ["full"],
    };
    for (const gate of GATE_LEVELS) {
      expect(TAINT_LEVELS.filter((t) => isRefusedAt(gate, t)), gate).toEqual(expected[gate]);
    }
  });

  it("never loosen as taint rises, for every core and adapter tool", () => {
    const registry = createToolRegistry({ manifests: [adapterManifest] });
    for (const name of registry.names) {
      const cls = registry.classify(name);
      let refused = false;
      for (const taint of TAINT_LEVELS) {
        const now = !checkActionGate(name, cls, taint).allowed;
        if (refused) expect(now, `${name} at ${taint}`).toBe(true);
        refused ||= now;
      }
    }
  });

  it("read an unknown gate value as metadata, so it fails closed", () => {
    const weird = { taint: "none", gate: "sometimes" } as never;
    expect(checkActionGate("weird_tool", weird, "metadata").allowed).toBe(false);
    expect(checkActionGate("weird_tool", weird, "none").allowed).toBe(true);
  });
});

describe("taint levels", () => {
  it("combine with maxTaintLevel: commutative, associative, idempotent, with none as identity", () => {
    for (const a of TAINT_LEVELS) {
      expect(maxTaintLevel(a, "none")).toBe(a);
      expect(maxTaintLevel(a, a)).toBe(a);
      for (const b of TAINT_LEVELS) {
        expect(maxTaintLevel(a, b)).toBe(maxTaintLevel(b, a));
        for (const c of TAINT_LEVELS) expect(maxTaintLevel(maxTaintLevel(a, b), c)).toBe(maxTaintLevel(a, maxTaintLevel(b, c)));
      }
    }
    expect(maxTaintLevel()).toBe("none");
  });

  it("treat any value that is not a known level as full", () => {
    for (const value of ["FULL", "clean", "", null, undefined, 3, {}]) {
      expect(toTaintLevel(value)).toBe("full");
      expect(maxTaintLevel("none", value as TaintLevel)).toBe("full");
    }
  });

  it("only rise within a session", () => {
    const s = session("structured");
    expect(raiseTaint(s, "none")).toBe("structured");
    expect(raiseTaint(s, "metadata")).toBe("structured");
    expect(raiseTaint(s, "full")).toBe("full");
    expect(raiseTaint(s, "none")).toBe("full");
  });

  it("never fall through a dispatched call, whatever the tool returns", async () => {
    const s = session("metadata");
    await executeToolCall(deps({ contacts_search: spy("[]").handler }), s, { name: "contacts_search", input: {} });
    expect(s.taint).toBe("metadata");
    const corrupted = { taint: "bogus" as TaintLevel };
    const result = await executeToolCall(deps({ email_send: spy().handler }), corrupted, { name: "email_send", input: {} });
    expect(corrupted.taint).toBe("full");
    expect(result.status).toBe("blocked");
  });
});

describe("the security contract", () => {
  it("holds for core's tools", async () => {
    await expect(runSecurityContract(createToolRegistry())).resolves.toBeUndefined();
  });

  it("holds for core plus an adapter's tools", async () => {
    await expect(runSecurityContract(createToolRegistry({ manifests: [adapterManifest] }))).resolves.toBeUndefined();
  });

  it("reports an egress tool with no rate category", async () => {
    const registry = createToolRegistry({
      manifests: [{ name: "fetch-example", tools: { page_grab: { taint: "full", gate: "never", egress: "url" } } }],
    });
    expect(await securityContractViolations(registry)).toEqual(["page_grab: a tool with egress must declare a rateCategory"]);
  });

  it("reports a registry that treats undeclared tools as clean", async () => {
    const lenient = { ...createToolRegistry({ core: {} }), classify: () => ({ taint: "none" as const, gate: "never" as const }) };
    expect(await securityContractViolations(lenient)).toContain("an undeclared tool must classify as full taint with gate metadata");
  });
});
