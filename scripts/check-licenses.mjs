#!/usr/bin/env node
// GTM-agents: production dependency license check.
//
// Every package a deployment ships (the production dependencies of every workspace) must carry a
// permissive license. The list comes from `npm query`, which understands npm workspaces and
// hoisting; development tooling is not shipped and is not checked.
//
// Usage: node scripts/check-licenses.mjs
import { execFileSync } from "node:child_process";
import { isMain, repoRoot } from "./lib/files.mjs";

export const ALLOWED = ["MIT", "MIT-0", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "BlueOak-1.0.0", "CC0-1.0", "Unlicense"];

/**
 * Whether an SPDX expression is acceptable: for OR, one allowed alternative is enough; for AND,
 * every part must be allowed.
 * @param {unknown} license
 * @returns {boolean}
 */
export function isAllowedLicense(license) {
  const expr = normalize(license);
  if (!expr) return false;
  // Mixed AND/OR with parentheses needs real precedence handling; fail closed for a person to review.
  if (/[()]/.test(expr) && /\sAND\s/i.test(expr) && /\sOR\s/i.test(expr)) return false;
  return expr
    .replace(/[()]/g, " ")
    .split(/\s+OR\s+/i)
    .some((alternative) =>
      alternative
        .split(/\s+AND\s+/i)
        .map((part) => part.trim())
        .every((part) => ALLOWED.includes(part)),
    );
}

/**
 * @param {unknown} license
 * @returns {string}
 */
function normalize(license) {
  if (typeof license === "string") return license.trim();
  if (Array.isArray(license)) return license.map(normalize).filter(Boolean).join(" OR ");
  if (license && typeof license === "object" && "type" in license && typeof license.type === "string") return license.type;
  return "";
}

/**
 * @typedef {{ name: string, version: string, license?: unknown, path: string }} QueriedPackage
 */

/** @returns {QueriedPackage[]} production dependencies of every workspace, excluding workspaces */
export function productionPackages() {
  const root = repoRoot();
  const out = execFileSync("npm", ["query", ".prod:not(.workspace)"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  /** @type {QueriedPackage[]} */
  const packages = JSON.parse(out);
  return packages.filter((p) => p.path !== root);
}

if (isMain(import.meta.url)) {
  const packages = productionPackages();
  const rejected = packages.filter((p) => !isAllowedLicense(p.license));
  if (rejected.length) {
    for (const p of rejected) console.error(`${p.name}@${p.version}: license ${JSON.stringify(p.license ?? null)} is not on the allowlist`);
    console.error(`check-licenses: ${rejected.length} package(s) need review; allowed: ${ALLOWED.join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log(`check-licenses: ${packages.length} production package(s), all permissively licensed`);
  }
}
