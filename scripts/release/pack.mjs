#!/usr/bin/env node
// GTM-agents: build every publishable package and pack it into a tarball, without publishing.
//
// Node runs the monorepo's TypeScript directly, but it refuses to strip types from files under
// node_modules, so an installed package must ship JavaScript. For each package under packages/ that
// has an exports map or a bin, in dependency order, this script:
//   1. compiles it with its tsconfig.build.json into .release/stage/<dir>/dist (JavaScript, plus
//      declarations for libraries; the CLI ships JavaScript only);
//   2. copies the files its exports name as they are (SQL migrations, brain JSON schemas, adapter
//      manifests), its README (relative links made absolute) and the LICENSE;
//   3. for the CLI, bundles the worker template and the built dashboard into dist/template, which
//      is what `gtm init` copies in an npm install;
//   4. writes the published package.json (see publishedManifest in lib.mjs) and runs `npm pack`
//      into .release/tarballs;
// Nothing here needs a dependency's install script, so the release workflow runs it after
// `npm ci --ignore-scripts`: no third-party code runs in the job that produces the tarballs.
//   5. checks each tarball: every export and bin target is inside it, every relative import
//      resolves, and every bare import is a builtin, a declared dependency or an exported subpath.
// It ends by writing .release/release.json, with each tarball's SHA-256, which smoke.mjs and
// publish.mjs read and check.
//
// Usage: node scripts/release/pack.mjs [--repository <owner/repo|url>] [--skip-admin-build]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  OPTIONAL_PEERS,
  RELEASE_DIR,
  RELEASE_RECORD,
  ROOT,
  TARBALL_DIR,
  capture,
  exportsMatch,
  importsOf,
  isRelativeMarkdownLink,
  lockstepProblems,
  publishablePackages,
  publishedManifest,
  readJson,
  repositoryUrl,
  run,
  sha256File,
  splitSpecifier,
  stageDir,
  toPosix,
  verifyPackedFiles,
  workspaces,
} from "./lib.mjs";

/** @typedef {import("./lib.mjs").Publishable} Publishable */
/** @typedef {import("./lib.mjs").Manifest} Manifest */

const { values } = parseArgs({ options: { repository: { type: "string" }, "skip-admin-build": { type: "boolean" } } });

