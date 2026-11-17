#!/usr/bin/env node
// GTM-agents: the Claude Code plugin check (plugins/gtm-agents, docs/QUICKSTART.md#with-a-coding-agent).
//
// Fails when the marketplace (.claude-plugin/marketplace.json) or a plugin it lists would not install
// and read as intended:
//   - the marketplace has no kebab-case name, no owner name or no plugins; an entry has no name or
//     source, a source that leaves the repository (..) or does not exist, or a name that differs from
//     the plugin's own manifest (.claude-plugin/plugin.json);
//   - a skill (skills/<name>/SKILL.md) has no frontmatter, a name that differs from its folder, no
//     description or one over 1,024 characters, or more than 500 lines;
//   - a Markdown link in the plugin is relative and leaves the plugin folder (an installed plugin is
//     copied on its own, so the link would break), or points at this repository on GitHub and names a
//     file, or a heading, that does not exist.
// `claude plugin validate .` is the authoritative check; this one needs no Claude Code, so CI runs it.
//
// Usage: node scripts/check-plugin.mjs
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { isMain, repoRoot, report } from "./lib/files.mjs";

/** Links into this repository on GitHub, which an installed skill reads the docs through. */
export const REPO_BLOB = "https://github.com/mjohnson518/GTM-agents/blob/main/";
const MARKETPLACE = ".claude-plugin/marketplace.json";
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const MAX_DESCRIPTION = 1024;
const MAX_LINES = 500;

/** @typedef {import("./lib/files.mjs").Finding} Finding */

/** @param {string} path */
function readJson(path) {
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * GitHub's anchor for a heading: lower case, punctuation dropped, spaces as hyphens.
 * @param {string} text
 * @returns {string}
 */
export function headingSlug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/**
 * The anchors a Markdown file's headings give, with GitHub's -1, -2 suffixes for repeats.
 * @param {string} markdown
 * @returns {Set<string>}
 */
export function anchorsOf(markdown) {
  /** @type {Set<string>} */
  const anchors = new Set();
  /** @type {Map<string, number>} */
  const seen = new Map();
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = headingSlug(m[1] ?? "");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

/**
 * The frontmatter fields of a SKILL.md (single-line `key: value` pairs), or null without frontmatter.
 * @param {string} text
 * @returns {Record<string, string> | null}
 */
export function frontmatterOf(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  /** @type {Record<string, string>} */
  const fields = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1] ?? ""] = (kv[2] ?? "").replace(/^["']|["']$/g, "");
  }
  return fields;
}

/** @param {string} dir @returns {string[]} every Markdown file under dir */
function markdownUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return markdownUnder(path);
    return e.name.endsWith(".md") ? [path] : [];
  });
}

/**
 * Check the links of one Markdown file in a plugin.
 * @param {string} root the repository root
 * @param {string} pluginDir the plugin's folder (absolute)
 * @param {string} file the Markdown file (absolute)
 * @returns {Finding[]}
 */
