// GTM-agents: shared helpers for the release scripts. Which packages publish and in what order,
// the manifest each one publishes with, and the checks that a packed tarball carries every file it
// loads at runtime.
//
// The monorepo runs TypeScript from source (docs/DECISIONS.md, ADR-009), and the source manifests
// export .ts files and stay "private": true, so a stray `npm publish` in a workspace fails. The
// published manifest is generated here at pack time instead: exports and bin point at compiled
// JavaScript in dist/, internal dependencies are pinned to the release version, and the private
// flag, scripts and devDependencies are dropped.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * TypeScript, loaded on first use: version checks and publishing run before `npm ci` has installed it.
 * @returns {typeof import("typescript")}
 */
function typescript() {
  return createRequire(import.meta.url)("typescript");
}

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** Everything the release scripts write lives here. It is gitignored. */
export const RELEASE_DIR = join(ROOT, ".release");
/** One directory per package, laid out exactly as it publishes. */
export const STAGE_DIR = join(RELEASE_DIR, "stage");
export const TARBALL_DIR = join(RELEASE_DIR, "tarballs");
/** What pack.mjs produced: the version, and every package in dependency order with its tarball. */
export const RELEASE_RECORD = join(RELEASE_DIR, "release.json");

/**
 * Third-party packages that only test helpers import (the adapter contract runners import Vitest).
 * They publish as optional peer dependencies, so installing a package never pulls them in.
 */
export const OPTIONAL_PEERS = ["vitest"];

const DEPENDENCY_FIELDS = /** @type {const} */ (["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"]);

/**
 * @typedef {Record<string, string>} DependencyMap
 * @typedef {{
 *   name: string,
 *   version: string,
 *   private?: boolean,
 *   description?: string,
 *   keywords?: string[],
 *   license?: string,
 *   type?: string,
 *   engines?: Record<string, string>,
 *   workspaces?: string[],
 *   exports?: unknown,
 *   bin?: string | Record<string, string>,
 *   dependencies?: DependencyMap,
 *   peerDependencies?: DependencyMap,
 *   optionalDependencies?: DependencyMap,
 *   devDependencies?: DependencyMap,
 * }} Manifest
 * @typedef {{ dir: string, path: string, manifest: Manifest }} Workspace
 * @typedef {{ rootDir: string, outDir: string, declaration: boolean }} BuildConfig
 * @typedef {Workspace & { build: BuildConfig, buildConfigPath: string }} Publishable
 * @typedef {{ name: string, dir: string, tarball: string, sha256: string }} ReleasedPackage
 * @typedef {{ version: string, repository: string | null, packages: ReleasedPackage[] }} ReleaseRecord
 */

/**
 * @param {string} path
 * @returns {any}
 */
export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Every workspace named by the root package.json, with its manifest.
 * @param {string} [root]
 * @returns {Workspace[]}
 */
export function workspaces(root = ROOT) {
  /** @type {Manifest} */
  const rootManifest = readJson(join(root, "package.json"));
  /** @type {Workspace[]} */
  const out = [];
  for (const pattern of rootManifest.workspaces ?? []) {
    if (!pattern.endsWith("/*") || pattern.slice(0, -2).includes("*")) throw new Error(`unsupported workspace pattern "${pattern}"; use <dir>/*`);
    const parent = join(root, pattern.slice(0, -2));
    if (!existsSync(parent)) continue;
    for (const name of readdirSync(parent).sort()) {
      const path = join(parent, name);
      if (!existsSync(join(path, "package.json"))) continue;
      out.push({ dir: toPosix(relative(root, path)), path, manifest: readJson(join(path, "package.json")) });
    }
  }
  return out;
}

/**
 * Parse a tsconfig file, which may hold comments and trailing commas.
 * @param {string} text
 * @returns {unknown}
 */
function parseTsconfig(text) {
  const ts = typescript();
  const parsed = ts.parseConfigFileTextToJson("tsconfig.build.json", text);
  if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"));
  return parsed.config;
}

/**
 * The publishable packages, in dependency order. A package under packages/ publishes when it has an
 * exports map or a bin; it must then have a tsconfig.build.json. Apps never publish.
 * @param {string} [root]
 * @returns {{ packages: Publishable[], skipped: Workspace[] }}
 */
