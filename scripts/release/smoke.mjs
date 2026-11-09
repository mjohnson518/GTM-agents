#!/usr/bin/env node
// GTM-agents: prove the packed tarballs work as an npm install, without publishing anything.
//
// Reads .release/release.json (written by pack.mjs) and, in a temporary directory:
//   1. installs every tarball the way `npm install` would (files extracted under node_modules, not
//      links into this checkout), checks that no TypeScript source is left for Node to run there,
//      runs `gtm --help`, and loads and typechecks the SDK as a host application would;
//   2. runs `gtm init` in npm mode and checks the project depends on exactly the packed version;
//   3. points the project's @gtm-agents dependencies at the tarballs (direct dependencies and
//      overrides), copies in the example brain, and runs `npm install`;
//   4. in the project: `wrangler deploy --dry-run` for production and staging, `tsc` against the
//      published declarations, `gtm brain validate` (which loads gtm.config.ts through the installed
//      core) and `gtm doctor` offline;
//   5. unless --skip-local, does the same for `gtm init --local <this checkout>`.
// The installs fetch third-party packages (Wrangler, TypeScript, hono, zod) from the registry.
//
// Every tarball is checked against the SHA-256 in release.json first, and release.json itself
// against --record-sha256 when given (the release workflow passes the pack job's output).
//
// Usage: node scripts/release/smoke.mjs [--record-sha256 <hex>] [--skip-local] [--keep]
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT, TARBALL_DIR, readReleaseRecord } from "./lib.mjs";

const { values } = parseArgs({ options: { "skip-local": { type: "boolean" }, keep: { type: "boolean" }, "record-sha256": { type: "string" } } });
const NPM_QUIET = ["--no-audit", "--no-fund", "--loglevel=error"];

/**
 * Run a command in a directory; throw with its output when it exits non-zero.
 * @param {string} cwd
 * @param {string} command
 * @param {string[]} args
 * @param {{ allowExit?: number[] }} [options]
 * @returns {{ code: number, output: string }}
 */
