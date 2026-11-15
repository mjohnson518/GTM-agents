// GTM-agents: the Product and ICP editor's state: items in and out, add, remove and edit, what the
// editor starts from, grouping by kind, the review hint, and the route. Every item is synthetic.
import { describe, expect, it } from "vitest";
import type { TargetingItem, TargetingState } from "@gtm-agents/core/gateway/protocol";
import { addItem, baseline, fromItems, grouped, reloadEditor, removeItem, reviewDue, sameItems, toItems, updateItem } from "../src/targeting.ts";
import { parseRoute, routeHash } from "../src/router.ts";

const served: TargetingItem[] = [
  { id: "who", fields: { kind: "who", text: "Software companies with 30 to 300 engineers." } },
  { id: "never-globex", fields: { kind: "never", text: "Never contact Globex.", domains: "globex.example" } },
];

function state(draft: TargetingState["draft"]): TargetingState {
  return {
    flags: { enabled: true, draft: true, dailyMax: 10, usedToday: 0, defaultDailyMax: 10 },
    draftAvailable: true,
    approvable: true,
    company: { name: "Acme", url: "https://acme.example", description: "Quarantines flaky tests." },
    served: { brainVersion: "v", product: { content: null, sha256: null, version: 0, updated: null, items: [] }, icp: { content: "x", sha256: "a".repeat(64), version: 3, updated: "2026-10-01", items: served } },
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
