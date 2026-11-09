// GTM-agents: `gtm deploy`, the one command between a checked deployment and a running one:
//   1. gtm doctor, offline: any FAIL stops the deploy;
//   2. every ${...} placeholder must be filled in (gtm setup does that);
//   3. gtm migrate: the D1 migrations are applied before the new code runs; a failure stops;
//   4. gtm brain diff: a warning, not a stop, when the uploaded brain or templates differ from
//      the local ones;
//   5. wrangler deploy.
// With --dry-run nothing is changed: it runs the checks, lists the pending migrations, and bundles
// the Worker with `wrangler deploy --dry-run`.
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { EXIT, confirmProductionWrite, spawnRunner, type CommandRunner, type Io } from "../lib/io.ts";
import { locateBrain } from "../lib/project.ts";
import { DEFAULT_ADAPTERS_DIR } from "../lib/secrets.ts";
import { environmentPlaceholders, loadWranglerConfig } from "../lib/wrangler-config.ts";
import { envArgs, envLabel, failureLine, wranglerAt, wranglerEnv } from "../lib/wrangler.ts";
import { buildBundle, differs, printDiffs, remoteDiff } from "./brain.ts";
import { doctorCommand } from "./doctor.ts";
import { applyMigrations, listPendingMigrations } from "./migrate.ts";

export interface DeployOptions {
  runner?: CommandRunner;
  adaptersDir?: string;
}

const USAGE = "Usage: gtm deploy [--config <dir>] [--env staging|production] [--dry-run] [--yes]";

export async function deployCommand(args: string[], io: Io, options: DeployOptions = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, options: { config: { type: "string" }, env: { type: "string" }, "dry-run": { type: "boolean", default: false }, yes: { type: "boolean", default: false } } });
  } catch (err) {
    io.err(`gtm deploy: ${(err as Error).message}`);
    io.err(USAGE);
    return EXIT.usage;
  }
  const runner = options.runner ?? spawnRunner;
  const dir = resolve(io.cwd, parsed.values.config ?? ".");
  const env = wranglerEnv(parsed.values.env);
  const dryRun = parsed.values["dry-run"] === true;
  const step = (n: number, what: string) => io.out(`\n[${n}/5] ${what}`);

  step(1, "gtm doctor");
  const doctorArgs = ["--config", dir, ...envArgs(env)];
  if ((await doctorCommand(doctorArgs, io, { runner, adaptersDir: options.adaptersDir ?? DEFAULT_ADAPTERS_DIR })) !== EXIT.ok) {
    io.err("gtm deploy: gtm doctor reported a FAIL; fix it first. Nothing was deployed.");
    return EXIT.failed;
  }

  step(2, "placeholders");
  let placeholders: string[];
  try {
    placeholders = environmentPlaceholders(loadWranglerConfig(dir, env));
  } catch (err) {
    io.err(`gtm deploy: ${(err as Error).message}`);
    return EXIT.failed;
  }
  const resourcesReady = placeholders.length === 0;
  if (!resourcesReady) {
    const message = `${placeholders.length} value(s) in wrangler.jsonc still hold placeholders (${placeholders.slice(0, 3).join(", ")}${placeholders.length > 3 ? ", ..." : ""}); run gtm setup${env ? ` --env ${env}` : ""}`;
    if (!dryRun) {
      io.err(`gtm deploy: ${message}. Nothing was deployed.`);
      return EXIT.failed;
    }
    io.out(`${message}. The dry run skips the migration and brain checks, which need real resources.`);
  } else {
    io.out("every resource id and name is filled in");
  }

  if (!dryRun) {
    const stop = await confirmProductionWrite(io, env, parsed.values.yes === true, "gtm deploy", "apply the migrations and deploy the Worker");
    if (stop !== null) return stop;
  }

  step(3, dryRun ? "pending migrations" : "gtm migrate");
  if (resourcesReady) {
    const target = { dir, env, local: false };
    const ok = dryRun ? await listPendingMigrations(target, runner, io) : await applyMigrations(target, runner, io);
    if (!ok) {
      io.err(`gtm deploy: ${dryRun ? "could not list the migrations" : "the migrations did not apply"}. Nothing was deployed.`);
      return EXIT.failed;
    }
  }

  step(4, "gtm brain diff");
  if (resourcesReady) await brainCheck(dir, env, runner, io);

  step(5, dryRun ? "wrangler deploy --dry-run" : "wrangler deploy");
  const result = await wranglerAt(runner, dir)(["deploy", ...envArgs(env), ...(dryRun ? ["--dry-run"] : [])]);
  const report = stripVTControlCharacters(result.stdout).trim();
  if (report) io.out(report);
  if (result.code !== 0) {
    io.err(`gtm deploy: wrangler deploy failed: ${failureLine(result)}`);
    return EXIT.failed;
  }
  io.out(
    dryRun
      ? `\ngtm deploy: dry run passed for ${envLabel(env)}; nothing was changed.`
      : `\ngtm deploy: deployed ${envLabel(env)}. Verify with: npx gtm doctor --remote${env ? ` --env ${env}` : ""}, then GET /health on your Worker.`,
  );
  return EXIT.ok;
}

/** Warn, never stop, when the uploaded brain or templates differ from the local folders. */
async function brainCheck(dir: string, env: string | undefined, runner: CommandRunner, io: Io): Promise<void> {
  const loc = locateBrain(dir, undefined, undefined);
  if (!existsSync(loc.brainDir) || !statSync(loc.brainDir).isDirectory()) {
    io.out("no brain/ folder in the deployment; skipped");
    return;
  }
  try {
    const bundle = await buildBundle(loc, undefined, [dir]);
    if (bundle.issues.some((i) => i.severity === "error")) io.out("WARN  the local brain or templates have errors; run gtm brain validate");
    const diffs = await remoteDiff(wranglerAt(runner, dir), env, bundle);
    printDiffs(io, diffs);
    if (diffs.some(differs)) io.out(`WARN  the uploaded brain or templates differ from the local ones; run gtm brain upload${env ? ` --env ${env}` : ""} when they are ready`);
  } catch (err) {
    io.out(`WARN  could not compare the uploaded brain and templates: ${(err as Error).message}`);
  }
}