function checkLinksIn(root, pluginDir, file) {
  /** @type {Finding[]} */
  const findings = [];
  const shown = relative(root, file).split(sep).join("/");
  let inFence = false;
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((raw, index) => {
      if (/^\s*(```|~~~)/.test(raw)) {
        inFence = !inFence;
        return;
      }
      if (inFence) return;
      for (const m of raw.replace(/`[^`]*`/g, "").matchAll(LINK)) {
        const target = m[1] ?? "";
        if (target.startsWith(REPO_BLOB)) {
          const [path = "", anchor] = decodeURIComponent(target.slice(REPO_BLOB.length)).split("#");
          const full = join(root, path);
          if (!existsSync(full)) findings.push({ file: shown, line: index + 1, rule: "plugin-link", detail: `${path} does not exist in this repository` });
          else if (anchor && path.endsWith(".md") && !anchorsOf(readFileSync(full, "utf8")).has(anchor)) findings.push({ file: shown, line: index + 1, rule: "plugin-link", detail: `${path} has no heading #${anchor}` });
          continue;
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
        const resolved = resolve(file, "..", target.replace(/[#?].*$/, ""));
        if (relative(pluginDir, resolved).startsWith("..")) findings.push({ file: shown, line: index + 1, rule: "plugin-link", detail: `${target} leaves the plugin folder; link to ${REPO_BLOB}<path> instead` });
      }
    });
  return findings;
}

/**
 * Check the marketplace at the root and every plugin it lists.
 * @param {string} root
 * @returns {Finding[]}
 */
export function checkPlugins(root) {
  /** @type {Finding[]} */
  const findings = [];
  /** @param {string} file @param {string} detail */
  const add = (file, detail) => findings.push({ file, line: 0, rule: "plugin", detail });
  const marketplace = readJson(join(root, MARKETPLACE));
  if ("error" in marketplace) return (add(MARKETPLACE, `cannot be read: ${marketplace.error}`), findings);
  const m = marketplace.value;
  if (typeof m?.name !== "string" || !KEBAB.test(m.name)) add(MARKETPLACE, "needs a kebab-case name");
  if (typeof m?.owner?.name !== "string" || m.owner.name === "") add(MARKETPLACE, "needs owner.name");
  if (!Array.isArray(m?.plugins) || m.plugins.length === 0) return (add(MARKETPLACE, "needs a plugins list"), findings);
  for (const [i, entry] of m.plugins.entries()) {
    const where = `${MARKETPLACE} plugins[${i}]`;
    if (typeof entry?.name !== "string" || !KEBAB.test(entry.name)) add(MARKETPLACE, `${where} needs a kebab-case name`);
    if (typeof entry?.source !== "string" || !entry.source.startsWith("./")) {
      add(MARKETPLACE, `${where} needs a relative source such as ./plugins/<name>`);
      continue;
    }
    if (entry.source.split("/").includes("..")) {
      add(MARKETPLACE, `${where} source ${entry.source} contains ..`);
      continue;
    }
    const pluginDir = resolve(root, entry.source);
    if (!existsSync(pluginDir) || !statSync(pluginDir).isDirectory()) {
      add(MARKETPLACE, `${where} source ${entry.source} does not exist`);
      continue;
    }
    const manifestPath = join(entry.source, ".claude-plugin/plugin.json").replace(/^\.\//, "");
    const manifest = readJson(join(root, manifestPath));
    if ("error" in manifest) add(manifestPath, `cannot be read: ${manifest.error}`);
    else {
      if (manifest.value?.name !== entry.name) add(manifestPath, `name "${manifest.value?.name}" differs from the marketplace entry "${entry.name}", so installing it by name fails`);
      if (typeof manifest.value?.description !== "string" || manifest.value.description === "") add(manifestPath, "needs a description");
    }
    const skillsDir = join(pluginDir, "skills");
    if (existsSync(skillsDir)) {
      for (const skill of readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
        const file = join(skillsDir, skill.name, "SKILL.md");
        const shown = relative(root, file).split(sep).join("/");
        if (!existsSync(file)) {
          add(shown, "is missing");
          continue;
        }
        const text = readFileSync(file, "utf8");
        const fm = frontmatterOf(text);
        if (!fm) add(shown, "needs frontmatter with name and description");
        else {
          if (fm.name !== skill.name) add(shown, `name "${fm.name ?? ""}" differs from its folder "${skill.name}"`);
          if (!fm.description) add(shown, "needs a description");
          else if (fm.description.length > MAX_DESCRIPTION) add(shown, `description is ${fm.description.length} characters; keep it to ${MAX_DESCRIPTION}`);
        }
        const lines = text.split(/\r?\n/).length;
        if (lines > MAX_LINES) add(shown, `is ${lines} lines; keep a skill under ${MAX_LINES} and move detail to the docs`);
      }
    }
    for (const file of markdownUnder(pluginDir)) findings.push(...checkLinksIn(root, pluginDir, file));
  }
  return findings;
}

if (isMain(import.meta.url)) {
  try {
    const root = repoRoot();
    const findings = checkPlugins(root);
    report("check-plugin", findings, "clean (marketplace, plugins and skills)");
  } catch (err) {
    console.error(`check-plugin: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 2;
  }
}
