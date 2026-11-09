// GTM-agents: the salted hash experiments order units by. Pure, with no imports, so the send path
// can use the send-time test's helpers without loading the rest of the experiments module.

/** A 32-bit FNV-1a hash of salt and unit, for ordering. Pure. */
export function saltedHash(salt: string, unit: string): number {
  let h = 0x811c9dc5;
  const s = `${salt}\u0000${unit}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Units in salted-hash order, each once. Pure. */
export function hashOrder(units: readonly string[], salt: string): string[] {
  return [...new Set(units)].sort((a, b) => saltedHash(salt, a) - saltedHash(salt, b) || (a < b ? -1 : 1));
}
