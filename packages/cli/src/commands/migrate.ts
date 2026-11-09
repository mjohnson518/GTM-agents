// GTM-agents: `gtm migrate`, which applies the D1 migrations to the deployment's DB binding through
// `wrangler d1 migrations apply`. Before it asks Wrangler, it checks that the migrations directory
// exists and that its files are numbered 0001, 0002, ... with no gaps or duplicates, because D1
// applies them in file-name order and records which ran. Remote by default; --local applies them to
// the local database `wrangler dev` uses.
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { EXIT, confirmProductionWrite, spawnRunner, type CommandRunner, type Io } from "../lib/io.ts";
import { d1Binding, isFilled, loadWranglerConfig } from "../lib/wrangler-config.ts";
import { DB_BINDING, envArgs, envLabel, failureLine, wranglerAt, wranglerEnv } from "../lib/wrangler.ts";

export interface MigrateOptions {
  runner?: CommandRunner;
}

const USAGE = "Usage: gtm migrate [--config <dir>] [--env staging|production] [--local] [--yes]";
const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** Problems with a migrations directory's file names: bad names, duplicate numbers and gaps. */
export function migrationNameProblems(names: readonly string[]): string[] {
  const problems: string[] = [];
  const seen = new Map<number, string>();
  for (const name of names.filter((n) => n.endsWith(".sql")).sort()) {
    const m = NAME.exec(name);
    if (!m) {
      problems.push(`${name}: migration names look like 0001_create_contacts.sql`);
      continue;
    }
    const num = Number(m[1]);
    const prior = seen.get(num);
    if (prior) problems.push(`${name}: number ${m[1]} is also used by ${prior}`);
    seen.set(num, name);
  }
  [...seen.keys()]
    .sort((a, b) => a - b)
    .forEach((num, i) => {
      if (num !== i + 1) problems.push(`${seen.get(num) ?? num}: expected migration ${String(i + 1).padStart(4, "0")} before this one`);
    });
  if (seen.size === 0 && problems.length === 0) problems.push("no .sql migrations were found");
  return problems;
}

export interface MigrateTarget {
  dir: string;
  env: string | undefined;
  local: boolean;
}

/** Check the DB binding and the migrations directory. Returns an error message, or null when ready. */
export function migrationReadiness(target: MigrateTarget): string | null {
  let loaded;
  try {
    loaded = loadWranglerConfig(target.dir, target.env);
  } catch (err) {
    return (err as Error).message;
  }
  const db = d1Binding(loaded.config, DB_BINDING);
  if (!db) return `wrangler config declares no D1 binding named ${DB_BINDING}`;
  if (!target.local && !isFilled(db.database_id)) return `the ${DB_BINDING} binding has no database id yet; run gtm setup${target.env ? ` --env ${target.env}` : ""} first`;
  const migrationsDir = resolve(dirname(loaded.path), typeof db.migrations_dir === "string" ? db.migrations_dir : "migrations");
  if (!existsSync(migrationsDir) || !statSync(migrationsDir).isDirectory()) {
    return `the migrations directory ${relative(target.dir, migrationsDir) || migrationsDir} does not exist (run npm install so @gtm-agents/core is installed)`;
  }
  const problems = migrationNameProblems(readdirSync(migrationsDir));
  return problems.length ? `the migrations are out of order: ${problems.join("; ")}` : null;
}

/** Apply the migrations. Prints Wrangler's report. Returns true on success. */
export async function applyMigrations(target: MigrateTarget, runner: CommandRunner, io: Io): Promise<boolean> {
  const notReady = migrationReadiness(target);
  if (notReady) {
    io.err(`gtm migrate: ${notReady}`);
    return false;
  }
  const result = await wranglerAt(runner, target.dir)(["d1", "migrations", "apply", DB_BINDING, target.local ? "--local" : "--remote", ...envArgs(target.env)]);
  const report = stripVTControlCharacters(result.stdout).trim();
  if (report) io.out(report);
  if (result.code !== 0) {
    io.err(`gtm migrate: wrangler d1 migrations apply failed: ${failureLine(result)}`);
    return false;
  }
  io.out(`gtm migrate: ${target.local ? "local" : envLabel(target.env)} database is up to date`);
  return true;
}

/** List the migrations not yet applied to the remote database, without applying anything. */
export async function listPendingMigrations(target: MigrateTarget, runner: CommandRunner, io: Io): Promise<boolean> {
  const notReady = migrationReadiness(target);
  if (notReady) {
    io.err(`gtm migrate: ${notReady}`);
    return false;
  }
  const result = await wranglerAt(runner, target.dir)(["d1", "migrations", "list", DB_BINDING, target.local ? "--local" : "--remote", ...envArgs(target.env)]);
  const report = stripVTControlCharacters(result.stdout).trim();
  if (report) io.out(report);
  if (result.code !== 0) {
    io.err(`gtm migrate: wrangler d1 migrations list failed: ${failureLine(result)}`);
    return false;
  }
  return true;
}

export async function migrateCommand(args: string[], io: Io, options: MigrateOptions = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, options: { config: { type: "string" }, env: { type: "string" }, local: { type: "boolean", default: false }, yes: { type: "boolean", default: false } } });
  } catch (err) {
    io.err(`gtm migrate: ${(err as Error).message}`);
    io.err(USAGE);
    return EXIT.usage;
  }
  const target: MigrateTarget = { dir: resolve(io.cwd, parsed.values.config ?? "."), env: wranglerEnv(parsed.values.env), local: parsed.values.local === true };
  const notReady = migrationReadiness(target);
  if (notReady) {
    io.err(`gtm migrate: ${notReady}`);
    return EXIT.failed;
  }
  if (!target.local) {
    const stop = await confirmProductionWrite(io, target.env, parsed.values.yes === true, "gtm migrate", "apply the D1 migrations");
    if (stop !== null) return stop;
  }
  return (await applyMigrations(target, options.runner ?? spawnRunner, io)) ? EXIT.ok : EXIT.failed;
}