export function publishablePackages(root = ROOT) {
  const all = workspaces(root);
  /** @type {Publishable[]} */
  const packages = [];
  /** @type {Workspace[]} */
  const skipped = [];
  for (const ws of all) {
    if (!ws.dir.startsWith("packages/") || (ws.manifest.exports === undefined && ws.manifest.bin === undefined)) {
      skipped.push(ws);
      continue;
    }
    const buildConfigPath = join(ws.path, "tsconfig.build.json");
    if (!existsSync(buildConfigPath)) throw new Error(`${ws.dir} has an exports map or a bin but no tsconfig.build.json, so it cannot be built for publishing`);
    const config = /** @type {{ compilerOptions?: { rootDir?: string, outDir?: string, declaration?: boolean } }} */ (parseTsconfig(readFileSync(buildConfigPath, "utf8")));
    const options = config.compilerOptions ?? {};
    if (!options.rootDir || !options.outDir) throw new Error(`${ws.dir}/tsconfig.build.json must set compilerOptions.rootDir and compilerOptions.outDir`);
    const expectedOut = toPosix(relative(ws.path, join(stageDir(ws), "dist")));
    if (toPosix(options.outDir) !== expectedOut) throw new Error(`${ws.dir}/tsconfig.build.json must set outDir to "${expectedOut}" (the staged package's dist/)`);
    packages.push({ ...ws, buildConfigPath, build: { rootDir: toPosix(options.rootDir).replace(/^\.\/?/, "") || ".", outDir: options.outDir, declaration: options.declaration === true } });
  }
  return { packages: dependencyOrder(packages, all), skipped };
}

/**
 * Sort packages so each comes after the internal packages it depends on.
 * @param {Publishable[]} packages
 * @param {Workspace[]} all
 * @returns {Publishable[]}
 */
function dependencyOrder(packages, all) {
  const names = new Set(packages.map((p) => p.manifest.name));
  const workspaceNames = new Set(all.map((w) => w.manifest.name));
  /** @type {Map<string, string[]>} */
  const deps = new Map();
  for (const p of packages) {
    const internal = runtimeDependencyNames(p.manifest).filter((d) => workspaceNames.has(d));
    for (const d of internal) if (!names.has(d)) throw new Error(`${p.manifest.name} depends on ${d}, which does not publish (it has no exports map or bin)`);
    deps.set(p.manifest.name, internal);
  }
  /** @type {Publishable[]} */
  const ordered = [];
  const done = new Set();
  let remaining = [...packages].sort((a, b) => a.dir.localeCompare(b.dir));
  while (remaining.length) {
    const ready = remaining.find((p) => (deps.get(p.manifest.name) ?? []).every((d) => done.has(d)));
    if (!ready) throw new Error(`circular dependency between ${remaining.map((p) => p.manifest.name).join(", ")}`);
    ordered.push(ready);
    done.add(ready.manifest.name);
    remaining = remaining.filter((p) => p !== ready);
  }
  return ordered;
}

/**
 * @param {Manifest} manifest
 * @returns {string[]}
 */
function runtimeDependencyNames(manifest) {
  return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})];
}

/**
 * Where a package stages: .release/stage/<its directory name under packages/>.
 * @param {Workspace} ws
 * @returns {string}
 */
export function stageDir(ws) {
  return join(STAGE_DIR, posix.basename(ws.dir));
}

/**
 * Every version problem in the workspace: packages whose version differs from the root's, and
 * internal dependency ranges that are not exactly that version. Versions move in lockstep.
 * @param {string} [root]
 * @returns {{ version: string, problems: string[] }}
 */
export function lockstepProblems(root = ROOT) {
  /** @type {Manifest} */
  const rootManifest = readJson(join(root, "package.json"));
  const version = rootManifest.version;
  const all = workspaces(root);
  const names = new Set(all.map((w) => w.manifest.name));
  /** @type {string[]} */
  const problems = [];
  for (const ws of all) {
    if (ws.manifest.version !== version) problems.push(`${ws.dir}/package.json: version ${ws.manifest.version}, expected ${version} (the root's)`);
    for (const field of DEPENDENCY_FIELDS) {
      for (const [dep, range] of Object.entries(ws.manifest[field] ?? {})) {
        if (names.has(dep) && range !== version) problems.push(`${ws.dir}/package.json: ${field}.${dep} is "${range}", expected "${version}"`);
      }
    }
  }
  return { version, problems };
}

