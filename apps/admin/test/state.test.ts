// GTM-agents: tests for the dashboard's pure state: backoff, connection outcomes, the activity
// feed, streaming chat turns, what rejecting a proposal does, the kanban grouping, flag editing and
// hash routes.
import { describe, expect, it } from "vitest";
import type { ActivityItem } from "@gtm-agents/core/gateway/protocol";
import { parseRoute, routeHash } from "../src/router.ts";
import {
  DEAL_STAGES,
  addActivity,
  appendActivity,
  backoffDelay,
  chatDelta,
  chatDone,
  chatOperatorSaid,
  chatStreamingTurn,
  chatTurnStarted,
  classifyCloseCode,
  classifyProbeStatus,
  emptyChat,
  groupByStage,
  isFlagEditable,
  parseFlagInput,
  rejectConsequence,
} from "../src/state.ts";

const item = (id: string, kind = "send"): ActivityItem => ({ id, at: "2026-01-05T10:00:00Z", kind, actor: "system", summary: `item ${id}` });

describe("backoffDelay", () => {
  it("grows exponentially within its jitter window and caps", () => {
    expect(backoffDelay(0, () => 0)).toBe(250);
    expect(backoffDelay(0, () => 1)).toBe(500);
    expect(backoffDelay(3, () => 0.5)).toBe(3000);
    expect(backoffDelay(30, () => 1)).toBe(30_000);
  });
});

describe("connection outcomes", () => {
  it("maps probe statuses", () => {
    expect(classifyProbeStatus(503)).toBe("not_configured");
    expect(classifyProbeStatus(401)).toBe("not_allowed");
    expect(classifyProbeStatus(403)).toBe("not_allowed");
    expect(classifyProbeStatus(426)).toBe("retry");
    expect(classifyProbeStatus(null)).toBe("retry");
  });

  it("maps close codes", () => {
    expect(classifyCloseCode(4401)).toBe("not_allowed");
    expect(classifyCloseCode(4503)).toBe("not_configured");
    expect(classifyCloseCode(1006)).toBe("retry");
  });
});

describe("activity feed", () => {
  it("adds a live item once, newest first, within the cap", () => {
    let feed = addActivity([], item("a"));
    feed = addActivity(feed, item("b"));
    feed = addActivity(feed, item("a"));
    expect(feed.map((i) => i.id)).toEqual(["b", "a"]);
    expect(addActivity(feed, item("c"), 2).map((i) => i.id)).toEqual(["c", "b"]);
  });

  it("appends a page without duplicates", () => {
    expect(appendActivity([item("a"), item("b")], [item("b"), item("c")]).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});

describe("chat", () => {
  it("streams deltas into the turn and finishes it", () => {
    let chat = chatOperatorSaid(emptyChat, "Who replied today?", "2026-01-05T10:00:00Z");
    chat = chatTurnStarted(chat, "t1", "2026-01-05T10:00:01Z");
    expect(chatStreamingTurn(chat)).toBe("t1");
    chat = chatDelta(chat, "t1", "Two ");
    chat = chatDelta(chat, "t1", "people.");
    chat = chatDone(chat, "t1", "completed");
    expect(chat.messages[1]).toMatchObject({ role: "agent", text: "Two people.", status: "completed" });
    expect(chatStreamingTurn(chat)).toBeNull();
    expect(chatDelta(chat, "t1", " more")).toBe(chat);
  });

  it("replaces the turn's text on a reset delta, early or not, and keeps markup as plain text", () => {
    let chat = chatTurnStarted(emptyChat, "t3", "2026-01-05T10:00:00Z");
    chat = chatDelta(chat, "t3", "Let me look.");
    chat = chatDelta(chat, "t3", "No contacts", true);
    chat = chatDelta(chat, "t3", " at <b>Acme</b> yet.");
    expect(chat.messages[0]?.text).toBe("No contacts at <b>Acme</b> yet.");
    chat = chatDelta(chat, "t3", "", true);
    expect(chat.messages[0]?.text).toBe("");
    let early = chatDelta(emptyChat, "t4", "Draft answer");
    early = chatDelta(early, "t4", "Final answer", true);
    early = chatTurnStarted(early, "t4", "2026-01-05T10:00:00Z");
    expect(early.messages[0]?.text).toBe("Final answer");
  });

  it("keeps tokens and a finish that arrive before the turn id", () => {
    let chat = chatDelta(emptyChat, "t2", "Early ");
    chat = chatDelta(chat, "t2", "tokens");
    chat = chatDone(chat, "t2", "aborted", "Stopped by the operator.");
    chat = chatTurnStarted(chat, "t2", "2026-01-05T10:00:00Z");
    expect(chat.messages[0]).toMatchObject({ text: "Early tokens", status: "aborted", note: "Stopped by the operator." });
    expect(chat.early).toEqual({});
  });
});

describe("rejectConsequence", () => {
  it("tells the operator that rejecting an autonomy proposal dismisses it and changes no level", () => {
    expect(rejectConsequence("autonomy")).toMatch(/dismisses this proposal: no level changes, and it can never be confirmed afterwards/);
    expect(rejectConsequence("experiment")).toMatch(/without applying it/);
  });
});

describe("groupByStage", () => {
  it("orders known stages first and keeps unknown ones after them", () => {
    const deals = [
      { id: "1", stage: "trial" },
      { id: "2", stage: "prospecting" },
      { id: "3", stage: "custom_stage" },
    ];
    const columns = groupByStage(deals, []);
    expect(columns.map((c) => c.stage)).toEqual([...DEAL_STAGES, "custom_stage"]);
    expect(columns.find((c) => c.stage === "trial")?.deals.map((d) => d.id)).toEqual(["1"]);
  });
});

describe("flags", () => {
  it("never offers autonomy keys for editing", () => {
    expect(isFlagEditable("autonomy:cold_send")).toBe(false);
    expect(isFlagEditable("autonomy_review:enabled")).toBe(false);
    expect(isFlagEditable("inbound:auto_send_tier")).toBe(false);
    expect(isFlagEditable("operator:agent_enabled")).toBe(true);
  });

  it("checks a value against the flag's kind", () => {
    expect(parseFlagInput("boolean", " true ")).toEqual({ ok: true, value: "true" });
    expect(parseFlagInput("boolean", "yes").ok).toBe(false);
    expect(parseFlagInput("number", "12.5")).toEqual({ ok: true, value: "12.5" });
    expect(parseFlagInput("number", "twelve").ok).toBe(false);
    expect(parseFlagInput("string", "").ok).toBe(false);
  });
});

describe("routes", () => {
  it("parses views and falls back to the overview", () => {
    expect(parseRoute("")).toEqual({ view: "overview" });
    expect(parseRoute("#/pipeline")).toEqual({ view: "pipeline" });
    expect(parseRoute("#/nope")).toEqual({ view: "overview" });
    expect(parseRoute("#/contacts/%E0%A4%A")).toEqual({ view: "contacts" });
  });

  it("round-trips a contact id that holds reserved characters", () => {
    const id = "c/1#x?y";
    expect(parseRoute(routeHash({ view: "contacts", id }))).toEqual({ view: "contacts", id });
  });
});
