// GTM-agents: shared helpers for the repository checks in scripts/.
//
// Every check accepts the same inputs:
//   (no flag)        tracked files plus untracked files that are not ignored
//   --staged         the staged contents of staged files (what a commit would contain)
//   --files <paths>  explicit files, for editors and tests
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @typedef {{ mode: "tree" | "staged" | "files", files: string[] }} Inputs
 * @typedef {{ path: string, text: string }} SourceFile
 */

/** @returns {string} the repository root, or the current directory outside a git checkout */
export function repoRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.cwd();
  }
}

/**
 * @param {string[]} argv command-line arguments after the script name
 * @returns {Inputs}
 */
export function parseInputs(argv) {
  if (argv[0] === "--staged") return { mode: "staged", files: [] };
  if (argv[0] === "--files") return { mode: "files", files: argv.slice(1) };
  if (argv.length === 0) return { mode: "tree", files: [] };
  throw new Error(`unknown option: ${argv.join(" ")} (use --staged or --files <paths>)`);
}

/**
 * @param {Buffer} buf
 * @returns {boolean} true when the buffer looks binary (a NUL byte in the first 8 KB)
 */
export function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Buffer}
 */
function git(args, cwd) {
  return execFileSync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Paths selected by the inputs, relative to the repository root (or as given for --files).
 * @param {Inputs} inputs
 * @param {string} root
 * @returns {string[]}
 */
export function listPaths(inputs, root) {
  if (inputs.mode === "files") return inputs.files;
  const args =
    inputs.mode === "staged"
      ? ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]
      : ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
  return git(args, root).toString("utf8").split("\0").filter(Boolean);
}

/**
 * Text files selected by the inputs. Binary and missing files are skipped.
 * @param {Inputs} inputs
 * @param {string} root
 * @returns {SourceFile[]}
 */
export function readSources(inputs, root) {
  /** @type {SourceFile[]} */
  const out = [];
  for (const path of listPaths(inputs, root)) {
    /** @type {Buffer} */
    let buf;
    if (inputs.mode === "staged") {
      buf = git(["show", `:${path}`], root);
    } else {
      const abs = resolve(inputs.mode === "files" ? process.cwd() : root, path);
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
      buf = readFileSync(abs);
    }
    if (!isBinary(buf)) out.push({ path, text: buf.toString("utf8") });
  }
  return out;
}

/**
 * @param {string} metaUrl import.meta.url of the calling module
 * @returns {boolean} true when that module is the script node was asked to run
 */
export function isMain(metaUrl) {
  const entry = process.argv[1];
  return entry !== undefined && metaUrl === pathToFileURL(resolve(entry)).href;
}

/**
 * @typedef {{ file: string, line: number, rule: string, detail: string }} Finding
 */

/**
 * Print findings and exit non-zero when there are any.
 * @param {string} name check name used as the output prefix
 * @param {Finding[]} findings
 * @param {string} okMessage
 */
export function report(name, findings, okMessage) {
  if (findings.length === 0) {
    console.log(`${name}: ${okMessage}`);
    return;
  }
  for (const f of findings) console.error(`${f.file}:${f.line}: ${f.rule}: ${f.detail}`);
  console.error(`${name}: ${findings.length} problem(s)`);
  process.exitCode = 1;
}
