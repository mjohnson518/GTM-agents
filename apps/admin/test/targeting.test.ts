// GTM-agents: the Product and ICP editor's state: items in and out, add, remove and edit, what the
// editor starts from, grouping by kind, the review hint, and the route. Every item is synthetic.
import { describe, expect, it } from "vitest";
import type { TargetingItem, TargetingReadiness, TargetingState, TargetingSuggestionView } from "@gtm-agents/core/gateway/protocol";
import { addItem, baseline, editPick, type EditorItem, fromItems, grouped, isApproved, pickedItems, picksFrom, readinessLines, reloadEditor, reloadPicks, removeItem, reviewDue, sameItems, toItems, togglePick, updateItem } from "../src/targeting.ts";
import { parseRoute, routeHash } from "../src/router.ts";

const served: TargetingItem[] = [
  { id: "who", fields: { kind: "who", text: "Software companies with 30 to 300 engineers." } },
  { id: "never-globex", fields: { kind: "never", text: "Never contact Globex.", domains: "globex.example" } },
];

function state(draft: TargetingState["draft"]): TargetingState {
  return {
    flags: { enabled: true, draft: true, dailyMax: 10, usedToday: 0, defaultDailyMax: 10, suggest: true, suggestDailyMax: 5, suggestUsedToday: 0 },
    draftAvailable: true,
    approvable: true,
    company: { name: "Acme", url: "https://acme.example", description: "Quarantines flaky tests." },
    served: {
      brainVersion: "v",
      product: { content: null, sha256: null, version: 0, updated: null, items: [] },
      icp: { content: "x", sha256: "a".repeat(64), version: 3, updated: "2026-10-01", items: served },
      personas: { content: null, sha256: null, version: 0, updated: null, items: [] },
      "keyword-portfolio": { content: null, sha256: null, version: 0, updated: null, items: [] },
    },
    readiness: null,
    suggestion: null,
    draft,
  };
}

