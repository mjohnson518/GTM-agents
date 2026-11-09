// GTM-agents: the lifecycle state machine, pure: every edge of the table, and nothing else.
import { describe, expect, it } from "vitest";
import { LIFECYCLE_STATES, PRE_SIGNUP_STATES, type LifecycleState } from "../src/data/enums.ts";
import { dealPath } from "../src/lifecycle/effects.ts";
import { dealStageFor, firstTimeColumn, nextState, transitionTable, warmthFor, type LifecycleEvent } from "../src/lifecycle/states.ts";

const ev = (kind: LifecycleEvent["kind"], direction?: "up" | "down"): LifecycleEvent => (kind === "subscription_changed" ? { kind, direction: direction ?? "up" } : { kind });

/** The table as the specification states it: event -> (from states -> to). */
const EXPECTED: Record<string, { from: readonly (LifecycleState | null)[]; to: LifecycleState }> = {
  qualified: { from: [null, "sighted", "parked"], to: "qualified" },
  parked: { from: [null, "sighted", "qualified"], to: "parked" },
  outreach_sent: { from: [null, "sighted", "qualified", "parked", "nurturing"], to: "contacted" },
  replied: { from: ["contacted", "nurturing"], to: "engaged" },
  meeting_booked: { from: [null, "sighted", "qualified", "parked", "contacted", "nurturing"], to: "engaged" },
  sequence_exhausted: { from: ["contacted"], to: "nurturing" },
  unsubscribed: { from: [null, "sighted", "qualified", "parked", "contacted", "engaged", "nurturing"], to: "opted_out" },
  signed_up: { from: [null, ...PRE_SIGNUP_STATES], to: "signed_up" },
  activated: { from: ["signed_up", "stalled"], to: "activated" },
  stalled_check: { from: ["signed_up"], to: "stalled" },
  limit_reached: { from: ["signed_up", "stalled", "activated"], to: "at_wall" },
  subscribed: { from: [null, ...LIFECYCLE_STATES.filter((s) => s !== "paying" && s !== "deleted")], to: "paying" },
  "subscription_changed:up": { from: ["paying", "at_risk"], to: "expanding" },
  "subscription_changed:down": { from: ["expanding", "at_risk"], to: "paying" },
  payment_failed: { from: ["paying", "expanding"], to: "at_risk" },
  canceled: { from: ["paying", "expanding", "at_risk"], to: "churned" },
  recovered: { from: ["at_risk"], to: "paying" },
  user_deleted: { from: [null, ...LIFECYCLE_STATES.filter((s) => s !== "deleted")], to: "deleted" },
};

describe("the lifecycle table", () => {
  it("allows exactly the specified moves and no others", () => {
    const rows = transitionTable(LIFECYCLE_STATES);
    const expected: Array<{ from: LifecycleState | null; event: string; to: LifecycleState }> = [];
    for (const [event, spec] of Object.entries(EXPECTED)) for (const from of spec.from) expected.push({ from, event, to: spec.to });
    // dormant moves to two places, by where it starts.
    for (const from of ["paying", "expanding"] as const) expected.push({ from, event: "dormant", to: "at_risk" });
    for (const from of ["activated", "at_wall"] as const) expected.push({ from, event: "dormant", to: "stalled" });
    const key = (r: { from: LifecycleState | null; event: string; to: LifecycleState }) => `${r.from ?? "(none)"} -${r.event}-> ${r.to}`;
    expect(rows.map(key).sort()).toEqual(expected.map(key).sort());
  });

  it("treats a contact with no row as sighted, and never moves deleted", () => {
    expect(nextState(null, ev("qualified"))).toBe("qualified");
    expect(nextState(null, ev("replied"))).toBeNull();
    for (const kind of ["signed_up", "subscribed", "user_deleted", "recovered"] as const) expect(nextState("deleted", ev(kind))).toBeNull();
  });

  it("keeps a product user in their product state when they opt out, and an opted-out prospect out of a meeting", () => {
    for (const s of ["signed_up", "activated", "paying", "churned"] as const) expect(nextState(s, ev("unsubscribed"))).toBeNull();
    expect(nextState("opted_out", ev("meeting_booked"))).toBeNull();
    expect(nextState("opted_out", ev("signed_up"))).toBe("signed_up");
  });

  it("never reports staying put as a move", () => {
    expect(nextState("paying", ev("subscribed"))).toBeNull();
    expect(nextState("at_risk", ev("dormant"))).toBeNull();
    expect(nextState("stalled", ev("dormant"))).toBeNull();
  });

  it("sets first-time timestamps, warmth and deal stages from the state", () => {
    expect(firstTimeColumn("signed_up")).toBe("signed_up_at");
    expect(firstTimeColumn("activated")).toBe("activated_at");
    expect(firstTimeColumn("paying")).toBe("first_paid_at");
    expect(firstTimeColumn("expanding")).toBe("first_paid_at");
    expect(firstTimeColumn("churned")).toBe("churned_at");
    expect(firstTimeColumn("stalled")).toBeNull();
    expect(warmthFor("signed_up")).toBe("hot");
    expect(warmthFor("paying")).toBe("customer");
    expect(warmthFor("churned")).toBe("churned");
    expect(warmthFor("sighted")).toBeNull();
    expect(dealStageFor("signed_up")).toBe("trial");
    expect(dealStageFor("at_wall")).toBe("proposal");
    expect(dealStageFor("paying")).toBe("closed_won");
    expect(dealStageFor("expanding")).toBe("closed_won");
    expect(dealStageFor("churned")).toBe("closed_lost");
    expect(dealStageFor("activated")).toBeNull();
  });

  it("steps a deal one stage at a time, forward only", () => {
    expect(dealPath("prospecting", "trial")).toEqual(["contacted", "engaged", "demo_scheduled", "trial"]);
    expect(dealPath("demo_scheduled", "closed_won")).toEqual(["trial", "proposal", "negotiation", "closed_won"]);
    expect(dealPath("negotiation", "proposal")).toEqual([]);
    expect(dealPath("trial", "closed_lost")).toEqual(["closed_lost"]);
    expect(dealPath("closed_won", "closed_lost")).toEqual([]);
    expect(dealPath("closed_lost", "trial")).toEqual([]);
  });
});
