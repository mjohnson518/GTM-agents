// GTM-agents: `gtm brain`, for the brain and templates.
//   validate  checks a brain and its templates against the schema, the per-task byte budgets and
//             the lock file, and can write the lock;
//   upload    validates, then writes the approved files and their locks to the deployment's KV
//             namespace under the keys the runtime reads (brain:file:<component>, brain:lock,
//             template:file:<id>, templates:lock). Files go first and the locks last, in a second
//             call: the loader serves a file only when its bytes hash to the lock, so an upload that
//             stops halfway is never served half-written;
//   diff      compares the local locks with the uploaded ones and names what differs.
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  BRAIN_LOCK_KEY,
  LOCK_FILE,
  brainFileKey,
  computeLock,
  parseLock,
  serializeLock,
  validateBrain,
  type BrainFileInput,
  type BrainLock,
  type ComponentId,
  type Issue,
} from "@gtm-agents/core/brain";
import { TEMPLATES_LOCK_KEY, computeTemplateLock, parseTemplateLock, templateFileKey, validateTemplates, type TemplateFile, type TemplateLock } from "@gtm-agents/core/templates";
import { EXIT, confirmProductionWrite, spawnRunner, type CommandRunner, type Io } from "../lib/io.ts";
import { loadDeploymentConfig, locateBrain, readFlatDir, type BrainLocation } from "../lib/project.ts";
import { findWranglerConfig, kvReadiness } from "../lib/wrangler-config.ts";
import { envLabel, kvBulkGet, kvBulkPut, wranglerAt, wranglerEnv, type KvEntry, type Wrangler } from "../lib/wrangler.ts";

export interface BrainOptions {
  runner?: CommandRunner;
}

const USAGE = `Usage:
  gtm brain validate [dir] [--templates <dir>] [--domain <domain>] [--write-lock]
  gtm brain upload   [dir] [--templates <dir>] [--domain <domain>] [--config <dir>] [--env staging|production] [--dry-run] [--yes]
  gtm brain diff     [dir] [--templates <dir>] [--domain <domain>] [--config <dir>] [--env staging|production]`;

export async function brainCommand(args: string[], io: Io, options: BrainOptions = {}): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "validate") return validate(rest, io);
  if (sub === "upload" || sub === "diff") return remote(sub, rest, io, options.runner ?? spawnRunner);
  io.err(USAGE);
  return EXIT.usage;
}

async function validate(args: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: { templates: { type: "string" }, domain: { type: "string" }, "write-lock": { type: "boolean", default: false } },
    });
  } catch (err) {
    io.err(`gtm brain validate: ${(err as Error).message}`);
    io.err(USAGE);
    return EXIT.usage;
  }
  const { brainDir, templatesDir, configDir } = locateBrain(io.cwd, parsed.positionals[0], parsed.values.templates);
  if (!existsSync(brainDir) || !statSync(brainDir).isDirectory()) {
    io.err(`gtm brain validate: ${brainDir} is not a directory`);
    return EXIT.usage;
  }
  const show = (p: string) => relative(io.cwd, p) || ".";
  const files = readFlatDir(brainDir);
  const lockFile = files.find((f) => f.name === LOCK_FILE);
  const lock = parseLock(lockFile?.content);
  const issues: Issue[] = [];
  if (lockFile && !lock) issues.push({ severity: "error", file: LOCK_FILE, line: 0, message: "the lock file is malformed; regenerate it with --write-lock" });

  const writeLock = parsed.values["write-lock"] === true;
  let result = await validateBrain(files, writeLock ? {} : { lock });
  if (writeLock && result.ok) {
    const fresh = await computeLock(result.approved);
    writeFileSync(join(brainDir, LOCK_FILE), serializeLock(fresh));
    io.out(`wrote ${show(join(brainDir, LOCK_FILE))} (${result.approved.length} approved component(s), version ${fresh.hash.slice(0, 12)})`);
    result = await validateBrain(files, { lock: fresh });
  }
  issues.push(...result.issues);

  const domain = await companyDomain(parsed.values.domain, [configDir], issues);
  let templateCount = 0;
  if (templatesDir) {
    const templates = validateTemplates(readFlatDir(templatesDir), domain ? { companyDomain: domain } : {});
    templateCount = templates.parsed.length;
    issues.push(...templates.issues.map((i) => ({ ...i, file: `${relative(brainDir, templatesDir) || "templates"}/${i.file}` })));
  }

  const errors = printIssues(io, issues);
  const warnings = issues.filter((i) => i.severity === "warning");
  const components = result.parsed.filter((p) => p.component).length;
  io.out(
    `gtm brain validate: ${show(brainDir)}: ${components} component(s), ${templateCount} template(s), ${errors} error(s), ${warnings.length} warning(s)${
      lock && !writeLock ? `, version ${lock.hash.slice(0, 12)}` : ""
    }`,
  );
  return errors ? EXIT.failed : EXIT.ok;
}