describe("the editor", () => {
  it("round-trips items, keeping a hard stop's lists and dropping empty ones", () => {
    const list = fromItems(served, "served");
    expect(toItems(list)).toEqual(served);
    const edited = updateItem(list, list[1]?.key ?? "", { field: { name: "titles", value: "  " } });
    expect(toItems(edited)).toEqual(served);
  });

  it("adds items with unique ids, removes them, and tells when it differs from where it started", () => {
    let list = fromItems(served, "served");
    list = addItem(list, "why_now");
    list = addItem(list, "why_now");
    expect(list.map((i) => i.id)).toEqual(["who", "never-globex", "why-now-1", "why-now-2"]);
    expect(sameItems(toItems(list), served)).toBe(false);
    list = removeItem(list, list[3]?.key ?? "");
    list = removeItem(list, list[2]?.key ?? "");
    expect(sameItems(toItems(list), served)).toBe(true);
  });

  it("shows a drafted item as drafted only until the operator edits it", () => {
    const drafted = [{ id: "who-1", kind: "who", text: "Platform teams at software companies.", basis: "stated" as const, figures: false }];
    const list = fromItems([{ id: "who-1", fields: { kind: "who", text: drafted[0]?.text ?? "" } }, served[1] ?? { id: "", fields: {} }], "drafted", drafted);
    expect(list.map((i) => [i.origin, i.basis])).toEqual([["drafted", "stated"], ["served", undefined]]);
    const edited = updateItem(list, list[0]?.key ?? "", { text: "Platform teams at software companies with large suites." });
    expect(edited[0]).toMatchObject({ origin: "added" });
    expect(edited[0]?.basis).toBeUndefined();
  });

  it("calls an item approved only while the served file holds it exactly, wherever it came from", () => {
    const at = (list: readonly EditorItem[], i: number): EditorItem => {
      const item = list[i];
      if (!item) throw new Error(`no item ${i}`);
      return item;
    };
    // A drafted item that has since been approved: still drafted from the site, and now approved.
    const drafted = [{ id: "who-1", kind: "who", text: "Platform teams at software companies.", basis: "stated" as const, figures: false }];
    const nowServed: TargetingItem[] = [{ id: "who-1", fields: { kind: "who", text: "Platform teams at software companies." } }, ...served.slice(1)];
    const list = fromItems(nowServed, "drafted", drafted);
    expect(at(list, 0).origin).toBe("drafted");
    expect(list.map((i) => isApproved(i, nowServed))).toEqual([true, true]);
    expect(isApproved(at(list, 0), served)).toBe(false);
    // A served item the operator edits is no longer approved, and is again once put back.
    const fromServed = fromItems(served, "served");
    const edited = updateItem(fromServed, at(fromServed, 0).key, { text: "Software companies with 50 to 500 engineers." });
    expect(isApproved(at(edited, 0), served)).toBe(false);
    const restored = updateItem(edited, at(edited, 0).key, { text: "Software companies with 30 to 300 engineers." });
    expect(isApproved(at(restored, 0), served)).toBe(true);
    // A hard stop whose lists changed, or an item whose kind changed, is not the approved one.
    expect(isApproved(at(updateItem(fromServed, at(fromServed, 1).key, { field: { name: "domains", value: "initech.example" } }), 1), served)).toBe(false);
    expect(isApproved(at(updateItem(fromServed, at(fromServed, 0).key, { kind: "trigger" }), 0), served)).toBe(false);
    // Field order and surrounding whitespace do not matter; an added item never is approved.
    const reordered = fromItems([{ id: "never-globex", fields: { domains: "globex.example", text: " Never contact Globex. ", kind: "never" } }], "served");
    expect(isApproved(at(reordered, 0), served)).toBe(true);
    expect(isApproved(at(addItem(fromServed, "why_now"), 2), served)).toBe(false);
  });

  it("starts from a ready draft's working copy, else from what is served", () => {
    expect(baseline(state(null), "icp").items).toEqual(served);
    const working = [{ id: "who-1", fields: { kind: "who", text: "Drafted." } }, served[1] ?? { id: "", fields: {} }];
    const ready = state({ id: "td_1", status: "ready", source: "url", url: "https://acme.example", reason: null, pages: [], skipped: [], draft: { product: [], icp: [] }, dropped: [], working: { icp: working }, startedAt: "2026-11-15T10:00:00.000Z", finishedAt: null, updatedAt: "2026-11-15T10:00:00.000Z" });
    expect(baseline(ready, "icp").items).toEqual(working);
    // A hard stop served now but missing from an older working copy is put back.
    const older = state({ ...(ready.draft as NonNullable<TargetingState["draft"]>), working: { icp: [working[0] ?? { id: "", fields: {} }] } });
    expect(baseline(older, "icp").items.map((i) => i.id)).toEqual(["who-1", "never-globex"]);
    expect(baseline(ready, "product").items).toEqual([]);
    const failed = state({ ...(ready.draft as NonNullable<TargetingState["draft"]>), status: "failed" });
    expect(baseline(failed, "icp").items).toEqual(served);
  });

  it("keeps unsaved edits across a reload, and otherwise starts again from what is served", () => {
    const loaded = reloadEditor(undefined, state(null), "icp");
    expect(toItems(loaded.items)).toEqual(served);
    const typing = { ...loaded, items: updateItem(loaded.items, loaded.items[0]?.key ?? "", { text: "Software companies with 50 to 500 engineers." }) };
    expect(reloadEditor(typing, state(null), "icp")).toBe(typing);
    const clean = reloadEditor(loaded, state(null), "icp");
    expect(clean).not.toBe(loaded);
    expect(toItems(clean.items)).toEqual(served);
  });

  it("groups ICP items by kind with plain labels, in the kinds' order", () => {
    const list = addItem(fromItems(served, "served"), "unknown");
    expect(grouped("icp", list).map((g) => g.label)).toEqual(["Who", "Never", "Open questions"]);
  });

  it("hints at a review after 90 days", () => {
    const now = new Date("2026-11-15T00:00:00Z");
    expect(reviewDue("2026-10-01", now)).toBe(false);
    expect(reviewDue("2026-08-01", now)).toBe(true);
    expect(reviewDue(null, now)).toBe(false);
  });

  it("has its own route", () => {
    expect(parseRoute("#/targeting")).toEqual({ view: "targeting" });
    expect(routeHash({ view: "targeting" })).toBe("#/targeting");
  });
});

const component = (served: boolean, items = 0) => ({ served, unverified: false, version: served ? 1 : null, updated: served ? "2026-11-01" : null, items });

function readiness(over: Partial<TargetingReadiness> = {}): TargetingReadiness {
  return {
    components: { product: component(true, 1), icp: component(true, 2), personas: component(true, 2), "keyword-portfolio": component(true, 3) },
    sourcing: { degraded: false, personas: 2, queries: 3 },
    flags: { discovery: true, fitScoring: true, research: false },
    ...over,
  };
}

