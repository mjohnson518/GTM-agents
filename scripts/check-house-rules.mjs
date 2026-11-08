#!/usr/bin/env node
// GTM-agents: house-rule check.
//
// The project's house style forbids em dashes and en dashes everywhere: code, comments, docs,
// templates and generated copy. Commas, periods, colons or parentheses read better in plain-text
// email, and a rule enforced in code is a rule that holds.
//
// Usage: node scripts/check-house-rules.mjs [--staged | --files <paths...>]
import { isMain, parseInputs, readSources, repoRoot, report } from "./lib/files.mjs";

const FORBIDDEN = [
  { char: String.fromCharCode(0x2014), name: "em dash (U+2014)" },
  { char: String.fromCharCode(0x2013), name: "en dash (U+2013)" },
];

/** @typedef {import("./lib/files.mjs").Finding} Finding */

/**
 * @param {string} file
 * @param {string} text
 * @returns {Finding[]}
 */
export function scanHouseRules(file, text) {
  /** @type {Finding[]} */
  const findings = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const { char, name } of FORBIDDEN) {
      const col = line.indexOf(char);
      if (col !== -1) {
        findings.push({ file, line: index + 1, rule: "house-rule", detail: `${name} at column ${col + 1}; use a comma, period, colon or parentheses` });
      }
    }
  });
  return findings;
}

if (isMain(import.meta.url)) {
  try {
    const inputs = parseInputs(process.argv.slice(2));
    const sources = readSources(inputs, repoRoot());
    report("check-house-rules", sources.flatMap((s) => scanHouseRules(s.path, s.text)), `clean (${sources.length} file(s))`);
  } catch (err) {
    console.error(`check-house-rules: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  }
}
