// GTM-agents: tests for the release scripts: which packages publish and in what order, the manifest
// each publishes with, the packed-file checks and lockstep versioning. The end-to-end proof is
// scripts/release/smoke.mjs, which CI runs on the real tarballs.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  artifactProblems,
  checkSpecifier,
  distTagFor,
  exportsMatch,
  isRelativeMarkdownLink,
  lockstepProblems,
  mapExport,
  normalizeRepository,
  publishProblems,
  publishablePackages,
  publishedManifest,
  splitSpecifier,
  verifyPackedFiles,
} from "../release/lib.mjs";
import { setVersion } from "../release/version.mjs";

const BUILD = { rootDir: "src", outDir: "dist", declaration: true };

describe("release: what publishes", () => {
  it("publishes the libraries and the CLI in dependency order, and never an app", () => {
    const { packages, skipped } = publishablePackages();
    const names = packages.map((p) => p.manifest.name);
    expect(names.indexOf("@gtm-agents/core")).toBeLessThan(names.indexOf("@gtm-agents/adapters"));
    expect(names.indexOf("@gtm-agents/core")).toBeLessThan(names.indexOf("@gtm-agents/cli"));
    expect(names).not.toContain("@gtm-agents/worker");
    expect(names).not.toContain("@gtm-agents/admin");
    expect(skipped.map((s) => s.manifest.name)).toEqual(expect.arrayContaining(["@gtm-agents/worker", "@gtm-agents/admin"]));
    // The CLI ships JavaScript only; the libraries ship declarations too.
    expect(packages.find((p) => p.manifest.name === "@gtm-agents/cli")?.build.declaration).toBe(false);
    expect(packages.find((p) => p.manifest.name === "@gtm-agents/core")?.build.declaration).toBe(true);
  });

  it("keeps the source manifests private, so only the generated ones can publish", () => {
    for (const p of publishablePackages().packages) expect(p.manifest.private, p.dir).toBe(true);
  });
});

describe("release: export mapping", () => {
  const pkgPath = join(import.meta.dirname, "..", "..", "packages", "core");

  it("maps a .ts export to compiled JavaScript and declarations under dist/", () => {
    const raw = new Set<string>();
    expect(mapExport("./config", "./src/config/index.ts", BUILD, pkgPath, raw)).toEqual([["./config", { types: "./dist/config/index.d.ts", default: "./dist/config/index.js" }]]);
    expect(mapExport("./bin", "./src/bin.ts", { ...BUILD, declaration: false }, pkgPath, raw)).toEqual([["./bin", "./dist/bin.js"]]);
    expect(raw.size).toBe(0);
  });

  it("publishes migrations and schemas as they are, and lists them in files", () => {
    const raw = new Set<string>();
    expect(mapExport("./migrations/*", "./migrations/*", BUILD, pkgPath, raw)).toEqual([["./migrations/*", "./migrations/*"]]);
    expect(mapExport("./brain/schema/*", "./brain/schema/*", BUILD, pkgPath, raw)).toEqual([["./brain/schema/*", "./brain/schema/*"]]);
    expect([...raw].sort()).toEqual(["brain/schema", "migrations"]);
  });

  it("serves a pattern over a TypeScript directory for .ts and .js requests", () => {
    const adapters = join(pkgPath, "..", "adapters");
    const mapped = mapExport("./_contract/*", "./_contract/*", { rootDir: ".", outDir: "dist", declaration: true }, adapters, new Set());
    expect(mapped).toEqual([
      ["./_contract/*.ts", { types: "./dist/_contract/*.d.ts", default: "./dist/_contract/*.js" }],
      ["./_contract/*.js", { types: "./dist/_contract/*.d.ts", default: "./dist/_contract/*.js" }],
    ]);
  });

  it("refuses a .ts export outside the build's rootDir", () => {
    expect(() => mapExport("./x", "./test/x.ts", BUILD, pkgPath, new Set())).toThrow(/outside the build's rootDir/);
  });

  it("matches subpaths against exact keys and one-star patterns", () => {
    const map = { ".": "./a.js", "./config": "./b.js", "./_contract/*.ts": "./c/*.js", "./gone": null };
    expect(exportsMatch(map, ".")).toBe(true);
    expect(exportsMatch(map, "./config")).toBe(true);
    expect(exportsMatch(map, "./_contract/fetch.ts")).toBe(true);
    expect(exportsMatch(map, "./_contract/fetch.js")).toBe(false);
    expect(exportsMatch(map, "./gone")).toBe(false);
    expect(exportsMatch(map, "./src/config/index.ts")).toBe(false);
    expect(splitSpecifier("@gtm-agents/core/sending/testing")).toEqual(["@gtm-agents/core", "./sending/testing"]);
    expect(splitSpecifier("hono/body-limit")).toEqual(["hono", "./body-limit"]);
    expect(splitSpecifier("zod")).toEqual(["zod", "."]);
  });
});

describe("release: the published manifest", () => {
  const [cli] = publishablePackages().packages.filter((p) => p.manifest.name === "@gtm-agents/cli");

  it("drops private, scripts and devDependencies, pins internal dependencies and maps bin to dist", () => {
    if (!cli) throw new Error("no CLI package");
    const { manifest } = publishedManifest(cli, {
      version: "1.2.3",
      repository: "https://github.com/example/gtm-agents",
      rootManifest: { name: "root", version: "1.2.3", license: "Apache-2.0", engines: { node: ">=24" } },
      internal: new Set(["@gtm-agents/core", "@gtm-agents/cli"]),
      optionalPeers: {},
    });
    expect(manifest.private).toBeUndefined();
    expect(manifest.scripts).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.bin).toEqual({ gtm: "./dist/bin.js" });
    expect(manifest.dependencies).toEqual({ "@gtm-agents/core": "1.2.3" });
    expect(manifest.engines).toEqual({ node: ">=24" });
    expect(manifest.repository).toEqual({ type: "git", url: "git+https://github.com/example/gtm-agents.git", directory: "packages/cli" });
    expect(manifest.files).toEqual(["dist"]);
  });

  it("normalizes repository URLs for provenance", () => {
    expect(normalizeRepository("example/gtm-agents")).toBe("https://github.com/example/gtm-agents");
    expect(normalizeRepository("git@github.com:example/gtm-agents.git")).toBe("https://github.com/example/gtm-agents");
    expect(normalizeRepository("git+https://github.com/example/gtm-agents.git")).toBe("https://github.com/example/gtm-agents");
    expect(() => normalizeRepository("not a url")).toThrow();
    expect(isRelativeMarkdownLink("../../docs/DEPLOYING.md")).toBe(true);
    expect(isRelativeMarkdownLink("https://example.com")).toBe(false);
    expect(isRelativeMarkdownLink("#commands")).toBe(false);
  });
});

