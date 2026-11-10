#!/usr/bin/env node
// GTM-agents: writes the ship sandbox's changes as JSON, for the sandbox-cloudflare adapter.
//
// Usage: node ship-collect.mjs --repo <dir> --base <sha> --out <file>
//                              --max-files <n> --max-file-bytes <n> --max-diff-bytes <n>
//
// It stages the whole work tree (respecting .gitignore), compares the index with the base commit the
// clone recorded, so a commit the agent made anyway is still a change against the base, and writes
// one entry per changed file with its content as the commit would hold it: UTF-8 text, or base64 for
// anything with a NUL byte or invalid UTF-8. Symlinks carry their target. Over a limit, it writes the
// status that names the limit and no files. Git runs with system, global and repository hooks,
// external diff drivers and text conversion off, so the repository cannot change what is reported.
//
// The Worker trusts none of this: it validates every field again and recomputes the sizes, and the
// gatekeeper recomputes the line counts from the base commit on the code host.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) throw new Error(`missing --${name}`);
  return process.argv[i + 1];
}

const repo = arg("repo");
const base = arg("base");
const out = arg("out");
const maxFiles = Number(arg("max-files"));
const maxFileBytes = Number(arg("max-file-bytes"));
const maxDiffBytes = Number(arg("max-diff-bytes"));
if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(base)) throw new Error("--base is not a commit sha");

const GIT_FLAGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "core.quotePath=false", "-C", repo];
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
const git = (args, encoding = "buffer") => execFileSync("git", [...GIT_FLAGS, ...args], { env: GIT_ENV, maxBuffer: 256 * 1024 * 1024, encoding });

function write(doc) {
  writeFileSync(out, JSON.stringify({ version: 1, base, ...doc }));
}

function content(bytes) {
  if (!bytes.includes(0)) {
    try {
      return { binary: false, content: { encoding: "utf-8", data: new TextDecoder("utf-8", { fatal: true }).decode(bytes) } };
    } catch {
      // Not UTF-8: fall through.
    }
  }
  return { binary: true, content: { encoding: "base64", data: Buffer.from(bytes).toString("base64") } };
}

git(["add", "--all", "--", "."]);

// --raw -z: ":<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0[<new path>\0]"
const raw = git(["diff", "--cached", "--raw", "-z", "-M", "--no-ext-diff", "--no-textconv", "--no-abbrev", base, "--"], "utf8").split("\0");
const entries = [];
for (let i = 0; i < raw.length; ) {
  const meta = raw[i++];
  if (!meta) continue;
  const [oldMode, newMode, , newSha, status] = meta.slice(1).split(" ");
  const kind = status[0];
  const first = raw[i++];
  const second = kind === "R" || kind === "C" ? raw[i++] : undefined;
  entries.push({ oldMode, newMode, newSha, kind, path: second ?? first, previousPath: kind === "R" ? first : undefined });
}

// --numstat -z: "<add>\t<del>\t<path>\0", or "<add>\t<del>\t\0<old>\0<new>\0" for a rename; "-" for binary.
const counts = new Map();
const numstat = git(["diff", "--cached", "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv", base, "--"], "utf8").split("\0");
for (let i = 0; i < numstat.length; ) {
  const line = numstat[i++];
  if (!line) continue;
  const [add, del, path] = line.split("\t");
  let key = path;
  if (path === "") {
    i++;
    key = numstat[i++];
  }
  counts.set(key, { additions: add === "-" ? 0 : Number(add), deletions: del === "-" ? 0 : Number(del) });
}

if (entries.length > maxFiles) {
  write({ status: "too_many_files", files: [] });
  process.exit(0);
}

const files = [];
let total = 0;
for (const entry of entries) {
  const lines = counts.get(entry.path) ?? { additions: 0, deletions: 0 };
  if (entry.kind === "D") {
    files.push({ path: entry.path, change: "deleted", ...lines, mode: entry.oldMode, binary: false, content: null });
    continue;
  }
  if (entry.newMode === "160000") {
    // A submodule has no content to commit; the Worker refuses it.
    files.push({ path: entry.path, change: "modified", ...lines, mode: entry.newMode, binary: false, content: null });
    continue;
  }
  const bytes = git(["cat-file", "blob", entry.newSha]);
  if (bytes.length > maxFileBytes) {
    write({ status: "file_too_large", files: [] });
    process.exit(0);
  }
  total += bytes.length;
  if (total > maxDiffBytes) {
    write({ status: "diff_too_large", files: [] });
    process.exit(0);
  }
  const change = entry.kind === "A" || entry.kind === "C" ? "added" : entry.kind === "R" ? "renamed" : "modified";
  files.push({ path: entry.path, ...(entry.previousPath ? { previousPath: entry.previousPath } : {}), change, ...lines, mode: entry.newMode, ...content(bytes) });
}

write({ status: "ok", files, diffBytes: total });
