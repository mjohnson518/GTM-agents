// GTM-agents: `gtm flags`, which reads and writes feature flags in the deployment's remote KV
// namespace. Every key is checked against the flag registry (an exact key or a pattern family such
// as autonomy:<class>), and every value against the flag's kind, before anything is written.
// Autonomy for a permanently human-only action class can never be set above 1 here, or anywhere.
import { resolve } from "node:path";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { ACTION_CLASSES, isPermanentHuman } from "@gtm-agents/core/autonomy";
import { FLAGS, findFlag, type FlagDefinition } from "@gtm-agents/core/flags";
import { EXIT, confirmProductionWrite, spawnRunner, type CommandRunner, type Io } from "../lib/io.ts";
import { kvReadiness } from "../lib/wrangler-config.ts";
import { KV_BINDING, envArgs, envLabel, failureLine, kvBulkGet, kvBulkPut, parseJsonOutput, wranglerAt, wranglerEnv, type Wrangler } from "../lib/wrangler.ts";

export interface FlagsOptions {
  runner?: CommandRunner;
}

const USAGE = `Usage:
  gtm flags list                 [--config <dir>] [--env staging|production]
  gtm flags get <key>            [--config <dir>] [--env staging|production]
  gtm flags set <key> <value>    [--config <dir>] [--env staging|production] [--yes]
  gtm flags unset <key>          [--config <dir>] [--env staging|production] [--yes]`;

const TRUE_VALUES = new Set(["true", "on", "1", "yes"]);
const FALSE_VALUES = new Set(["false", "off", "0", "no"]);
const MAX_VALUE_BYTES = 16 * 1024;
const AUTONOMY_PREFIX = "autonomy:";

/**
 * Values the runtime accepts, beyond the kind. A value outside these would be read as an error at
 * runtime, which fails closed (a budget that cannot be read blocks every budgeted job), or would be
 * quietly clamped, so the CLI refuses it up front.
 */
const ALLOWED: Array<[RegExp, readonly string[]]> = [
  [/^budget:enforcement$/, ["soft", "hard"]],
  [/^verification:promotion_policy$/, ["strict", "allow_risky"]],
  [/^sequences:reply_intake$/, ["poll", "routed"]],
  [/^outreach:allocation_mode$/, ["weighted", "thompson"]],
  [/^outreach:min_email_confidence$/, ["high", "medium", "low"]],
  [/^classifier_tier:/, ["off", "shadow", "on"]],
];
/** Number flags that are shares rather than counts: [pattern, smallest, largest, smallest allowed exactly]. */
const SHARES: Array<[RegExp, number, number, boolean]> = [
  [/^budget:alert_threshold$/, 0, 1, false],
  [/^outreach:holdout_rate$/, 0, 0.2, true],
];

export type FlagValidation = { ok: true; definition: FlagDefinition; value: string } | { ok: false; error: string };

/** Check a key against the registry. */
export function validateFlagKey(key: string): { ok: true; definition: FlagDefinition } | { ok: false; error: string } {
  const definition = findFlag(key);
  if (!definition) return { ok: false, error: `"${key}" is not a known flag; gtm flags list shows every flag` };
  if (key.includes("<")) return { ok: false, error: `"${key}" is a pattern; name one flag, for example ${key.replace(/<[a-z_]+>/g, "example")}` };
  if (key.startsWith(AUTONOMY_PREFIX)) {
    const actionClass = key.slice(AUTONOMY_PREFIX.length);
    if (!(ACTION_CLASSES as readonly string[]).includes(actionClass)) {
      return { ok: false, error: `"${actionClass}" is not an action class; the classes are ${ACTION_CLASSES.join(", ")}` };
    }
  }
  return { ok: true, definition };
}

/** Check a value against the flag's kind and return the value to store. */
export function validateFlagValue(key: string, raw: string): FlagValidation {
  const known = validateFlagKey(key);
  if (!known.ok) return known;
  const { definition } = known;
  const value = raw.trim();
  if (value === "") return { ok: false, error: "the value is empty; use gtm flags unset to return a flag to its default" };
  if (new TextEncoder().encode(value).length > MAX_VALUE_BYTES) return { ok: false, error: `the value is larger than ${MAX_VALUE_BYTES} bytes` };

  if (key.startsWith(AUTONOMY_PREFIX)) {
    const actionClass = key.slice(AUTONOMY_PREFIX.length);
    if (!/^[0-3]$/.test(value)) return { ok: false, error: "an autonomy level is 0, 1, 2 or 3" };
    if (isPermanentHuman(actionClass) && Number(value) > 1) {
      return { ok: false, error: `${actionClass} is permanently human-only; its autonomy level can never be above 1` };
    }
    return { ok: true, definition, value };
  }
  switch (definition.kind) {
    case "boolean": {
      const lower = value.toLowerCase();
      if (TRUE_VALUES.has(lower)) return { ok: true, definition, value: "true" };
      if (FALSE_VALUES.has(lower)) return { ok: true, definition, value: "false" };
      return { ok: false, error: `${key} is a boolean flag: use true or false` };
    }
    case "number": {
      if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) return { ok: false, error: `${key} is a number flag: "${value}" is not a number of zero or more` };
      const share = SHARES.find(([pattern]) => pattern.test(key));
      const n = Number(value);
      if (share) {
        const [, min, max, minAllowed] = share;
        return (minAllowed ? n >= min : n > min) && n <= max ? { ok: true, definition, value } : { ok: false, error: `${key} is a share ${minAllowed ? "from" : "above"} ${min} ${minAllowed ? "to" : "and at most"} ${max}` };
      }
      return Number.isInteger(n) ? { ok: true, definition, value } : { ok: false, error: `${key} is a whole number` };
    }
    case "json": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return { ok: false, error: `${key} holds JSON, and "${value.slice(0, 60)}" does not parse; for example {"reason":"maintenance"}` };
      }
      // A bare true, false or number is a mistake here: any value of system:halt halts, "false" included.
      if (parsed === null || typeof parsed !== "object") return { ok: false, error: `${key} holds a JSON object, for example {"reason":"maintenance"}; to clear it, use gtm flags unset ${key}` };
      return { ok: true, definition, value };
    }
    case "string": {
      if (/[\r\n]/.test(value)) return { ok: false, error: "the value must be one line" };
      const allowed = ALLOWED.find(([pattern]) => pattern.test(key))?.[1];
      if (allowed && !allowed.includes(value)) return { ok: false, error: `${key} is one of ${allowed.join(", ")}` };
      return { ok: true, definition, value };
    }
  }
}