describe("release: packed-file checks", () => {
  const core = { exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" }, "./config": { types: "./dist/config/index.d.ts", default: "./dist/config/index.js" } } };
  const published = new Map<string, Record<string, unknown>>([["@gtm-agents/core", core]]);
  const base = { name: "@gtm-agents/cli", file: "dist/index.js", isDts: false, fileSet: new Set(["dist/index.js", "dist/lib/io.js", "dist/types.d.ts"]), declared: new Set(["@gtm-agents/core"]), published };

  it("accepts resolvable relative imports, builtins, declared dependencies and exported subpaths", () => {
    expect(checkSpecifier({ ...base, spec: "./lib/io.js" })).toEqual([]);
    expect(checkSpecifier({ ...base, spec: "node:fs" })).toEqual([]);
    expect(checkSpecifier({ ...base, spec: "cloudflare:workers" })).toEqual([]);
    expect(checkSpecifier({ ...base, spec: "@gtm-agents/core/config" })).toEqual([]);
    expect(checkSpecifier({ ...base, file: "dist/x.d.ts", isDts: true, spec: "./types.ts" })).toEqual([]);
  });

  it("rejects missing files, leftover .ts imports, undeclared packages and unexported subpaths", () => {
    expect(checkSpecifier({ ...base, spec: "./lib/missing.js" })[0]).toMatch(/not in the tarball/);
    expect(checkSpecifier({ ...base, spec: "./lib/io.ts" })[0]).toMatch(/must import \.js/);
    expect(checkSpecifier({ ...base, spec: "zod" })[0]).toMatch(/not a dependency/);
    expect(checkSpecifier({ ...base, spec: "@gtm-agents/core/src/config/index.ts" })[0]).toMatch(/does not export/);
  });

  it("checks that every export and bin target is inside the tarball", () => {
    const problems = verifyPackedFiles({
      name: "@gtm-agents/x",
      manifest: { exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" }, "./migrations/*": "./migrations/*" }, bin: { x: "./dist/bin.js" }, dependencies: {} },
      files: ["package.json", "dist/index.js", "dist/index.d.ts"],
      readText: () => "",
      published: new Map(),
    });
    expect(problems).toEqual(["@gtm-agents/x: export or bin target ./migrations/* is not in the tarball", "@gtm-agents/x: export or bin target ./dist/bin.js is not in the tarball"]);
  });
});

describe("release: lockstep versions", () => {
  function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), "gtm-version-"));
    const write = (path: string, manifest: Record<string, unknown>) => {
      mkdirSync(join(root, path), { recursive: true });
      writeFileSync(join(root, path, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    };
    write(".", { name: "root", version: "0.1.0", private: true, workspaces: ["packages/*", "apps/*"], devDependencies: { typescript: "6.0.3" } });
    write("packages/core", { name: "@acme/core", version: "0.1.0", dependencies: { zod: "4.6.7" } });
    write("packages/cli", { name: "@acme/cli", version: "0.1.0", dependencies: { "@acme/core": "0.1.0" } });
    write("apps/worker", { name: "@acme/worker", version: "0.1.0", private: true, dependencies: { "@acme/core": "0.1.0", "@acme/cli": "0.1.0" } });
    return root;
  }

  it("moves every package and every internal range together, and leaves third-party ranges alone", () => {
    const root = workspace();
    expect(setVersion("0.2.0-rc.1", root)).toHaveLength(4);
    expect(lockstepProblems(root)).toEqual({ version: "0.2.0-rc.1", problems: [] });
    const worker = JSON.parse(readFileSync(join(root, "apps/worker/package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(worker.dependencies).toEqual({ "@acme/core": "0.2.0-rc.1", "@acme/cli": "0.2.0-rc.1" });
    const core = JSON.parse(readFileSync(join(root, "packages/core/package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(core.dependencies).toEqual({ zod: "4.6.7" });
    expect(() => setVersion("v0.2.0", root)).toThrow(/not a semantic version/);
  });

  it("reports a package or an internal range out of step", () => {
    const root = workspace();
    writeFileSync(join(root, "packages/cli/package.json"), `${JSON.stringify({ name: "@acme/cli", version: "0.1.1", dependencies: { "@acme/core": "^0.1.0" } }, null, 2)}\n`);
    expect(lockstepProblems(root).problems).toEqual([
      "packages/cli/package.json: version 0.1.1, expected 0.1.0 (the root's)",
      'packages/cli/package.json: dependencies.@acme/core is "^0.1.0", expected "0.1.0"',
    ]);
  });

  it("finds the repository's own versions in lockstep", () => {
    expect(lockstepProblems().problems).toEqual([]);
  });
});

describe("release: publish guards", () => {
  const manifests = [{ expected: "@gtm-agents/core", name: "@gtm-agents/core", version: "1.2.3" }];
  const ci = { GITHUB_ACTIONS: "true", NODE_AUTH_TOKEN: "set" };

  it("lets a tagged publish in GitHub Actions with a token through, and a dry run anywhere", () => {
    expect(publishProblems({ version: "1.2.3", tag: "v1.2.3", dryRun: false, env: ci, manifests })).toEqual([]);
    expect(publishProblems({ version: "1.2.3", tag: undefined, dryRun: true, env: {}, manifests })).toEqual([]);
  });

  it("refuses a missing or mismatched tag, a wrong or private tarball, a local run and an empty token", () => {
    expect(publishProblems({ version: "1.2.3", tag: undefined, dryRun: false, env: ci, manifests })[0]).toMatch(/needs the release tag/);
    expect(publishProblems({ version: "1.2.3", tag: "v1.2.4", dryRun: true, env: {}, manifests })[0]).toMatch(/does not match/);
    expect(publishProblems({ version: "1.2.3", tag: "v1.2.3", dryRun: true, env: {}, manifests: [{ ...manifests[0]!, version: "1.2.2" }] })[0]).toMatch(/expected @gtm-agents\/core@1.2.3/);
    expect(publishProblems({ version: "1.2.3", tag: "v1.2.3", dryRun: true, env: {}, manifests: [{ ...manifests[0]!, private: true }] })[0]).toMatch(/marked private/);
    expect(publishProblems({ version: "1.2.3", tag: "v1.2.3", dryRun: false, env: { NODE_AUTH_TOKEN: "set" }, manifests })[0]).toMatch(/only in GitHub Actions/);
    expect(publishProblems({ version: "1.2.3", tag: "v1.2.3", dryRun: false, env: { GITHUB_ACTIONS: "true", NODE_AUTH_TOKEN: "" }, manifests })[0]).toMatch(/NODE_AUTH_TOKEN is empty/);
  });

  it("never moves latest backwards, and keeps prereleases off latest", () => {
    expect(distTagFor("1.2.3", null)).toBe("latest");
    expect(distTagFor("1.2.3", "1.2.2")).toBe("latest");
    expect(distTagFor("1.3.0", "1.2.9")).toBe("latest");
    expect(distTagFor("1.2.4", "1.3.0")).toBe("maintenance");
    expect(distTagFor("1.3.0-rc.1", "1.2.0")).toBe("next");
  });
});

describe("release: the release artifact", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  const record = { version: "1.2.3", repository: null, packages: [{ name: "@gtm-agents/core", dir: "packages/core", tarball: "core.tgz", sha256: a }] };

  it("accepts tarballs that match release.json, and a release.json that matches the pack job's hash", () => {
    expect(artifactProblems({ recordSha256: b, expectedRecordSha256: b.toUpperCase(), record, tarballSha256: () => a })).toEqual([]);
    expect(artifactProblems({ recordSha256: b, record, tarballSha256: () => a })).toEqual([]);
  });

  it("refuses a swapped release.json, a changed or missing tarball, and a record without hashes", () => {
    expect(artifactProblems({ recordSha256: b, expectedRecordSha256: a, record, tarballSha256: () => a })[0]).toMatch(/the pack job produced/);
    expect(artifactProblems({ recordSha256: b, record, tarballSha256: () => b })[0]).toMatch(/but release.json lists/);
    expect(artifactProblems({ recordSha256: b, record, tarballSha256: () => null })[0]).toMatch(/is missing/);
    const unhashed = { ...record, packages: [{ ...record.packages[0]!, sha256: "" }] };
    expect(artifactProblems({ recordSha256: b, record: unhashed, tarballSha256: () => a })[0]).toMatch(/lists no SHA-256/);
  });
});

describe("release: the release workflow", () => {
  const workflow = readFileSync(join(import.meta.dirname, "..", "..", ".github", "workflows", "release.yml"), "utf8");
  const job = (name: string) => {
    const start = workflow.indexOf(`\n  ${name}:\n`);
    const next = workflow.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
    return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
  };

  it("pins every action to a commit SHA and grants id-token and the npm token only to the publish job", () => {
    for (const line of workflow.split("\n").filter((l) => /uses:/.test(l))) expect(line).toMatch(/@[0-9a-f]{40} # v/);
    expect(workflow.match(/id-token: write/g)?.length).toBe(1);
    expect(job("publish")).toContain("id-token: write");
    expect(workflow.match(/secrets\.NPM_TOKEN/g)?.length).toBe(2);
    expect(job("publish").match(/secrets\.NPM_TOKEN/g)?.length).toBe(2);
    expect(job("publish")).toContain("if: needs.preflight.outputs.publish == 'true' && startsWith(github.ref, 'refs/tags/v')");
  });

  it("builds the published tarballs in a job that runs no install scripts, and only that job uploads them", () => {
    expect(job("pack")).toContain("run: npm ci --ignore-scripts");
    expect(job("pack")).not.toMatch(/run: npm ci\s*\n/);
    expect(job("pack")).toContain("node scripts/release/pack.mjs");
    expect(workflow.match(/actions\/upload-artifact@/g)?.length).toBe(1);
    expect(job("pack")).toContain("actions/upload-artifact@");
    expect(job("pack")).toContain("record_sha256: ${{ steps.record.outputs.sha256 }}");
    for (const name of ["verify", "publish"]) expect(job(name)).not.toContain("pack.mjs");
  });

  it("checks every hash against the pack job's output before the smoke test, the dry run and the publish", () => {
    expect(job("verify")).toContain('node scripts/release/smoke.mjs --record-sha256 "$RECORD_SHA256"');
    expect(job("verify")).toContain('node scripts/release/publish.mjs --dry-run --record-sha256 "$RECORD_SHA256"');
    expect(job("publish")).toContain('node scripts/release/publish.mjs --tag "$TAG" --record-sha256 "$RECORD_SHA256"');
    for (const name of ["verify", "publish"]) {
      expect(job(name)).toContain("RECORD_SHA256: ${{ needs.pack.outputs.record_sha256 }}");
      expect(job(name)).toMatch(/needs: \[preflight, pack/);
    }
    expect(job("publish")).toContain("needs: [preflight, pack, verify]");
  });
});
