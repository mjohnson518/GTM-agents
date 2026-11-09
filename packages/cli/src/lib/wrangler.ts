// GTM-agents: how the CLI talks to Cloudflare. Every call goes through Wrangler (`npx --no-install wrangler ...`)
// by way of the injectable CommandRunner, so tests replace the network with a fake. This file also
// owns the environment flag, JSON output parsing, temporary files for bulk KV calls, and the short
// error line shown when Wrangler fails.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { CommandResult, CommandRunner } from "./io.ts";

/** Runs one Wrangler command in the deployment's directory. */
export type Wrangler = (args: string[]) => Promise<CommandResult>;

/**
 * --no-install: use the Wrangler the deployment installed (its package.json pins the version),
 * never a version npx would download on the fly.
 */
export function wranglerAt(runner: CommandRunner, cwd: string): Wrangler {
  return (args) => runner("npx", ["--no-install", "wrangler", ...args], { cwd });
}

/** The binding every flag, brain file and template lives under. */
export const KV_BINDING = "KV";
export const DB_BINDING = "DB";

/**
 * The Wrangler environment for an --env value: production (or no value) is the top level of
 * wrangler.jsonc; any other name is that block under "env".
 */
export function wranglerEnv(name: string | undefined): string | undefined {
  return name === undefined || name === "" || name === "production" ? undefined : name;
}

export function envArgs(env: string | undefined): string[] {
  return env ? ["--env", env] : [];
}

/** The environment's display name. */
export function envLabel(env: string | undefined): string {
  return env ?? "production";
}

/** Parse Wrangler's JSON output, tolerating lines Wrangler prints before the JSON. */
export function parseJsonOutput(stdout: string): unknown {
  const text = stripVTControlCharacters(stdout).trim();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const start = text.search(/^[[{]/m);
    if (start === -1) throw new Error("Wrangler printed no JSON");
    return JSON.parse(text.slice(start)) as unknown;
  }
}

/** The last meaningful line of a failed command's output, for an error message. */
export function failureLine(result: CommandResult): string {
  const lines = stripVTControlCharacters(`${result.stderr}\n${result.stdout}`)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/^[-=]+$/.test(l));
  const error = lines.find((l) => /\[ERROR\]|error/i.test(l));
  return (error ?? lines.at(-1) ?? `exit code ${result.code}`).slice(0, 300);
}

/**
 * Write `content` to a private file in a fresh directory under the OS temp dir, run `fn` with its
 * path, and delete the directory afterwards, whatever happens.
 */
export async function withTempFile<T>(name: string, content: string, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "gtm-"));
  try {
    const path = join(dir, name);
    writeFileSync(path, content, { mode: 0o600 });
    return await fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The API reads at most this many keys per bulk get. */
const BULK_GET_MAX = 100;

/**
 * Read keys from the deployment's remote KV namespace in bulk. A key that is not set comes back
 * as null. Throws when Wrangler fails or its output cannot be read, so each caller decides which
 * way to fail.
 */
export async function kvBulkGet(wrangler: Wrangler, keys: readonly string[], env: string | undefined): Promise<Map<string, string | null>> {
  const values = new Map<string, string | null>();
  for (let start = 0; start < keys.length; start += BULK_GET_MAX) {
    const chunk = keys.slice(start, start + BULK_GET_MAX);
    const result = await withTempFile("keys.json", JSON.stringify(chunk), (path) =>
      wrangler(["kv", "bulk", "get", path, "--binding", KV_BINDING, "--remote", ...envArgs(env)]),
    );
    if (result.code !== 0) throw new Error(`could not read KV: ${failureLine(result)}`);
    let parsed: unknown;
    try {
      parsed = parseJsonOutput(result.stdout);
    } catch {
      throw new Error("could not read the output of wrangler kv bulk get");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("unexpected output from wrangler kv bulk get");
    const record = parsed as Record<string, unknown>;
    for (const key of chunk) {
      const raw = Object.hasOwn(record, key) ? record[key] : null;
      const value = raw && typeof raw === "object" && "value" in raw ? raw.value : raw;
      values.set(key, value === null || value === undefined ? null : typeof value === "string" ? value : JSON.stringify(value));
    }
  }
  return values;
}

export interface KvEntry {
  key: string;
  value: string;
}

/** Write entries to the deployment's remote KV namespace in one bulk call. Throws on failure. */
export async function kvBulkPut(wrangler: Wrangler, entries: readonly KvEntry[], env: string | undefined): Promise<void> {
  if (entries.length === 0) return;
  const result = await withTempFile("entries.json", JSON.stringify(entries), (path) =>
    wrangler(["kv", "bulk", "put", path, "--binding", KV_BINDING, "--remote", ...envArgs(env)]),
  );
  if (result.code !== 0) throw new Error(failureLine(result));
}