function main() {
  const { version, problems } = lockstepProblems();
  if (problems.length) {
    for (const p of problems) console.error(`pack: ${p}`);
    throw new Error("versions are not in lockstep; run node scripts/release/version.mjs <version>");
  }
  const { packages, skipped } = publishablePackages();
  const repository = repositoryUrl(values.repository);
  if (!repository) console.warn("pack: no repository URL (no --repository, GITHUB_REPOSITORY or origin remote); the manifests will have no repository field");
  /** @type {Manifest} */
  const rootManifest = readJson(join(ROOT, "package.json"));
  const internal = new Set(workspaces().map((w) => w.manifest.name));

  rmSync(RELEASE_DIR, { recursive: true, force: true });
  mkdirSync(TARBALL_DIR, { recursive: true });
  console.log(`pack: version ${version}, packages ${packages.map((p) => p.manifest.name).join(", ")}`);
  for (const ws of skipped) console.log(`pack: not published: ${ws.manifest.name} (${ws.dir.startsWith("apps/") ? "an app" : "no exports map or bin yet"})`);

  const cli = packages.find((p) => p.manifest.bin !== undefined);
  if (cli && !values["skip-admin-build"]) buildDashboard();

  /** @type {Map<string, Record<string, unknown>>} */
  const published = new Map();
  /** @type {{ pkg: Publishable, tarball: string, files: string[] }[]} */
  const packed = [];
  for (const pkg of packages) {
    const stage = stageDir(pkg);
    console.log(`\npack: ${pkg.manifest.name}`);
    run("npx", ["--no-install", "tsc", "-p", toPosix(relative(ROOT, pkg.buildConfigPath))]);
    const optionalPeers = optionalPeersFor(stage, rootManifest);
    const { manifest, rawFiles } = publishedManifest(pkg, { version, repository, rootManifest, internal, optionalPeers });
    for (const file of rawFiles) cpSync(join(pkg.path, file), join(stage, file), { recursive: true });
    if (pkg === cli) bundleTemplate(stage);
    writeFileSync(join(stage, "README.md"), absoluteLinks(readFileSync(join(pkg.path, "README.md"), "utf8"), pkg.dir, repository, version));
    cpSync(join(ROOT, "LICENSE"), join(stage, "LICENSE"));
    writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    published.set(pkg.manifest.name, manifest);
    const out = JSON.parse(capture("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", TARBALL_DIR], { cwd: stage }));
    const entry = /** @type {{ filename: string, files: { path: string }[] }} */ (out[0]);
    packed.push({ pkg, tarball: entry.filename, files: entry.files.map((f) => f.path) });
    console.log(`pack: ${entry.filename} (${entry.files.length} files)`);
  }

  /** @type {string[]} */
  const problems2 = [];
  for (const { pkg, files } of packed) {
    const manifest = /** @type {Record<string, unknown>} */ (published.get(pkg.manifest.name));
    const stage = stageDir(pkg);
    problems2.push(...verifyPackedFiles({ name: pkg.manifest.name, manifest, files, readText: (f) => readFileSync(join(stage, f), "utf8"), published }));
    if (pkg === cli) problems2.push(...verifyTemplateImports(stage, files, published));
  }
  if (problems2.length) {
    for (const p of problems2) console.error(`pack: ${p}`);
    throw new Error(`${problems2.length} problem(s) in the packed tarballs`);
  }

  const record = { version, repository, packages: packed.map(({ pkg, tarball }) => ({ name: pkg.manifest.name, dir: pkg.dir, tarball, sha256: sha256File(join(TARBALL_DIR, tarball)) })) };
  writeFileSync(RELEASE_RECORD, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\npack: ${packed.length} tarball(s) in ${toPosix(relative(ROOT, TARBALL_DIR))}, checked; nothing was published`);
  console.log(`pack: release.json SHA-256 ${sha256File(RELEASE_RECORD)} (smoke.mjs and publish.mjs take it as --record-sha256)`);
}

/** Build the operator dashboard into apps/worker/public/admin, which the CLI's template bundles. */
function buildDashboard() {
  const admin = workspaces().find((w) => w.dir === "apps/admin");
  if (!admin) throw new Error("apps/admin is missing; the CLI template needs the built dashboard");
  console.log(`\npack: building ${admin.manifest.name}`);
  run("npm", ["run", "build", "--workspace", admin.manifest.name]);
}

/**
 * Optional peer dependencies for third-party packages that only the package's test helpers import.
 * @param {string} stage
 * @param {Manifest} rootManifest
 * @returns {Record<string, string>}
 */
function optionalPeersFor(stage, rootManifest) {
  /** @type {Record<string, string>} */
  const peers = {};
  for (const file of walk(join(stage, "dist"))) {
    if (!file.endsWith(".js")) continue;
    for (const spec of importsOf(readFileSync(join(stage, "dist", file), "utf8"))) {
      const [name] = splitSpecifier(spec);
      if (!OPTIONAL_PEERS.includes(name)) continue;
      const range = rootManifest.devDependencies?.[name];
      peers[name] = range ? `>=${range.replace(/^[^\d]*/, "").split(".")[0]}` : "*";
    }
  }
  return peers;
}

/**
 * Copy the worker template (the files `gtm init` copies, plus the built dashboard) into the CLI's
 * dist/template. The list comes from init.ts itself, so the two never drift.
 * @param {string} stage
 */
function bundleTemplate(stage) {
  const source = join(ROOT, "apps", "worker");
  const target = join(stage, "dist", "template");
  for (const file of TEMPLATE_FILES) {
    mkdirSync(dirname(join(target, file)), { recursive: true });
    cpSync(join(source, file), join(target, file));
  }
  const admin = join(source, "public", "admin");
  if (!existsSync(join(admin, "index.html"))) throw new Error("apps/worker/public/admin/index.html is missing; build the dashboard (drop --skip-admin-build)");
  cpSync(admin, join(target, "public", "admin"), { recursive: true });
}

/**
 * The template's Worker entry imports @gtm-agents packages by subpath; each must be exported by the
 * published package, or a project created by `gtm init` would not bundle.
 * @param {string} stage
 * @param {string[]} files
 * @param {Map<string, Record<string, unknown>>} published
 * @returns {string[]}
 */
function verifyTemplateImports(stage, files, published) {
  /** @type {string[]} */
  const problems = [];
  for (const file of files.filter((f) => f.startsWith("dist/template/") && f.endsWith(".ts"))) {
    for (const spec of importsOf(readFileSync(join(stage, file), "utf8"))) {
      const [name, subpath] = splitSpecifier(spec);
      const manifest = published.get(name);
      if (spec.startsWith(".") || spec.startsWith("node:") || spec.startsWith("cloudflare:")) continue;
      if (!manifest) {
        problems.push(`the template's ${file} imports ${spec}, which is not one of the published packages`);
        continue;
      }
      if (!exportsMatch(/** @type {Record<string, unknown>} */ (manifest.exports ?? {}), subpath)) {
        problems.push(`the template's ${file} imports ${spec}, which ${name} does not export`);
      }
    }
  }
  return problems;
}

/**
 * Make relative Markdown links absolute, so the README reads correctly on the registry.
 * @param {string} text
 * @param {string} dir the package directory, relative to the repository root
 * @param {string | null} repository
 * @param {string} version
 * @returns {string}
 */
function absoluteLinks(text, dir, repository, version) {
  if (!repository) return text;
  return text.replace(/\]\(([^)\s]+)\)/g, (match, href) => {
    if (!isRelativeMarkdownLink(href)) return match;
    const [path, anchor] = href.split("#");
    const resolved = posix.normalize(posix.join(dir, path));
    if (resolved.startsWith("..")) return match;
    return `](${repository}/blob/v${version}/${resolved}${anchor ? `#${anchor}` : ""})`;
  });
}

/**
 * Files under a directory, relative to it.
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path).map((f) => `${name}/${f}`) : [name];
  });
}

/** @type {string[]} */
const TEMPLATE_FILES = (await import(pathToFileURL(join(ROOT, "packages", "cli", "src", "commands", "init.ts")).href)).TEMPLATE_FILES;

try {
  main();
} catch (err) {
  console.error(`pack: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
