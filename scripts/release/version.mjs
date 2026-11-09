#!/usr/bin/env node
// GTM-agents: lockstep versioning. Every workspace package and the root share one version, and every
// dependency on another workspace package names exactly that version, so adopters only ever match
// one number (`gtm init` pins the packages to the CLI's own version).
//
// Usage:
//   node scripts/release/version.mjs <version>          set the version everywhere and sync package-lock.json
//   node scripts/release/version.mjs <version> --no-lockfile   the same, without touching package-lock.json
//   node scripts/release/version.mjs --check [--tag v1.2.3]    fail unless versions are in lockstep (and match the tag)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isMain } from "../lib/files.mjs";
import { ROOT, lockstepProblems, run, workspaces } from "./lib.mjs";

// Build metadata (+...) is refused: npm drops it, so two builds would publish as the same version.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/**
 * Set the version in every manifest and pin internal dependencies to it.
 * @param {string} version
 * @param {string} [root]
 * @returns {string[]} the manifests that changed, relative to the root
 */
export function setVersion(version, root = ROOT) {
  if (!SEMVER.test(version)) throw new Error(`"${version}" is not a semantic version (for example 0.2.0 or 0.2.0-rc.1)`);
  const all = workspaces(root);
  const names = new Set(all.map((w) => w.manifest.name));
  /** @type {string[]} */
  const changed = [];
  /** @type {{ path: string, label: string }[]} */
  const manifests = [{ path: join(root, "package.json"), label: "package.json" }, ...all.map((w) => ({ path: join(w.path, "package.json"), label: `${w.dir}/package.json` }))];
  for (const { path, label } of manifests) {
    const before = readFileSync(path, "utf8");
    const manifest = JSON.parse(before);
    manifest.version = version;
    for (const field of FIELDS) {
      for (const dep of Object.keys(manifest[field] ?? {})) if (names.has(dep)) manifest[field][dep] = version;
    }
    const after = `${JSON.stringify(manifest, null, 2)}\n`;
    if (after !== before) {
      writeFileSync(path, after);
      changed.push(label);
    }
  }
  return changed;
}

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { check: { type: "boolean" }, tag: { type: "string" }, "no-lockfile": { type: "boolean" } } });
  if (values.check) {
    const { version, problems } = lockstepProblems();
    if (values.tag !== undefined && values.tag !== `v${version}`) problems.push(`the tag ${values.tag} does not match the version ${version}; expected v${version}`);
    if (problems.length) {
      for (const p of problems) console.error(`version: ${p}`);
      process.exitCode = 1;
      return;
    }
    console.log(`version: every package is at ${version}${values.tag ? `, matching ${values.tag}` : ""}`);
    return;
  }
  const version = positionals[0];
  if (!version || positionals.length > 1) throw new Error("usage: node scripts/release/version.mjs <version> [--no-lockfile] | --check [--tag v<version>]");
  const changed = setVersion(version);
  console.log(`version: ${version} in ${changed.length} manifest(s)${changed.length ? `: ${changed.join(", ")}` : ""}`);
  if (!values["no-lockfile"]) run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]);
  const { problems } = lockstepProblems();
  if (problems.length) throw new Error(`still out of step: ${problems.join("; ")}`);
  console.log(`version: done. Review the diff, run npm run check, commit, then tag v${version} (docs/RELEASING.md)`);
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`version: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
