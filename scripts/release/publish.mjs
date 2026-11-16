#!/usr/bin/env node
// GTM-agents: publish the packed tarballs to npm, in dependency order. The release workflow
// (.github/workflows/release.yml) is the only intended caller of a real publish.
//
// It publishes exactly the tarballs pack.mjs wrote and smoke.mjs tested, never a fresh build: each
// tarball must match the SHA-256 in release.json, and a real publish requires --record-sha256, the
// hash of release.json that the pack job reported as a job output. Before
// anything is published it checks that every tarball's package.json carries the release version
// and that the tag is v<that version>. A real publish also requires GitHub Actions (for provenance)
// and a way to sign in to npm: a non-empty NODE_AUTH_TOKEN (the first release), or else npm's
// trusted publishing, which needs the job's OIDC token and npm 11.5.1 or later. It refuses otherwise. A version already on the registry is
// skipped when its integrity matches the local tarball and stops the run when it does not, so a run
// that failed halfway can be re-run. Prereleases publish under the "next" dist-tag; a stable version
// older than the registry's latest publishes under "maintenance", so "latest" never moves backwards.
//
// Usage:
//   node scripts/release/publish.mjs --dry-run [--tag v1.2.3] [--record-sha256 <hex>]   npm publish --dry-run for each tarball not yet published
//   node scripts/release/publish.mjs --tag v1.2.3 --record-sha256 <hex>                 publish (GitHub Actions only)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { TARBALL_DIR, capture, distTagFor, oidcLogLines, publishAuth, publishLogs, publishProblems, readReleaseRecord, run } from "./lib.mjs";

const { values } = parseArgs({ options: { "dry-run": { type: "boolean" }, tag: { type: "string" }, "record-sha256": { type: "string" } } });
const dryRun = values["dry-run"] === true;

function main() {
  if (!dryRun && values["record-sha256"] === undefined) throw new Error("a real publish needs --record-sha256 <hex>, the SHA-256 of release.json reported by the pack job");
  const record = readReleaseRecord(values["record-sha256"] !== undefined ? { expectedRecordSha256: values["record-sha256"] } : {});
  const tag = values.tag ?? (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined);
  const manifests = record.packages.map((p) => ({ expected: p.name, ...JSON.parse(capture("tar", ["-xzOf", join(TARBALL_DIR, p.tarball), "package/package.json"])) }));
  const env = { ...process.env, NPM_CLI_VERSION: dryRun ? "" : capture("npm", ["--version"]).trim() };
  const problems = publishProblems({ version: record.version, tag, dryRun, env, manifests });
  if (problems.length) throw new Error(problems.join("; "));
  if (!dryRun) console.log(`publish: signing in to npm with ${publishAuth(env).mode === "token" ? "the NPM_TOKEN secret" : "trusted publishing (OIDC)"}`);

  console.log(`publish: ${record.packages.map((p) => `${p.name}@${record.version}`).join(", ")}${dryRun ? " (dry run)" : ""}`);
  // Where npm writes its debug logs, found before anything is published: every npm command writes
  // its own log, so asking after a failure would add a newer log than the one that explains it.
  const logDir = !dryRun && publishAuth(env).mode === "oidc" ? npmLogDir() : null;
  for (const p of record.packages) {
    const file = join(TARBALL_DIR, p.tarball);
    const published = registryInfo(p.name, record.version);
    if (published.integrity) {
      const local = `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;
      if (published.integrity !== local) throw new Error(`${p.name}@${record.version} is already on the registry with different contents; release a new version`);
      console.log(`publish: ${p.name}@${record.version} is already on the registry with the same contents; ${dryRun ? "a real publish skips it" : "skipping"}`);
      continue;
    }
    const distTag = distTagFor(record.version, published.latest);
    if (dryRun) run("npm", ["publish", file, "--dry-run", "--access", "public", "--tag", distTag]);
    else {
      const before = listLogs(logDir);
      try {
        run("npm", ["publish", file, "--access", "public", "--provenance", "--tag", distTag]);
      } catch (error) {
        if (logDir !== null) explainOidcFailure(p.name, logDir, before);
        throw error;
      }
    }
  }
  console.log(dryRun ? "publish: dry run complete; nothing was published" : `publish: done; verify with npm view ${record.packages[0]?.name}@${record.version}`);
}

/**
 * npm's debug log folder, worked out as npm does (logs-dir, else <cache>/_logs, the cache defaulting
 * to ~/.npm) rather than by asking npm: npm 11 refuses `npm config get cache`, and every npm call
 * writes a log of its own.
 */
function npmLogDir() {
  const env = process.env;
  const logsDir = env.npm_config_logs_dir ?? env.NPM_CONFIG_LOGS_DIR;
  if (logsDir) return logsDir;
  return join(env.npm_config_cache ?? env.NPM_CONFIG_CACHE ?? join(homedir(), ".npm"), "_logs");
}

/**
 * The files in npm's log folder; empty when there is none yet. Never throws.
 * @param {string | null} dir
 * @returns {string[]}
 */
function listLogs(dir) {
  if (dir === null) return [];
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * After a publish through trusted publishing fails, print what npm logged about the OIDC exchange.
 * npm turns a refused exchange into ENEEDAUTH and logs the registry's reason only at the verbose
 * level, in the debug log that publish wrote on the runner, which is gone once the job ends.
 * Never throws.
 * @param {string} name
 * @param {string} dir
 * @param {readonly string[]} before the log folder's files just before the publish
 */
function explainOidcFailure(name, dir, before) {
  try {
    const logs = publishLogs(before, listLogs(dir));
    const lines = logs.flatMap((f) => oidcLogLines(readFileSync(join(dir, f), "utf8")));
    console.error(`publish: npm's trusted-publishing steps for ${name} (${logs.length ? logs.join(", ") : "no debug log found"}):`);
    for (const line of lines.length ? lines : ["(npm logged no OIDC step)"]) console.error(`publish:   ${line}`);
  } catch {
    console.error("publish: npm's debug log could not be read");
  }
  console.error(
    `publish: the trusted publisher on ${name} (npmjs.com, package settings) must name GitHub Actions, the owner and repository in GITHUB_REPOSITORY (${process.env.GITHUB_REPOSITORY ?? "unknown"}), the workflow file name release.yml (not its path), and the environment npm or none`,
  );
}

/**
 * The integrity of name@version on the registry (absent when it is not published) and the package's
 * current "latest". A package that does not exist yet has neither. Any other failure stops the run.
 * @param {string} name
 * @param {string} version
 * @returns {{ integrity: string | null, latest: string | null }}
 */
function registryInfo(name, version) {
  const result = spawnSync("npm", ["view", name, "versions", "dist-tags", "--json"], { encoding: "utf8" });
  if (result.status !== 0) {
    if (/E404|404 Not Found|is not in this registry/.test(`${result.stdout}${result.stderr}`)) return { integrity: null, latest: null };
    throw new Error(`could not ask the registry about ${name}: ${result.stderr.trim().split("\n").pop() ?? "unknown error"}`);
  }
  const info = /** @type {{ versions?: string[] | string, "dist-tags"?: Record<string, string> }} */ (JSON.parse(result.stdout || "{}"));
  const versions = Array.isArray(info.versions) ? info.versions : info.versions ? [info.versions] : [];
  const latest = info["dist-tags"]?.latest ?? null;
  if (!versions.includes(version)) return { integrity: null, latest };
  const integrity = capture("npm", ["view", `${name}@${version}`, "dist.integrity"]).trim();
  return { integrity: integrity || "unknown", latest };
}

try {
  main();
} catch (err) {
  console.error(`publish: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
