#!/usr/bin/env node
// GTM-agents: template hygiene check.
//
// The worker template must stay deployable from placeholders and must never carry a real
// deployment's identifiers. This check fails on:
//   - UUID-shaped strings, unless the file's first line contains "gtm:synthetic-fixture"
//     (the nil UUID is always allowed)
//   - real *.workers.dev hostnames (placeholders containing "<", "${" or "example" pass)
//   - concrete 32-hex resource ids inside a Wrangler config file
//   - secret-shaped values assigned to keys such as api_key, token, secret or password
//     (values containing example, placeholder, dummy, fake, test or similar words pass)
//
// Usage: node scripts/check-placeholders.mjs [--staged | --files <paths...>]
import { isMain, parseInputs, readSources, repoRoot, report } from "./lib/files.mjs";

export const SYNTHETIC_MARKER = "gtm:synthetic-fixture";

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const WORKERS_DEV = /[A-Za-z0-9<>${}_.-]+\.workers\.dev\b/g;
const HEX32 = /\b[0-9a-f]{32}\b/gi;
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_-]*(?:api[_-]?key|secret|token|password|passwd|private[_-]?key))["']?\s*[:=]\s*["']([^"'\s]{16,})["']/gi;
const PLACEHOLDER_VALUE = /example|placeholder|dummy|fake|test|sample|changeme|do-not-use|your[_-]|<|\$\{|\*\*\*|xxxx/i;
const WRANGLER_CONFIG = /(^|\/)wrangler\.(json|jsonc|toml)$/;

/** @typedef {import("./lib/files.mjs").Finding} Finding */

/**
 * @param {string} file path used in findings
 * @param {string} text file contents
 * @returns {Finding[]}
 */
export function scanPlaceholders(file, text) {
  /** @type {Finding[]} */
  const findings = [];
  const lines = text.split(/\r?\n/);
  const synthetic = (lines[0] ?? "").includes(SYNTHETIC_MARKER);
  const wranglerConfig = WRANGLER_CONFIG.test(file);

  lines.forEach((line, index) => {
    const n = index + 1;
    if (!synthetic) {
      for (const m of line.matchAll(UUID)) {
        if (m[0].toLowerCase() !== NIL_UUID) {
          findings.push({ file, line: n, rule: "uuid", detail: "UUID-shaped string outside a synthetic fixture" });
        }
      }
    }
    for (const m of line.matchAll(WORKERS_DEV)) {
      if (!/<|\$\{|example/i.test(m[0])) {
        findings.push({
          file,
          line: n,
          rule: "workers-dev",
          detail: "real *.workers.dev hostname; use a placeholder such as <worker>.<subdomain>.workers.dev",
        });
      }
    }
    if (wranglerConfig) {
      for (const _m of line.matchAll(HEX32)) {
        findings.push({ file, line: n, rule: "resource-id", detail: "concrete resource id in Wrangler config; use a ${...} placeholder" });
      }
    }
    for (const m of line.matchAll(SECRET_ASSIGNMENT)) {
      const key = m[1] ?? "value";
      const value = m[2] ?? "";
      if (!PLACEHOLDER_VALUE.test(value)) {
        findings.push({ file, line: n, rule: "secret", detail: `the value assigned to ${key} looks like a secret; load it from the environment` });
      }
    }
  });
  return findings;
}

if (isMain(import.meta.url)) {
  try {
    const inputs = parseInputs(process.argv.slice(2));
    const sources = readSources(inputs, repoRoot());
    const findings = sources.flatMap((s) => scanPlaceholders(s.path, s.text));
    report("check-placeholders", findings, `clean (${sources.length} file(s))`);
  } catch (err) {
    console.error(`check-placeholders: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  }
}
