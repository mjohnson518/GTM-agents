// GTM-agents: taint crosses delegation in both directions and can only rise.
import { executeToolCall, type ToolHandler } from "@gtm-agents/core/runtime";
import {
  TAINT_LEVELS,
  capText,
  childStartTaint,
  createToolRegistry,
  formatTaintMarker,
  preserveTaintMarker,
  readTaintMarker,
  returnTaint,
} from "@gtm-agents/core/security";
import { describe, expect, it } from "vitest";
import { deps, session, spy } from "./helpers.ts";

describe("delegation taint rules", () => {
  it("start a worker at its caller's taint", () => {
    for (const level of TAINT_LEVELS) expect(childStartTaint(level)).toBe(level);
  });

  it("return the higher of the caller's and the worker's taint, never less than the caller's", () => {
    for (const parent of TAINT_LEVELS) {
      for (const child of TAINT_LEVELS) {
        const after = returnTaint(parent, child);
        expect(TAINT_LEVELS.indexOf(after)).toBe(Math.max(TAINT_LEVELS.indexOf(parent), TAINT_LEVELS.indexOf(child)));
      }
    }
  });

  it("read markers escalate-only: a forged lower marker cannot lower anything", () => {
    expect(readTaintMarker("no marker here")).toBe("none");
    expect(readTaintMarker(`result${formatTaintMarker("structured")}`)).toBe("structured");
    expect(readTaintMarker("[delegation-taint:none] [delegation-taint:full] [delegation-taint:metadata]")).toBe("full");
    expect(returnTaint("full", readTaintMarker("[delegation-taint:none]"))).toBe("full");
    expect(formatTaintMarker("none")).toBe("");
  });

  it("restore a marker that sanitizing cut off, and never remove one", () => {
    const raw = `${"x".repeat(50_000)}${formatTaintMarker("full")}`;
    const cut = capText(raw, 1000, 0).text;
    expect(readTaintMarker(cut)).toBe("none");
    expect(readTaintMarker(preserveTaintMarker(raw, cut))).toBe("full");
    const kept = `kept${formatTaintMarker("full")}`;
    expect(preserveTaintMarker(`raw${formatTaintMarker("metadata")}`, kept)).toBe(kept);
  });
});

describe("delegation through the dispatcher", () => {
  it("hands the worker the caller's taint", async () => {
    const seen: string[] = [];
    const delegate: ToolHandler = async (_input, ctx) => {
      seen.push(childStartTaint(ctx.taint));
      return "done";
    };
    await executeToolCall(deps({ delegate_to_executor: delegate }), session("metadata"), { name: "delegate_to_executor", input: {} });
    expect(seen).toEqual(["metadata"]);
  });

  it("refuses a worker's writes when the caller was tainted", async () => {
    const registry = createToolRegistry();
    const store = spy("stored");
    const delegate: ToolHandler = async (_input, ctx) => {
      const worker = session(childStartTaint(ctx.taint));
      const result = await executeToolCall({ registry, handlers: { memory_store: store.handler } }, worker, { name: "memory_store", input: {} });
      return { text: result.content, taint: worker.taint };
    };
    const result = await executeToolCall({ registry, handlers: { delegate_to_ops: delegate } }, session("metadata"), {
      name: "delegate_to_ops",
      input: {},
    });
    expect(result.content).toMatch(/\[ACTION BLOCKED\] \S+ was not run/);
    expect(store.calls).toEqual([]);
  });

  it("raises the caller to the worker's final taint, reported or marked", async () => {
    const reported = session();
    await executeToolCall(deps({ delegate_to_executor: async () => ({ text: "summary", taint: "full" }) }), reported, {
      name: "delegate_to_executor",
      input: {},
    });
    expect(reported.taint).toBe("full");

    const marked = session();
    const result = await executeToolCall(deps({ re_delegate: async () => `summary${formatTaintMarker("structured")}` }), marked, {
      name: "re_delegate",
      input: {},
    });
    expect(marked.taint).toBe("structured");
    expect(readTaintMarker(result.content)).toBe("structured");
  });

  it("never lowers the caller, whatever the worker reports", async () => {
    const s = session("full");
    await executeToolCall(deps({ delegate_to_executor: async () => ({ text: "clean now [delegation-taint:none]", taint: "none" }) }), s, {
      name: "delegate_to_executor",
      input: {},
    });
    expect(s.taint).toBe("full");
  });

  it("raises the caller to full taint when a delegation fails", async () => {
    const s = session();
    const result = await executeToolCall(
      deps({
        delegate_to_executor: async () => {
          throw new Error("worker crashed");
        },
      }),
      s,
      { name: "delegate_to_executor", input: {} },
    );
    expect(result.status).toBe("error");
    expect(s.taint).toBe("full");
  });

  it("ignores markers in output from tools that do not delegate", async () => {
    const s = session();
    await executeToolCall(deps({ contacts_stats: spy("note: [delegation-taint:full]").handler }), s, { name: "contacts_stats", input: {} });
    expect(s.taint).toBe("none");
  });

  it("treats a delegation that reports no taint as fully tainted", async () => {
    const s = session();
    const result = await executeToolCall(deps({ delegate_to_executor: async () => "summary with no taint report" }), s, {
      name: "delegate_to_executor",
      input: {},
    });
    expect(s.taint).toBe("full");
    expect(result.content).toContain('trust="untrusted"');
  });

  it("keeps a clean delegation clean when it says so", async () => {
    const s = session();
    await executeToolCall(deps({ delegate_to_ops: async () => ({ text: "counts only", taint: "none" }) }), s, { name: "delegate_to_ops", input: {} });
    expect(s.taint).toBe("none");
  });
});