describe("readiness", () => {
  it("says in plain words what discovery and fit scoring are missing, and which flags are off", () => {
    const ready = readinessLines(readiness());
    expect(ready.filter((l) => l.tone === "warn")).toEqual([]);
    expect(ready.map((l) => l.text)).toContain("Discovery is on (discovery:enabled).");
    expect(ready.find((l) => l.text.startsWith("Account research is off"))?.tone).toBe("off");

    const bare = readinessLines(
      readiness({
        components: { product: component(false), icp: component(false), personas: component(false), "keyword-portfolio": component(false) },
        sourcing: { degraded: false, personas: 0, queries: 0 },
        flags: { discovery: false, fitScoring: false, research: false },
      }),
    );
    const warnings = bare.filter((l) => l.tone === "warn").map((l) => l.text);
    expect(warnings).toEqual([
      "No ICP is approved: fit scoring has nothing to judge accounts against, and sourcing has no hard stops.",
      "No personas are approved: search still runs and spends, but nobody it finds is enriched, qualified or promoted.",
      "No search queries are approved, so search looks for nothing.",
    ]);
    expect(bare.map((l) => l.text)).toContain("No product description is approved; fit scoring and the chat agent go without it.");

    // A brain that cannot be read whole: one warning, not a misleading list of missing parts.
    const degraded = readinessLines(readiness({ sourcing: { degraded: true, personas: 0, queries: 0 } }));
    expect(degraded.filter((l) => l.tone === "warn").map((l) => l.text)).toEqual(["The brain could not be read whole, so discovery does nothing until it is uploaded again."]);
    expect(readinessLines(null)).toEqual([{ tone: "warn", text: "The brain could not be read, so readiness is unknown." }]);
  });
});

const suggestion: TargetingSuggestionView = {
  id: "ts_1",
  status: "ready",
  reason: null,
  suggestions: {
    "keyword-portfolio": [
      { id: "solution-1", fields: { query: "platform teams evaluating flaky test detection", intent: "solution" } },
      { id: "trigger-1", fields: { query: "companies adopting merge queues", intent: "trigger" } },
    ],
    personas: [{ id: "user-1", fields: { role: "user", seat: "user", titles: "Release Engineer", text: "Keeps releases moving." } }],
  },
  dropped: [],
  working: null,
  startedAt: "2026-11-16T10:00:00.000Z",
  finishedAt: "2026-11-16T10:00:20.000Z",
  updatedAt: "2026-11-16T10:00:20.000Z",
};

describe("picking suggestions", () => {
  it("starts with nothing picked, picks on a tick or an edit, and edits only the main text", () => {
    let list = picksFrom(suggestion, "keyword-portfolio");
    expect(pickedItems(list)).toEqual([]);
    list = togglePick(list, "trigger-1");
    expect(pickedItems(list).map((i) => i.id)).toEqual(["trigger-1"]);
    list = editPick(list, "keyword-portfolio", "solution-1", "query", "  platform teams   evaluating flaky tests ");
    list = editPick(list, "keyword-portfolio", "solution-1", "intent", "competitor");
    expect(pickedItems(list)).toEqual([
      { id: "solution-1", fields: { query: "platform teams evaluating flaky tests", intent: "solution" } },
      { id: "trigger-1", fields: { query: "companies adopting merge queues", intent: "trigger" } },
    ]);
    list = togglePick(list, "trigger-1");
    expect(pickedItems(list).map((i) => i.id)).toEqual(["solution-1"]);
    // A persona's titles and description can be edited; its role cannot.
    const personas = editPick(editPick(picksFrom(suggestion, "personas"), "personas", "user-1", "titles", "Release Engineer, Build Engineer"), "personas", "user-1", "role", "champion");
    expect(pickedItems(personas)).toEqual([{ id: "user-1", fields: { role: "user", seat: "user", titles: "Release Engineer, Build Engineer", text: "Keeps releases moving." } }]);
  });

  it("opens saved picks, and keeps unsaved ones through a reload unless the suggestion changed", () => {
    const saved = { ...suggestion, working: { "keyword-portfolio": [{ id: "trigger-1", fields: { query: "teams adopting merge queues", intent: "trigger" } }] } };
    const opened = reloadPicks(undefined, saved, "keyword-portfolio");
    expect(pickedItems(opened.list)).toEqual(saved.working["keyword-portfolio"]);
    expect(sameItems(pickedItems(opened.list), opened.base)).toBe(true);
    const typing = { ...opened, list: togglePick(opened.list, "solution-1") };
    expect(reloadPicks(typing, saved, "keyword-portfolio")).toBe(typing);
    const fresh = reloadPicks(typing, { ...saved, id: "ts_2", working: null }, "keyword-portfolio");
    expect(fresh.suggestionId).toBe("ts_2");
    expect(pickedItems(fresh.list)).toEqual([]);
    expect(reloadPicks(typing, null, "keyword-portfolio").list).toEqual([]);
  });
});
