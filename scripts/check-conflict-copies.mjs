#!/usr/bin/env node
// GTM-agents: conflict-copy check.
//
// File-sync tools (iCloud Drive, Dropbox, Google Drive, Syncthing) leave duplicates such as
// "index 2.ts", "notes (1).md" or "config (conflicted copy).json" next to the real file. They
// typecheck, they get imported by accident, and they drift. This check rejects them.
//
// Usage: node scripts/check-conflict-copies.mjs [--staged | --files <paths...>]
import { basename } from "node:path";
import { isMain, listPaths, parseInputs, repoRoot, report } from "./lib/files.mjs";

const PATTERNS = [
  / \d+(\.[^./]+)?$/, // "index 2.ts", "README 3"
  / \(\d+\)(\.[^./]+)?$/, // "notes (1).md"
  /conflicted copy/i, // Dropbox
  /\.sync-conflict-/i, // Syncthing
];

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isConflictCopy(path) {
  const name = basename(path);
  return PATTERNS.some((p) => p.test(name));
}

if (isMain(import.meta.url)) {
  try {
    const inputs = parseInputs(process.argv.slice(2));
    const paths = listPaths(inputs, repoRoot());
    const findings = paths
      .filter(isConflictCopy)
      .map((file) => ({ file, line: 0, rule: "conflict-copy", detail: "looks like a file-sync duplicate; delete it or merge it into the original" }));
    report("check-conflict-copies", findings, `clean (${paths.length} path(s))`);
  } catch (err) {
    console.error(`check-conflict-copies: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  }
}