/** The company domain for template link checks: --domain, else gtm.config.ts in the first directory that has one. */
async function companyDomain(flag: string | undefined, dirs: string[], issues: Issue[]): Promise<string | undefined> {
  if (flag) return flag;
  for (const dir of dirs) {
    try {
      const domain = (await loadDeploymentConfig(dir))?.company.domain;
      if (domain) return domain;
    } catch {
      issues.push({ severity: "warning", file: "gtm.config.ts", line: 0, message: "could not load gtm.config.ts, so template links are not checked against the company domain" });
      return undefined;
    }
  }
  return undefined;
}

function printIssues(io: Io, issues: Issue[]): number {
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  for (const i of [...errors, ...warnings]) io.out(`${i.severity === "error" ? "ERROR" : "WARN "} ${i.file}${i.line ? `:${i.line}` : ""}  ${i.message}`);
  return errors.length;
}

/** What an upload would write, built from the local files. */
export interface Bundle {
  issues: Issue[];
  /** Null when there is no brain to upload (no lock and nothing approved). */
  brain: { files: BrainFileInput[]; lock: BrainLock } | null;
  /** Null when there is no templates folder. */
  templates: { files: TemplateFile[]; lock: TemplateLock } | null;
}

/**
 * Validate the local brain and templates and build the bundle an upload writes. Errors land in
 * `issues`: a malformed lock, an approved brain with no lock, any validation error, or templates
 * whose links cannot be checked because the company domain is unknown.
 */
export async function buildBundle(loc: BrainLocation, domainFlag: string | undefined, configDirs: string[]): Promise<Bundle> {
  const issues: Issue[] = [];
  const files = readFlatDir(loc.brainDir);
  const lockFile = files.find((f) => f.name === LOCK_FILE);
  const diskLock = parseLock(lockFile?.content);
  if (lockFile && !diskLock) issues.push({ severity: "error", file: LOCK_FILE, line: 0, message: "the lock file is malformed; regenerate it with gtm brain validate --write-lock" });
  const result = await validateBrain(files, { lock: diskLock });
  issues.push(...result.issues);

  let brain: Bundle["brain"] = null;
  if (result.approved.length > 0 || diskLock) {
    const lock = await computeLock(result.approved);
    if (!diskLock) {
      issues.push({ severity: "error", file: LOCK_FILE, line: 0, message: "there is no lock file, so nothing would be served; review the brain, then run gtm brain validate --write-lock" });
    } else if (lock.hash !== diskLock.hash || parseLock(serializeLock(lock)) === null) {
      issues.push({ severity: "error", file: LOCK_FILE, line: 0, message: "the lock file does not match the approved files; review them, then run gtm brain validate --write-lock" });
    }
    brain = { files: result.approved, lock };
  }

  let templates: Bundle["templates"] = null;
  if (loc.templatesDir) {
    const prefix = relative(loc.brainDir, loc.templatesDir) || "templates";
    const domain = await companyDomain(domainFlag, configDirs, issues);
    const templateFiles = readFlatDir(loc.templatesDir);
    const checked = validateTemplates(templateFiles, domain ? { companyDomain: domain } : {});
    issues.push(...checked.issues.map((i) => ({ ...i, file: `${prefix}/${i.file}` })));
    if (!domain && checked.parsed.length > 0) {
      issues.push({ severity: "error", file: `${prefix}/`, line: 0, message: "the company domain is unknown, so template links cannot be checked the way the runtime checks them; pass --domain or run from the deployment directory" });
    }
    const approvedNames = new Set(checked.parsed.filter((p) => p.meta?.status === "approved" && !p.issues.some((i) => i.severity === "error")).map((p) => p.file));
    const approved = templateFiles.filter((f) => approvedNames.has(f.name));
    const lock = await computeTemplateLock(approved);
    if (parseTemplateLock(JSON.stringify(lock)) === null) issues.push({ severity: "error", file: `${prefix}/`, line: 0, message: "the template lock would not parse at runtime; check the template file names" });
    templates = { files: approved, lock };
  }
  return { issues, brain, templates };
}