/**
 * The https URL of the GitHub repository the release builds from: --repository, then the
 * GITHUB_REPOSITORY variable in GitHub Actions, then the origin remote. Provenance requires the
 * published repository.url to match the repository that runs the publishing workflow, which is why
 * forks need nothing changed here.
 * @param {string | undefined} flag
 * @returns {string | null}
 */
export function repositoryUrl(flag) {
  if (flag) return normalizeRepository(flag);
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  if (process.env.GITHUB_REPOSITORY) return `${server}/${process.env.GITHUB_REPOSITORY}`;
  try {
    const origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return origin ? normalizeRepository(origin) : null;
  } catch {
    return null;
  }
}

/**
 * owner/repo, git@github.com:owner/repo.git or https://github.com/owner/repo(.git) to https form.
 * @param {string} value
 * @returns {string}
 */
export function normalizeRepository(value) {
  const v = value.trim().replace(/^git\+/, "").replace(/\.git$/, "").replace(/\/$/, "");
  const ssh = /^git@([^:]+):(.+)$/.exec(v);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(v)) return `https://github.com/${v}`;
  if (/^https:\/\//.test(v)) return v;
  throw new Error(`cannot read a repository URL from "${value}"; pass owner/repo or an https URL`);
}

/**
 * The published form of one export target. A .ts file becomes its compiled JavaScript and
 * declarations under dist/; a pattern over a compiled directory maps .ts and .js requests to dist/;
 * anything else (JSON schemas, SQL migrations, adapter manifests) publishes as it is.
 * @param {string} key the export's subpath, for messages and patterns
 * @param {unknown} target
 * @param {BuildConfig} build
 * @param {string} pkgPath absolute package directory
 * @param {Set<string>} rawFiles collects paths that publish as they are
 * @returns {[string, unknown][]}
 */
export function mapExport(key, target, build, pkgPath, rawFiles) {
  if (target === null) return [[key, null]];
  if (Array.isArray(target)) return [[key, target.map((t) => mapExport(key, t, build, pkgPath, rawFiles)[0]?.[1])]];
  if (typeof target === "object") {
    /** @type {Record<string, unknown>} */
    const conditions = {};
    for (const [condition, value] of Object.entries(/** @type {Record<string, unknown>} */ (target))) {
      const mapped = mapExport(key, value, build, pkgPath, rawFiles);
      if (mapped.length !== 1) throw new Error(`export "${key}": a pattern inside conditions is not supported; extend scripts/release/lib.mjs`);
      conditions[condition] = mapped[0]?.[1];
    }
    return [[key, conditions]];
  }
  if (typeof target !== "string" || !target.startsWith("./")) throw new Error(`export "${key}": target ${JSON.stringify(target)} must be a string starting with ./`);
  const path = target.slice(2);
  const star = path.indexOf("*");
  if (star === -1) {
    if (path.endsWith(".ts") && !path.endsWith(".d.ts")) return [[key, compiled(key, path, build)]];
    if (!existsSync(join(pkgPath, path))) throw new Error(`export "${key}": ${target} does not exist`);
    rawFiles.add(path);
    return [[key, target]];
  }
  const dir = path.slice(0, star);
  const suffix = path.slice(star + 1);
  if (path.indexOf("*", star + 1) !== -1) throw new Error(`export "${key}": only one * is allowed`);
  if (suffix === ".ts") return [[key, compiled(key, path, build)]];
  const dirPath = join(pkgPath, dir);
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) throw new Error(`export "${key}": ${dir} is not a directory`);
  if (readdirSync(dirPath).some((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))) {
    // A directory of TypeScript, imported as "<key with .ts>": serve the compiled files for .ts and .js.
    if (suffix !== "" || !key.endsWith("*")) throw new Error(`export "${key}": a pattern over TypeScript must end in * on both sides; extend scripts/release/lib.mjs`);
    const value = compiled(key, `${path}.ts`, build);
    return [
      [`${key}.ts`, value],
      [`${key}.js`, value],
    ];
  }
  rawFiles.add(dir.replace(/\/$/, ""));
  return [[key, target]];
}

/**
 * @param {string} key
 * @param {string} path a .ts path relative to the package, possibly with one *
 * @param {BuildConfig} build
 * @returns {string | { types: string, default: string }}
 */
