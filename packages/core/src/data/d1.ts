// GTM-agents: helpers for D1 queries.

/** D1 binds at most 100 parameters per statement. */
export const D1_MAX_BINDINGS = 100;

/**
 * Split `values` into chunks that fit one statement, given how many parameters each value uses
 * (`perValue`) and how many the statement binds besides them (`reserved`).
 */
export function inChunks<T>(values: readonly T[], options: { perValue?: number; reserved?: number } = {}): T[][] {
  const perValue = Math.max(1, options.perValue ?? 1);
  const size = Math.max(1, Math.floor((D1_MAX_BINDINGS - (options.reserved ?? 0)) / perValue));
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

/** Numbered placeholders ?start, ?start+1, ... for `count` values. */
export function placeholders(count: number, start = 1): string {
  return Array.from({ length: count }, (_, i) => `?${start + i}`).join(", ");
}