/** The KV entries for a bundle: the files, then (separately) the locks. */
export function bundleEntries(bundle: Bundle): { files: KvEntry[]; locks: KvEntry[] } {
  const files: KvEntry[] = [];
  const locks: KvEntry[] = [];
  if (bundle.brain) {
    for (const f of bundle.brain.files) files.push({ key: brainFileKey(f.name.replace(/\.md$/, "") as ComponentId), value: f.content });
    locks.push({ key: BRAIN_LOCK_KEY, value: serializeLock(bundle.brain.lock) });
  }
  if (bundle.templates) {
    for (const f of bundle.templates.files) files.push({ key: templateFileKey(f.name.replace(/\.md$/, "")), value: f.content });
    locks.push({ key: TEMPLATES_LOCK_KEY, value: JSON.stringify(bundle.templates.lock) });
  }
  return { files, locks };
}

export interface LockDiff {
  what: "brain" | "templates";
  /** Null when nothing is uploaded yet. */
  remoteVersion: string | null;
  localVersion: string | null;
  changed: string[];
  added: string[];
  removed: string[];
}

/** Compare a local lock's entries with the uploaded lock's. */
export function diffLocks(what: LockDiff["what"], local: { hash: string; files: Record<string, string> } | null, remote: { hash: string; files: Record<string, string> } | null): LockDiff {
  const l = local?.files ?? {};
  const r = remote?.files ?? {};
  return {
    what,
    remoteVersion: remote ? remote.hash.slice(0, 12) : null,
    localVersion: local ? local.hash.slice(0, 12) : null,
    changed: Object.keys(l).filter((k) => Object.hasOwn(r, k) && r[k] !== l[k]).sort(),
    added: Object.keys(l).filter((k) => !Object.hasOwn(r, k)).sort(),
    removed: Object.keys(r).filter((k) => !Object.hasOwn(l, k)).sort(),
  };
}

export const differs = (d: LockDiff): boolean => d.changed.length + d.added.length + d.removed.length > 0 || d.localVersion !== d.remoteVersion;

/** Read the uploaded locks and compare them with the bundle. Throws when KV cannot be read. */
export async function remoteDiff(wrangler: Wrangler, env: string | undefined, bundle: Bundle): Promise<LockDiff[]> {
  const keys = [...(bundle.brain ? [BRAIN_LOCK_KEY] : []), ...(bundle.templates ? [TEMPLATES_LOCK_KEY] : [])];
  if (keys.length === 0) return [];
  const values = await kvBulkGet(wrangler, keys, env);
  const diffs: LockDiff[] = [];
  if (bundle.brain) diffs.push(diffLocks("brain", bundle.brain.lock, parseLock(values.get(BRAIN_LOCK_KEY) ?? null)));
  if (bundle.templates) diffs.push(diffLocks("templates", bundle.templates.lock, parseTemplateLock(values.get(TEMPLATES_LOCK_KEY) ?? null)));
  return diffs;
}

export function printDiffs(io: Io, diffs: LockDiff[]): void {
  for (const d of diffs) {
    if (!differs(d)) {
      io.out(`${d.what}: in sync (version ${d.localVersion ?? "none"})`);
      continue;
    }
    io.out(`${d.what}: uploaded ${d.remoteVersion ?? "nothing"}, local ${d.localVersion ?? "nothing"}`);
    for (const f of d.changed) io.out(`  changed  ${f}`);
    for (const f of d.added) io.out(`  new      ${f}`);
    for (const f of d.removed) io.out(`  removed  ${f}`);
  }
}