function compiled(key, path, build) {
  const rel = build.rootDir === "." ? path : posix.relative(build.rootDir, path);
  if (rel.startsWith("..") || posix.isAbsolute(rel)) throw new Error(`export "${key}": ./${path} is outside the build's rootDir (${build.rootDir})`);
  const js = `./dist/${rel.replace(/\.ts$/, ".js")}`;
  return build.declaration ? { types: `./dist/${rel.replace(/\.ts$/, ".d.ts")}`, default: js } : js;
}

/**
 * The manifest a package publishes with.
 * @param {Publishable} pkg
 * @param {{ version: string, repository: string | null, rootManifest: Manifest, internal: Set<string>, optionalPeers: Record<string, string> }} context
 * @returns {{ manifest: Record<string, unknown>, rawFiles: string[] }}
 */
export function publishedManifest(pkg, context) {
  const source = pkg.manifest;
  /** @type {Set<string>} */
  const raw = new Set();
  /** @type {Record<string, unknown> | undefined} */
  let exportsMap;
  if (source.exports !== undefined) {
    const entries = typeof source.exports === "string" || Array.isArray(source.exports) ? { ".": source.exports } : /** @type {Record<string, unknown>} */ (source.exports);
    if (Object.keys(entries).some((k) => !k.startsWith("."))) throw new Error(`${pkg.dir}: conditional exports at the top level are not supported; key them by subpath`);
    exportsMap = {};
    for (const [key, target] of Object.entries(entries)) for (const [k, v] of mapExport(key, target, pkg.build, pkg.path, raw)) exportsMap[k] = v;
    exportsMap["./package.json"] = "./package.json";
  }
  /** @type {Record<string, string> | undefined} */
  let bin;
  if (source.bin !== undefined) {
    bin = {};
    const entries = typeof source.bin === "string" ? { [source.name.split("/").pop() ?? source.name]: source.bin } : source.bin;
    for (const [command, target] of Object.entries(entries)) {
      const mapped = compiled(`bin ${command}`, target.replace(/^\.\//, ""), { ...pkg.build, declaration: false });
      bin[command] = /** @type {string} */ (mapped);
    }
  }
  const pin = (/** @type {DependencyMap | undefined} */ deps) => {
    if (!deps) return undefined;
    /** @type {DependencyMap} */
    const out = {};
    for (const [name, range] of Object.entries(deps)) out[name] = context.internal.has(name) ? context.version : range;
    return out;
  };
  const root = exportsMap?.["."];
  const rootTypes = root && typeof root === "object" && "types" in root ? /** @type {{ types: string, default: string }} */ (root) : undefined;
  const peers = { ...(source.peerDependencies ?? {}), ...context.optionalPeers };
  const manifest = {
    name: source.name,
    version: context.version,
    description: source.description,
    keywords: source.keywords,
    license: source.license ?? context.rootManifest.license,
    ...(context.repository
      ? {
          homepage: `${context.repository}/tree/v${context.version}/${pkg.dir}#readme`,
          bugs: { url: `${context.repository}/issues` },
          repository: { type: "git", url: `git+${context.repository}.git`, directory: pkg.dir },
        }
      : {}),
    type: source.type ?? "module",
    engines: source.engines ?? context.rootManifest.engines,
    ...(rootTypes ? { main: rootTypes.default, types: rootTypes.types } : {}),
    ...(exportsMap ? { exports: exportsMap } : {}),
    ...(bin ? { bin } : {}),
    files: ["dist", ...[...raw].sort()],
    dependencies: pin(source.dependencies),
    ...(Object.keys(peers).length ? { peerDependencies: pin(peers) } : {}),
    ...(Object.keys(context.optionalPeers).length ? { peerDependenciesMeta: Object.fromEntries(Object.keys(context.optionalPeers).map((n) => [n, { optional: true }])) } : {}),
    ...(source.optionalDependencies ? { optionalDependencies: pin(source.optionalDependencies) } : {}),
    publishConfig: { access: "public" },
  };
  return { manifest: dropUndefined(manifest), rawFiles: [...raw].sort() };
}

/**
 * @param {Record<string, unknown>} value
 * @returns {Record<string, unknown>}
 */
function dropUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

/**
 * Does a subpath match an exports map (exact keys, or one-* patterns)?
 * @param {Record<string, unknown>} exportsMap
 * @param {string} subpath "." or "./x/y"
 * @returns {boolean}
 */
export function exportsMatch(exportsMap, subpath) {
  if (subpath in exportsMap) return exportsMap[subpath] !== null;
  return Object.keys(exportsMap).some((key) => {
    const star = key.indexOf("*");
    if (star === -1) return false;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    return subpath.length >= key.length - 1 && subpath.startsWith(prefix) && subpath.endsWith(suffix);
  });
}

/**
 * The package name and subpath of a bare specifier: "@scope/pkg/a/b" is ["@scope/pkg", "./a/b"].
 * @param {string} specifier
 * @returns {[string, string]}
 */
export function splitSpecifier(specifier) {
  const parts = specifier.split("/");
  const n = specifier.startsWith("@") ? 2 : 1;
  const rest = parts.slice(n).join("/");
  return [parts.slice(0, n).join("/"), rest ? `./${rest}` : "."];
}

/**
 * Module specifiers a JavaScript or declaration file imports, from TypeScript's own pre-parser, so
 * comments and strings are never mistaken for imports.
 * @param {string} text
 * @returns {string[]}
 */
export function importsOf(text) {
  const info = typescript().preProcessFile(text, true, true);
  return info.importedFiles.map((f) => f.fileName);
}

/**
 * Check a packed package: every export and bin target is in the tarball, every relative import
 * resolves to a file in it, and every bare import is a builtin, a declared dependency or an
 * exported subpath of an internal package.
 * @param {{ name: string, manifest: Record<string, unknown>, files: string[], readText: (file: string) => string, published: Map<string, Record<string, unknown>> }} input
 * @returns {string[]} problems
 */
export function verifyPackedFiles({ name, manifest, files, readText, published }) {
  /** @type {string[]} */
  const problems = [];
  const fileSet = new Set(files);
  const exportsMap = /** @type {Record<string, unknown> | undefined} */ (manifest.exports);
  const declared = new Set([
    ...Object.keys(/** @type {DependencyMap} */ (manifest.dependencies ?? {})),
    ...Object.keys(/** @type {DependencyMap} */ (manifest.peerDependencies ?? {})),
    ...Object.keys(/** @type {DependencyMap} */ (manifest.optionalDependencies ?? {})),
  ]);
  const targets = [...leafTargets(exportsMap ?? {}), ...Object.values(/** @type {Record<string, string>} */ (manifest.bin ?? {}))];
  for (const target of targets) {
    const path = target.replace(/^\.\//, "");
    const star = path.indexOf("*");
    const present = star === -1 ? fileSet.has(path) : files.some((f) => f.startsWith(path.slice(0, star)) && f.endsWith(path.slice(star + 1)));
    if (!present) problems.push(`${name}: export or bin target ${target} is not in the tarball`);
  }
  for (const file of files) {
    if (!/\.(?:js|d\.ts)$/.test(file) || file.includes("/template/")) continue;
    const isDts = file.endsWith(".d.ts");
    for (const spec of importsOf(readText(file))) {
      problems.push(...checkSpecifier({ name, file, spec, isDts, fileSet, declared, published }));
    }
  }
  return problems;
}

/**
 * @param {{ name: string, file: string, spec: string, isDts: boolean, fileSet: Set<string>, declared: Set<string>, published: Map<string, Record<string, unknown>> }} input
 * @returns {string[]}
 */
export function checkSpecifier({ name, file, spec, isDts, fileSet, declared, published }) {
  if (spec.startsWith(".")) {
    const resolved = posix.normalize(posix.join(posix.dirname(file), spec));
    if (isDts) {
      const candidates = [resolved.replace(/\.(?:ts|js)$/, ".d.ts"), `${resolved}.d.ts`, `${resolved}/index.d.ts`, resolved];
      return candidates.some((c) => fileSet.has(c)) ? [] : [`${name}: ${file} imports types from ${spec}, which is not in the tarball`];
    }
    if (spec.endsWith(".ts")) return [`${name}: ${file} imports ${spec}; compiled JavaScript must import .js`];
    return fileSet.has(resolved) ? [] : [`${name}: ${file} imports ${spec}, which is not in the tarball`];
  }
  if (spec.startsWith("node:") || spec.startsWith("cloudflare:")) return [];
  const [pkg, subpath] = splitSpecifier(spec);
  if (pkg === name) {
    const own = published.get(name);
    return own?.exports && exportsMatch(/** @type {Record<string, unknown>} */ (own.exports), subpath) ? [] : [`${name}: ${file} imports ${spec}, which its own exports map does not export`];
  }
  if (!declared.has(pkg)) return isDts && pkg.startsWith("@cloudflare/") ? [] : [`${name}: ${file} imports ${spec}, but ${pkg} is not a dependency`];
  const internal = published.get(pkg);
  if (internal) {
    const map = /** @type {Record<string, unknown> | undefined} */ (internal.exports);
    if (!map || !exportsMatch(map, subpath)) return [`${name}: ${file} imports ${spec}, which ${pkg} does not export`];
  }
  return [];
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function leafTargets(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(leafTargets);
  if (value && typeof value === "object") return Object.entries(value).filter(([k]) => k !== "./package.json").flatMap(([, v]) => leafTargets(v));
  return [];
}

/**
 * A Markdown link target that points into the repository: not a URL, an anchor or an email address.
 * @param {string} href
 * @returns {boolean}
 */
export function isRelativeMarkdownLink(href) {
  return !/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(href);
}

/**
 * @param {string} path
 * @returns {string}
 */
export function toPosix(path) {
  return path.split(sep).join("/");
}

/**
 * Run a command, streaming its output, and throw with its exit code when it fails.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: options.cwd ?? ROOT, env: options.env ?? process.env, stdio: "inherit" });
}

/**
 * Run a command and return its standard output.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {string}
 */
export function capture(command, args, options = {}) {
  return execFileSync(command, args, { cwd: options.cwd ?? ROOT, env: options.env ?? process.env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 });
}

/**
 * The SHA-256 of a file, as lowercase hex (what `sha256sum` prints).
 * @param {string} path
 * @returns {string}
 */
export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Check a release artifact: the record is the one the pack job produced (its hash, when one is
 * expected, comes from that job's output, which no later job can change), and every tarball is
 * present with the hash the record lists.
 * @param {{ recordSha256: string, expectedRecordSha256?: string, record: ReleaseRecord, tarballSha256: (tarball: string) => string | null }} input
 * @returns {string[]}
 */
export function artifactProblems({ recordSha256, expectedRecordSha256, record, tarballSha256 }) {
  /** @type {string[]} */
  const problems = [];
  if (expectedRecordSha256 !== undefined && recordSha256 !== expectedRecordSha256.trim().toLowerCase()) {
    problems.push(`release.json has SHA-256 ${recordSha256}, but the pack job produced ${expectedRecordSha256}`);
  }
  for (const p of record.packages) {
    const actual = tarballSha256(p.tarball);
    if (actual === null) problems.push(`${p.tarball} is missing`);
    else if (!/^[0-9a-f]{64}$/.test(p.sha256 ?? "")) problems.push(`release.json lists no SHA-256 for ${p.tarball}`);
    else if (actual !== p.sha256) problems.push(`${p.tarball} has SHA-256 ${actual}, but release.json lists ${p.sha256}`);
  }
  return problems;
}

/**
 * The release record pack.mjs wrote, after checking every tarball against the hashes it lists and,
 * when given, the record itself against the hash the pack job reported.
 * @param {{ expectedRecordSha256?: string }} [options]
 * @returns {ReleaseRecord}
 */
export function readReleaseRecord(options = {}) {
  if (!existsSync(RELEASE_RECORD)) throw new Error(`${toPosix(relative(ROOT, RELEASE_RECORD))} does not exist; run node scripts/release/pack.mjs first`);
  /** @type {ReleaseRecord} */
  const record = readJson(RELEASE_RECORD);
  const problems = artifactProblems({
    recordSha256: sha256File(RELEASE_RECORD),
    ...(options.expectedRecordSha256 !== undefined ? { expectedRecordSha256: options.expectedRecordSha256 } : {}),
    record,
    tarballSha256: (tarball) => (existsSync(join(TARBALL_DIR, tarball)) ? sha256File(join(TARBALL_DIR, tarball)) : null),
  });
  if (problems.length) throw new Error(`the release artifact does not verify: ${problems.join("; ")}`);
  return record;
}

/**
 * Everything that must hold before any tarball publishes: the tag matches the packed version, every
 * tarball's manifest is the expected public package at that version, and a real publish runs in
 * GitHub Actions with a token.
 * @param {{ version: string, tag: string | undefined, dryRun: boolean, env: Record<string, string | undefined>, manifests: { expected: string, name: unknown, version: unknown, private?: unknown }[] }} input
 * @returns {string[]}
 */
export function publishProblems({ version, tag, dryRun, env, manifests }) {
  /** @type {string[]} */
  const problems = [];
  if (!dryRun && !tag) problems.push("a real publish needs the release tag: pass --tag v<version> (the workflow passes the pushed tag)");
  if (tag !== undefined && tag !== `v${version}`) problems.push(`the tag ${tag} does not match the packed version ${version}; expected v${version}`);
  for (const m of manifests) {
    if (m.name !== m.expected || m.version !== version) problems.push(`a tarball holds ${String(m.name)}@${String(m.version)}, expected ${m.expected}@${version}`);
    if (m.private) problems.push(`the ${m.expected} tarball is marked private`);
  }
  if (!dryRun) {
    if (env.GITHUB_ACTIONS !== "true") problems.push("a real publish runs only in GitHub Actions, where npm can attach provenance; use the release workflow");
    const auth = publishAuth(env);
    if (auth.mode === "none") problems.push(auth.problem);
  }
  return problems;
}

/** The oldest npm CLI that can publish through npm's trusted publishing (an OIDC exchange). */
export const TRUSTED_PUBLISHING_MIN_NPM = "11.5.1";

/**
 * How a real publish signs in to npm. A non-empty NODE_AUTH_TOKEN (the NPM_TOKEN secret) is used
 * first: that is how the first release publishes, since npm can only attach a trusted publisher to a
 * package that exists. Without one, trusted publishing: GitHub Actions must offer an OIDC token
 * (the job's `id-token: write` permission) and the npm CLI must be new enough to exchange it.
 * @param {Record<string, string | undefined>} env
 * @returns {{ mode: "token" | "oidc" } | { mode: "none", problem: string }}
 */
export function publishAuth(env) {
  if (env.NODE_AUTH_TOKEN) return { mode: "token" };
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    return { mode: "none", problem: "no way to sign in to npm: NODE_AUTH_TOKEN is empty and GitHub Actions offers no OIDC token (the publish job needs id-token: write); set the NPM_TOKEN secret for a first release, or configure trusted publishing (docs/RELEASING.md)" };
  }
  const npm = /^(\d+)\.(\d+)\.(\d+)/.exec(env.NPM_CLI_VERSION ?? "");
  const [minMajor, minMinor, minPatch] = TRUSTED_PUBLISHING_MIN_NPM.split(".").map(Number);
  const [major, minor, patch] = npm ? [Number(npm[1]), Number(npm[2]), Number(npm[3])] : [-1, -1, -1];
  const older = major !== minMajor ? major < Number(minMajor) : minor !== minMinor ? minor < Number(minMinor) : patch < Number(minPatch);
  if (older) return { mode: "none", problem: `trusted publishing needs npm ${TRUSTED_PUBLISHING_MIN_NPM} or later, and this runner has ${env.NPM_CLI_VERSION || "an unknown version"}` };
  return { mode: "oidc" };
}

/**
 * @param {string} version
 * @returns {number[] | null} major, minor, patch of a stable version; null for a prerelease
 */
function stableParts(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * The dist-tag a version publishes under. Prereleases go to "next". A stable version goes to
 * "latest" unless the registry's latest is newer (a patch on an older line), which would move
 * "latest" backwards; that publishes under "maintenance" instead.
 * @param {string} version
 * @param {string | null} registryLatest
 * @returns {string}
 */
export function distTagFor(version, registryLatest) {
  const mine = stableParts(version);
  if (!mine) return "next";
  const theirs = registryLatest ? stableParts(registryLatest) : null;
  if (!theirs) return "latest";
  for (let i = 0; i < 3; i++) {
    if ((theirs[i] ?? 0) > (mine[i] ?? 0)) return "maintenance";
    if ((theirs[i] ?? 0) < (mine[i] ?? 0)) return "latest";
  }
  return "latest";
}