function sh(cwd, command, args, options = {}) {
  console.log(`\n$ (${cwd.replace(tmpdir(), "$TMP")}) ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }, maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(output.split("\n").slice(-25).join("\n"));
  const code = result.status ?? 1;
  if (code !== 0 && !(options.allowExit ?? []).includes(code)) throw new Error(`${command} ${args.join(" ")} exited ${code}`);
  return { code, output };
}

/**
 * @param {boolean} condition
 * @param {string} message
 */
function check(condition, message) {
  if (!condition) throw new Error(`check failed: ${message}`);
  console.log(`ok: ${message}`);
}

/**
 * @param {string} path
 * @returns {any}
 */
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * @param {string} path
 * @param {unknown} value
 */
function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * TypeScript sources Node would be asked to run from node_modules (declarations and the CLI's
 * bundled template, which `gtm init` copies out, are fine).
 * @param {string} dir
 * @returns {string[]}
 */
function strayTypeScript(dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === "template" || name === "node_modules") continue;
    if (statSync(path).isDirectory()) out.push(...strayTypeScript(path));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** Copy the example brain and templates into a project, keeping its README files. */
function copyExampleBrain(/** @type {string} */ project) {
  const brain = join(ROOT, "examples", "brains", "acme");
  for (const name of readdirSync(brain)) {
    if (name.endsWith(".md") && name !== "README.md") cpSync(join(brain, name), join(project, "brain", name));
  }
  for (const name of readdirSync(join(brain, "templates"))) cpSync(join(brain, "templates", name), join(project, "templates", name));
}

/**
 * Bundle, typecheck and run the CLI against a project whose dependencies are installed.
 * @param {string} project
 */
function exerciseProject(project) {
  check(existsSync(join(project, "node_modules", "@gtm-agents", "core", "migrations", "0001_baseline.sql")), "the migrations_dir in wrangler.jsonc exists after npm install");
  sh(project, "npx", ["--no-install", "wrangler", "deploy", "--dry-run", "--outdir", "dist"]);
  sh(project, "npx", ["--no-install", "wrangler", "deploy", "--dry-run", "--env", "staging", "--outdir", "dist-staging"]);
  check(existsSync(join(project, "dist", "index.js")), "wrangler bundled the Worker");
  sh(project, "npx", ["--no-install", "tsc", "-p", "tsconfig.json"]);
  const brain = sh(project, "npx", ["--no-install", "gtm", "brain", "validate"]);
  check(!brain.output.includes("could not load gtm.config.ts"), "gtm brain validate loaded gtm.config.ts through the installed core");
  check(/0 error\(s\)/.test(brain.output), "the example brain validates");
  // Offline doctor fails on the placeholders a fresh project still has; it must report, not crash.
  const doctor = sh(project, "npx", ["--no-install", "gtm", "doctor"], { allowExit: [1] });
  check(/gtm doctor: \d+ failed, \d+ warning\(s\)/.test(doctor.output), "gtm doctor ran to its summary");
  check(/PASS\s+adapter \S+/.test(doctor.output), "gtm doctor read the installed adapter manifests");
}

function main() {
  const record = readReleaseRecord(values["record-sha256"] !== undefined ? { expectedRecordSha256: values["record-sha256"] } : {});
  const tarball = (/** @type {string} */ name) => {
    const pkg = record.packages.find((p) => p.name === name);
    if (!pkg) throw new Error(`${name} is not in the release record`);
    return `file:${join(TARBALL_DIR, pkg.tarball)}`;
  };
  const allTarballs = Object.fromEntries(record.packages.map((p) => [p.name, tarball(p.name)]));
  const cli = record.packages.find((p) => p.dir === "packages/cli");
  if (!cli) throw new Error("the release record has no CLI package");
  const work = mkdtempSync(join(tmpdir(), "gtm-release-smoke-"));
  console.log(`smoke: version ${record.version}, working in ${work}`);

  try {
    // 1. Install the tarballs as an adopter's machine would, and run the CLI from node_modules.
    const tool = join(work, "tool");
    mkdirSync(tool);
    writeJson(join(tool, "package.json"), { name: "smoke-tool", version: "0.0.0", private: true, type: "module", dependencies: allTarballs, overrides: allTarballs });
    sh(tool, "npm", ["install", ...NPM_QUIET]);
    const installed = join(tool, "node_modules", ...cli.name.split("/"));
    check(lstatSync(installed).isDirectory() && !lstatSync(installed).isSymbolicLink(), `${cli.name} is installed as files under node_modules`);
    const stray = record.packages.flatMap((p) => (existsSync(join(tool, "node_modules", ...p.name.split("/"))) ? strayTypeScript(join(tool, "node_modules", ...p.name.split("/"))) : []));
    check(stray.length === 0, `no TypeScript source for Node to run under node_modules${stray.length ? `: ${stray.slice(0, 5).join(", ")}` : ""}`);
    const help = sh(tool, "npx", ["--no-install", "gtm", "--help"]);
    check(help.output.includes("Usage: gtm <command>"), "gtm --help runs from the installed package");

    // The SDK runs in a host application's Node process, so it must load and typecheck there.
    const sdk = record.packages.find((p) => p.dir === "packages/sdk");
    if (sdk) {
      sh(tool, "node", ["--input-type=module", "-e", `const m = await import(${JSON.stringify(sdk.name)}); if (Object.keys(m).length === 0) process.exit(1);`]);
      writeFileSync(join(tool, "uses-sdk.ts"), `import * as sdk from ${JSON.stringify(sdk.name)};\nexport const loaded: typeof sdk = sdk;\n`);
      const tsc = join(ROOT, "node_modules", ".bin", "tsc");
      for (const resolution of [["--module", "nodenext", "--moduleResolution", "nodenext"], ["--module", "esnext", "--moduleResolution", "bundler"]]) {
        sh(tool, tsc, ["--noEmit", "--strict", "--skipLibCheck", "false", "--target", "es2023", "--types", "node", "--typeRoots", join(ROOT, "node_modules", "@types"), ...resolution, "uses-sdk.ts"]);
      }
      check(true, `${sdk.name} loads in Node and its declarations typecheck under nodenext and bundler resolution`);
    }

    // 2. gtm init in npm mode, from the installed CLI, outside the tool directory.
    const gtm = join(tool, "node_modules", ".bin", "gtm");
    sh(work, gtm, ["init", "npm-agent", "--name", "smoke-agent"]);
    const project = join(work, "npm-agent");
    const pkg = readJson(join(project, "package.json"));
    for (const name of [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)].filter((n) => n in allTarballs)) {
      const range = pkg.dependencies[name] ?? pkg.devDependencies[name];
      check(range === record.version, `the project depends on ${name} at exactly ${record.version} (got ${range})`);
    }
    check(!readFileSync(join(project, "public", "admin", "index.html"), "utf8").includes("has not been built"), "the project carries the built dashboard from the CLI package");

    // 3. Resolve the project's packages to the tarballs instead of the registry, then install.
    for (const field of ["dependencies", "devDependencies"]) {
      for (const name of Object.keys(pkg[field])) if (name in allTarballs) pkg[field][name] = allTarballs[name];
    }
    pkg.overrides = allTarballs;
    writeJson(join(project, "package.json"), pkg);
    copyExampleBrain(project);
    sh(project, "npm", ["install", ...NPM_QUIET]);
    exerciseProject(project);

    // 4. The same for a project linked to this checkout.
    if (!values["skip-local"]) {
      sh(work, "node", [join(ROOT, "packages", "cli", "src", "bin.ts"), "init", "local-agent", "--local", ROOT]);
      const local = join(work, "local-agent");
      check(readJson(join(local, "package.json")).dependencies["@gtm-agents/core"].startsWith("file:"), "the --local project links the checkout's packages");
      copyExampleBrain(local);
      sh(local, "npm", ["install", ...NPM_QUIET]);
      exerciseProject(local);
    }
    console.log(`\nsmoke: passed for ${record.packages.map((p) => p.tarball).join(", ")}; nothing was published`);
  } finally {
    if (values.keep) console.log(`smoke: kept ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  console.error(`smoke: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
