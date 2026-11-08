// GTM-agents: `gtm brain validate`, which checks a brain and its templates against the schema,
// the per-task byte budgets and the lock file, and can write the lock.
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { LOCK_FILE, computeLock, parseLock, serializeLock, validateBrain, type Issue } from "@gtm-agents/core/brain";
import { validateTemplates } from "@gtm-agents/core/templates";
import { EXIT, type Io } from "../lib/io.ts";
import { loadDeploymentConfig, locateBrain, readFlatDir } from "../lib/project.ts";
import { unavailable } from "./unavailable.ts";

const USAGE = `Usage:
  gtm brain validate [dir] [--templates <dir>] [--domain <domain>] [--write-lock]
  gtm brain upload        (not available yet)
  gtm brain diff          (not available yet)`;

export async function brainCommand(args: string[], io: Io): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "validate") return validate(rest, io);
  if (sub === "upload" || sub === "diff") return unavailable(`brain ${sub}`, io);
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

  let domain = parsed.values.domain;
  if (!domain) {
    try {
      domain = (await loadDeploymentConfig(configDir))?.company.domain;
    } catch {
      issues.push({ severity: "warning", file: "gtm.config.ts", line: 0, message: "could not load gtm.config.ts, so template links are not checked against the company domain" });
    }
  }
  let templateCount = 0;
  if (templatesDir) {
    const templates = validateTemplates(readFlatDir(templatesDir), domain ? { companyDomain: domain } : {});
    templateCount = templates.parsed.length;
    issues.push(...templates.issues.map((i) => ({ ...i, file: `${relative(brainDir, templatesDir) || "templates"}/${i.file}` })));
  }

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  for (const i of [...errors, ...warnings]) {
    io.out(`${i.severity === "error" ? "ERROR" : "WARN "} ${i.file}${i.line ? `:${i.line}` : ""}  ${i.message}`);
  }
  const components = result.parsed.filter((p) => p.component).length;
  io.out(
    `gtm brain validate: ${show(brainDir)}: ${components} component(s), ${templateCount} template(s), ${errors.length} error(s), ${warnings.length} warning(s)${
      lock && !writeLock ? `, version ${lock.hash.slice(0, 12)}` : ""
    }`,
  );
  return errors.length ? EXIT.failed : EXIT.ok;
}