async function remote(sub: "upload" | "diff", args: string[], io: Io, runner: CommandRunner): Promise<number> {
  const name = `gtm brain ${sub}`;
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        templates: { type: "string" },
        domain: { type: "string" },
        config: { type: "string" },
        env: { type: "string" },
        ...(sub === "upload" ? { "dry-run": { type: "boolean" as const, default: false }, yes: { type: "boolean" as const, default: false } } : {}),
      },
    });
  } catch (err) {
    io.err(`${name}: ${(err as Error).message}`);
    io.err(USAGE);
    return EXIT.usage;
  }
  const loc = locateBrain(io.cwd, parsed.positionals[0], parsed.values.templates);
  if (!existsSync(loc.brainDir) || !statSync(loc.brainDir).isDirectory()) {
    io.err(`${name}: ${loc.brainDir} is not a directory`);
    return EXIT.usage;
  }
  const deployDir = parsed.values.config ? resolve(io.cwd, parsed.values.config) : loc.configDir;
  const env = wranglerEnv(parsed.values.env);
  const dryRun = (parsed.values as { "dry-run"?: boolean })["dry-run"] === true;

  const bundle = await buildBundle(loc, parsed.values.domain, [deployDir, loc.configDir]);
  const errors = printIssues(io, bundle.issues.filter((i) => i.severity === "error"));
  if (errors && sub === "upload") {
    io.err(`${name}: ${errors} error(s); nothing was uploaded`);
    return EXIT.failed;
  }
  if (errors) io.err(`${name}: the local brain or templates have ${errors} error(s); the comparison covers only the files that pass`);
  if (!bundle.brain && !bundle.templates) {
    io.out(`${name}: there is no locked brain and no templates folder, so there is nothing to ${sub === "upload" ? "upload" : "compare"}`);
    return EXIT.ok;
  }
  const { files, locks } = bundleEntries(bundle);

  if (sub === "upload" && dryRun) {
    io.out(`${name}: dry run for ${envLabel(env)}; nothing is written. These keys would be written, files first, locks last:`);
    for (const e of [...files, ...locks]) io.out(`  ${e.key.padEnd(40)} ${new TextEncoder().encode(e.value).length} bytes`);
    return EXIT.ok;
  }

  if (!findWranglerConfig(deployDir)) {
    io.err(`${name}: no wrangler.jsonc in ${relative(io.cwd, deployDir) || "."}; pass --config <deployment dir>`);
    return EXIT.usage;
  }
  const notReady = kvReadiness(deployDir, env);
  if (notReady) {
    io.err(`${name}: ${notReady}`);
    return EXIT.failed;
  }
  const wrangler = wranglerAt(runner, deployDir);

  if (sub === "diff") {
    try {
      printDiffs(io, await remoteDiff(wrangler, env, bundle));
      return EXIT.ok;
    } catch (err) {
      io.err(`${name}: ${(err as Error).message}`);
      return EXIT.failed;
    }
  }

  const stop = await confirmProductionWrite(io, env, (parsed.values as { yes?: boolean }).yes === true, name, `upload ${files.length} file(s) and ${locks.length} lock(s) to KV`);
  if (stop !== null) return stop;
  try {
    await kvBulkPut(wrangler, files, env);
  } catch (err) {
    io.err(`${name}: writing the files failed (${(err as Error).message}). The locks were not written, so nothing new is served; run gtm brain upload again.`);
    return EXIT.failed;
  }
  try {
    await kvBulkPut(wrangler, locks, env);
  } catch (err) {
    io.err(`${name}: the files were written but the locks were not (${(err as Error).message}). Components whose files changed are held back until the locks are written; run gtm brain upload again.`);
    return EXIT.failed;
  }
  const parts = [
    ...(bundle.brain ? [`brain version ${bundle.brain.lock.hash.slice(0, 12)} (${bundle.brain.files.length} component(s))`] : []),
    ...(bundle.templates ? [`${bundle.templates.files.length} approved template(s)`] : []),
  ];
  io.out(`${name}: uploaded ${parts.join(" and ")} to ${envLabel(env)}. KV can take up to a minute to reach every location; until then a location serves the previous version or holds a changed file back, never a mix.`);
  return EXIT.ok;
}
