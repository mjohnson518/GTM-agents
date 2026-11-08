// GTM-agents: the brain lock file. A component is served only when the SHA-256 of its exact bytes
// matches its entry here, so what reaches a prompt is always what the operator approved.
import { z } from "zod";
import { sha256Hex } from "../shared/hash.ts";

export const lockSchema = z.strictObject({
  version: z.literal(1),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  files: z.record(z.string().regex(/^[a-z-]+\.md$/), z.string().regex(/^[0-9a-f]{64}$/)),
});
export type BrainLock = z.output<typeof lockSchema>;

export { sha256Hex };

/** Build the lock for a set of approved files. */
export async function computeLock(files: Array<{ name: string; content: string }>): Promise<BrainLock> {
  const entries = await Promise.all(files.map(async (f) => [f.name, await sha256Hex(f.content)] as const));
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = await sha256Hex(entries.map(([name, h]) => `${name} ${h}\n`).join(""));
  return { version: 1, hash, files: Object.fromEntries(entries) };
}

/** Parse a lock file's JSON text. Returns null when it is missing or malformed. */
export function parseLock(text: string | null | undefined): BrainLock | null {
  if (!text) return null;
  try {
    const parsed = lockSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function serializeLock(lock: BrainLock): string {
  const files = Object.fromEntries(Object.entries(lock.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `${JSON.stringify({ version: lock.version, hash: lock.hash, files }, null, 2)}\n`;
}

/** The brain version shown in prompts: the first 12 hex characters of the lock hash. */
export function brainVersion(lock: BrainLock | null): string {
  return lock ? lock.hash.slice(0, 12) : "unlocked";
}
