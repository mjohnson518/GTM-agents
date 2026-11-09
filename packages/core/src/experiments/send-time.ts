// GTM-agents: the send-time test: recipient-local early morning against early afternoon.
//
// Behind outreach:send_time_experiment. Each cold first touch's unit (its account, as in
// assignment.ts) is assigned a slot, early (08:00 to 10:00 recipient-local) or afternoon (13:00 to
// 15:00), within its time-zone stratum: in each stratum the new units are taken in salted-hash order
// and dealt alternately from a seeded starting slot, so the two slots stay balanced zone by zone. A
// pinned unit keeps its slot. The slot is recorded against the draft (send_slot_schedules), and the
// send function narrows the recipient's send window to the slot (sending/boundary.ts), deferring the
// message until it opens; the slot never widens the configured window. When the configured window
// does not overlap both slots, the test plans nothing (slotsFitWindow). Outcomes are read per slot
// from the ledger (metrics/experiments.ts sendSlotSamples).
import type { Uniform } from "../metrics/index.ts";
import { hashOrder } from "./hash.ts";

export const SEND_TIME_TEST_ID = "send_time";
export const SEND_SLOTS = ["early", "afternoon"] as const;
export type SendSlot = (typeof SEND_SLOTS)[number];

export const SLOT_HOURS: Readonly<Record<SendSlot, { startHour: number; endHour: number }>> = Object.freeze({
  early: { startHour: 8, endHour: 10 },
  afternoon: { startHour: 13, endHour: 15 },
});

export function isSendSlot(value: unknown): value is SendSlot {
  return typeof value === "string" && (SEND_SLOTS as readonly string[]).includes(value);
}

export interface SlotUnit {
  unit: string;
  timezone: string;
}

/**
 * Each unit's slot: pinned ones keep theirs; new ones alternate within their time zone in salted
 * order, starting from a seeded slot. Pure given the generator.
 */
export function planSlots(units: readonly SlotUnit[], pins: ReadonlyMap<string, string>, seed: string, rng: Uniform): Map<string, { slot: SendSlot; timezone: string; isNew: boolean }> {
  const out = new Map<string, { slot: SendSlot; timezone: string; isNew: boolean }>();
  const strata = new Map<string, string[]>();
  for (const u of units) {
    if (out.has(u.unit)) continue;
    const pinned = pins.get(u.unit);
    if (isSendSlot(pinned)) {
      out.set(u.unit, { slot: pinned, timezone: u.timezone, isNew: false });
      continue;
    }
    const list = strata.get(u.timezone) ?? [];
    list.push(u.unit);
    strata.set(u.timezone, list);
  }
  for (const zone of [...strata.keys()].sort()) {
    const ordered = hashOrder(strata.get(zone) ?? [], `${seed}:${zone}`);
    let next = rng() < 0.5 ? 0 : 1;
    for (const unit of ordered) {
      if (out.has(unit)) continue;
      out.set(unit, { slot: SEND_SLOTS[next] ?? "early", timezone: zone, isNew: true });
      next = 1 - next;
    }
  }
  return out;
}

/**
 * The window a slot sends in: the slot's hours inside the configured window. When they do not
 * overlap, the configured window is kept, so a slot can never send outside it. Pure.
 */
export function slotWindow<W extends { startHour: number; endHour: number }>(window: W, slot: SendSlot): W {
  const hours = SLOT_HOURS[slot] as { startHour: number; endHour: number } | undefined;
  if (!hours) return window;
  const start = Math.max(window.startHour, hours.startHour);
  const end = Math.min(window.endHour, hours.endHour);
  return end > start ? { ...window, startHour: start, endHour: end } : window;
}

/**
 * True when both slots overlap the configured window. Otherwise the test is not run at all: a slot
 * that kept the whole window would be credited as early or afternoon while sending at any hour.
 * Pure.
 */
export function slotsFitWindow(window: { startHour: number; endHour: number }): boolean {
  return SEND_SLOTS.every((slot) => {
    const hours = SLOT_HOURS[slot];
    return Math.min(window.endHour, hours.endHour) > Math.max(window.startHour, hours.startHour);
  });
}
