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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { TARBALL_DIR, capture, distTagFor, publishAuth, publishProblems, readReleaseRecord, run } from "./lib.mjs";

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
    else run("npm", ["publish", file, "--access", "public", "--provenance", "--tag", distTag]);
  }
  console.log(dryRun ? "publish: dry run complete; nothing was published" : `publish: done; verify with npm view ${record.packages[0]?.name}@${record.version}`);
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
