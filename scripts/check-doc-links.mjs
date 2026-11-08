#!/usr/bin/env node
// GTM-agents: Markdown link check.
//
// Fails when a relative link in a Markdown file points at a file or directory that does not
// exist. External links (http, https, mailto) and same-page anchors are not checked.
// Links inside fenced code blocks and inline code are ignored.
//
// Usage: node scripts/check-doc-links.mjs [--staged | --files <paths...>]
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMain, parseInputs, readSources, repoRoot, report } from "./lib/files.mjs";

const LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** @typedef {import("./lib/files.mjs").Finding} Finding */

/**
 * @param {string} file path of the Markdown file, relative to the root
 * @param {string} text Markdown source
 * @param {(target: string) => boolean} exists resolves a root-relative path
 * @returns {Finding[]}
 */
export function checkLinks(file, text, exists) {
  /** @type {Finding[]} */
  const findings = [];
  let inFence = false;
  text.split(/\r?\n/).forEach((raw, index) => {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const line = raw.replace(/`[^`]*`/g, "");
    for (const m of line.matchAll(LINK)) {
      const target = m[1] ?? "";
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
      const path = decodeURIComponent(target.replace(/[#?].*$/, ""));
      if (path === "") continue;
      const resolved = path.startsWith("/") ? path.slice(1) : resolve("/", dirname(file), path).slice(1);
      if (!exists(resolved)) {
        findings.push({ file, line: index + 1, rule: "broken-link", detail: `${target} does not exist` });
      }
    }
  });
  return findings;
}

if (isMain(import.meta.url)) {
  try {
    const root = repoRoot();
    const inputs = parseInputs(process.argv.slice(2));
    const docs = readSources(inputs, root).filter((s) => s.path.endsWith(".md"));
    const findings = docs.flatMap((d) => checkLinks(d.path, d.text, (p) => existsSync(resolve(root, p))));
    report("check-doc-links", findings, `clean (${docs.length} Markdown file(s))`);
  } catch (err) {
    console.error(`check-doc-links: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  }
}