export async function flagsCommand(args: string[], io: Io, options: FlagsOptions = {}): Promise<number> {
  const [sub, ...rest] = args;
  let parsed;
  try {
    parsed = parseArgs({ args: rest, allowPositionals: true, options: { config: { type: "string" }, env: { type: "string" }, yes: { type: "boolean", default: false } } });
  } catch (err) {
    io.err(`gtm flags: ${(err as Error).message}`);
    io.err(USAGE);
    return EXIT.usage;
  }
  const positionals = parsed.positionals;
  const expected: Record<string, number> = { list: 0, get: 1, set: 2, unset: 1 };
  if (sub === undefined || !Object.hasOwn(expected, sub) || positionals.length !== expected[sub]) {
    io.err(USAGE);
    return EXIT.usage;
  }

  // Validate before touching Cloudflare.
  const key = positionals[0] ?? "";
  let value = "";
  if (sub === "set") {
    const checked = validateFlagValue(key, positionals[1] ?? "");
    if (!checked.ok) {
      io.err(`gtm flags: ${checked.error}`);
      return EXIT.usage;
    }
    value = checked.value;
  } else if (sub === "get" || sub === "unset") {
    const checked = validateFlagKey(key);
    if (!checked.ok) {
      io.err(`gtm flags: ${checked.error}`);
      return EXIT.usage;
    }
  }

  const dir = resolve(io.cwd, parsed.values.config ?? ".");
  const env = wranglerEnv(parsed.values.env);
  const ready = kvReadiness(dir, env);
  if (ready) {
    io.err(`gtm flags: ${ready}`);
    return EXIT.failed;
  }
  if (sub === "set" || sub === "unset") {
    const stop = await confirmProductionWrite(io, env, parsed.values.yes === true, `gtm flags ${sub}`, sub === "set" ? `set ${key} to ${value}` : `unset ${key}`);
    if (stop !== null) return stop;
  }
  const wrangler = wranglerAt(options.runner ?? spawnRunner, dir);
  try {
    switch (sub) {
      case "list":
        return await list(wrangler, env, io);
      case "get": {
        const current = (await kvBulkGet(wrangler, [key], env)).get(key) ?? null;
        const def = findFlag(key)?.default ?? null;
        io.out(current === null ? `${key} is unset (default: ${def ?? "unset"})` : `${key} = ${current}`);
        return EXIT.ok;
      }
      case "set":
        await kvBulkPut(wrangler, [{ key, value }], env);
        io.out(`${key} = ${value} (${envLabel(env)}); KV can take up to a minute to reach every location`);
        return EXIT.ok;
      default: {
        const result = await wrangler(["kv", "key", "delete", key, "--binding", KV_BINDING, "--remote", ...envArgs(env)]);
        if (result.code !== 0) throw new Error(failureLine(result));
        io.out(`${key} is unset (${envLabel(env)}); it now uses its default: ${findFlag(key)?.default ?? "unset"}`);
        return EXIT.ok;
      }
    }
  } catch (err) {
    io.err(`gtm flags: ${(err as Error).message}`);
    return EXIT.failed;
  }
}

async function list(wrangler: Wrangler, env: string | undefined, io: Io): Promise<number> {
  const result = await wrangler(["kv", "key", "list", "--binding", KV_BINDING, "--remote", ...envArgs(env)]);
  if (result.code !== 0) throw new Error(`could not list KV keys: ${failureLine(result)}`);
  let names: string[];
  try {
    const parsed = parseJsonOutput(stripVTControlCharacters(result.stdout));
    if (!Array.isArray(parsed)) throw new Error("not a list");
    names = parsed.map((k) => String((k as { name?: unknown }).name));
  } catch {
    throw new Error("could not read the output of wrangler kv key list");
  }
  const flagKeys = names.filter((n) => findFlag(n) !== undefined).sort();
  const values = await kvBulkGet(wrangler, flagKeys, env);

  io.out(`gtm flags: ${envLabel(env)} (unset flags use their default)`);
  const width = Math.max(...FLAGS.map((f) => f.key.length), ...flagKeys.map((k) => k.length + 2));
  io.out(`  ${"flag".padEnd(width)}  ${"default".padEnd(8)}  value`);
  for (const f of FLAGS) {
    if (!f.key.includes("<")) {
      const v = values.get(f.key);
      io.out(`  ${f.key.padEnd(width)}  ${(f.default ?? "unset").padEnd(8)}  ${v === undefined || v === null ? "unset" : oneLine(v)}`);
      continue;
    }
    io.out(`  ${f.key.padEnd(width)}  ${(f.default ?? "unset").padEnd(8)}`);
    for (const k of flagKeys.filter((k) => !FLAGS.some((g) => g.key === k) && findFlag(k) === f)) {
      io.out(`    ${k.padEnd(width - 2)}  ${"".padEnd(8)}  ${oneLine(values.get(k) ?? "unset")}`);
    }
  }
  return EXIT.ok;
}

function oneLine(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}
