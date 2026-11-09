// GTM-agents: monthly recurring revenue for one contact, from what a billing event says.
//
// MRR is the amount the event carries, in the currency's minor unit (cents), turned monthly by its
// interval; when the event carries no usable amount, the plan's list price; when neither is known,
// nothing is written. List prices come from the deployment's wiring (monthly cents per plan name),
// never from code. They also decide whether a plan change is an upgrade or a downgrade: a change
// between plans whose prices are unknown or equal moves no state, only the stored plan. MRR assumes
// the deployment bills in one currency.

export type PriceList = Readonly<Record<string, number>>;

const MONTHS_PER: Record<string, number> = { month: 1, monthly: 1, year: 1 / 12, yearly: 1 / 12, annual: 1 / 12, week: 52 / 12, weekly: 52 / 12, day: 365 / 12, daily: 365 / 12 };

/** An amount in cents, per its interval, as monthly cents; null for an amount or interval it cannot read. Pure. */
export function monthlyCents(amount: unknown, interval: unknown): number | null {
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0 || amount > 1_000_000_000) return null;
  const key = typeof interval === "string" ? interval.trim().toLowerCase() : "month";
  const factor = MONTHS_PER[key];
  return factor === undefined ? null : Math.round(amount * factor);
}

/** The list price of a plan in monthly cents, or null. Plan names compare case-insensitively. Pure. */
export function listPrice(prices: PriceList | undefined, plan: string | null | undefined): number | null {
  if (!prices || !plan) return null;
  const wanted = plan.trim().toLowerCase();
  for (const [name, cents] of Object.entries(prices)) {
    if (name.trim().toLowerCase() === wanted && Number.isInteger(cents) && cents >= 0) return cents;
  }
  return null;
}

/** "up", "down", or null when either price is unknown or they are equal. Pure. */
export function planDirection(prices: PriceList | undefined, fromPlan: string | null | undefined, toPlan: string | null | undefined): "up" | "down" | null {
  const from = listPrice(prices, fromPlan);
  const to = listPrice(prices, toPlan);
  if (from === null || to === null || from === to) return null;
  return to > from ? "up" : "down";
}

/** "up" or "down" from two monthly amounts, or null when either is unknown or they are equal. Pure. */
export function mrrDirection(before: number | null | undefined, after: number | null | undefined): "up" | "down" | null {
  if (typeof before !== "number" || typeof after !== "number" || before === after) return null;
  return after > before ? "up" : "down";
}
