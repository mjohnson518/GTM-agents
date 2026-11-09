// GTM-agents: tests for `gtm init`.
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REQUIRED_BINDINGS } from "@gtm-agents/core/config";
import { describe, expect, it } from "vitest";
import { BUNDLED_TEMPLATE, TEMPLATE_FILES, cliVersion, initCommand } from "../src/commands/init.ts";
import { main } from "../src/index.ts";
import { parseJsonc } from "../src/lib/jsonc.ts";
import { hasBinding } from "../src/lib/wrangler-config.ts";
import { REPO_ROOT, captureIo } from "./helpers.ts";

describe("gtm init", () => {
  it("creates a standalone deployment from the worker template", () => {
    const parent = mkdtempSync(join(tmpdir(), "gtm-init-"));
    const io = captureIo(parent);
    expect(initCommand(["My Agent"], io)).toBe(0);
    const dir = join(parent, "My Agent");
    for (const file of ["wrangler.jsonc", "src/index.ts", "gtm.config.ts", ".dev.vars.example", "brain/README.md", "templates/README.md", "package.json", "tsconfig.json", ".gitignore", "public/admin/index.html"]) {
      expect(existsSync(join(dir, file)), file).toBe(true);
    }
    const raw = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
    const config = parseJsonc(raw) as Record<string, unknown>;
    expect(config.name).toBe("my-agent");
    for (const b of REQUIRED_BINDINGS) expect(hasBinding(config, b), b.name).toBe(true);
    expect(raw).toContain('"migrations_dir": "node_modules/@gtm-agents/core/migrations"');
    expect(raw).toContain('"bucket_name": "my-agent-bucket"');
    expect(raw).toContain('"name": "my-agent-staging"');
    expect(raw).not.toContain("../../");
    expect(raw).not.toContain('"build"');
    expect(raw).toContain("${DB_ID}");
    expect(readFileSync(join(dir, "brain/README.md"), "utf8")).not.toContain("../../../");
    expect(io.text()).toContain("Next steps");
  });

  it("uses an explicit Worker name and local packages when asked", () => {
    const parent = mkdtempSync(join(tmpdir(), "gtm-init-"));
    const checkout = REPO_ROOT.replace(/\/$/, "");
    const io = captureIo(parent);
    expect(initCommand(["agent", "--name", "acme-gtm", "--local", checkout], io)).toBe(0);
    const pkg = readPackage(join(parent, "agent"));
    expect(pkg.name).toBe("acme-gtm");
    expect(pkg.dependencies["@gtm-agents/core"]).toBe(`file:${join(checkout, "packages", "core")}`);
    expect(pkg.dependencies["@gtm-agents/adapters"]).toBe(`file:${join(checkout, "packages", "adapters")}`);
    expect(pkg.devDependencies["@gtm-agents/cli"]).toBe(`file:${join(checkout, "packages", "cli")}`);
    expect(io.text()).toContain("links the packages");
  });

  it("refuses a directory that is not empty, and an invalid Worker name", () => {
    const parent = mkdtempSync(join(tmpdir(), "gtm-init-"));
    mkdirSync(join(parent, "taken"));
    writeFileSync(join(parent, "taken", "file.txt"), "x");
    expect(initCommand(["taken"], captureIo(parent))).toBe(2);
    expect(initCommand(["fresh", "--name", "Not Valid"], captureIo(parent))).toBe(2);
    expect(initCommand([], captureIo(parent))).toBe(2);
  });
});

describe("gtm init install modes", () => {
  it("defaults to npm mode: every package pinned to exactly this CLI's version", () => {
    const parent = mkdtempSync(join(tmpdir(), "gtm-init-"));
    const io = captureIo(parent);
    expect(initCommand(["agent"], io)).toBe(0);
    const pkg = readPackage(join(parent, "agent"));
    const version = cliVersion();
    expect(version).toBe((JSON.parse(readFileSync(join(REPO_ROOT, "packages/cli/package.json"), "utf8")) as { version: string }).version);
    expect(pkg.dependencies["@gtm-agents/core"]).toBe(version);
    expect(pkg.dependencies["@gtm-agents/adapters"]).toBe(version);
    expect(pkg.devDependencies["@gtm-agents/cli"]).toBe(version);
    expect(JSON.stringify(pkg)).not.toContain("file:");
    // Run from this checkout, init says the version may not be published and how to link instead.
    expect(io.text()).toContain(`at ${version} from npm`);
    expect(io.text()).toContain("--local <checkout>");
  });

  it("pins a given release version and copies a given template, as the published CLI does", () => {
    const parent = mkdtempSync(join(tmpdir(), "gtm-init-"));
    const template = fakeTemplate(mkdtempSync(join(tmpdir(), "gtm-template-")), "bundled");
    const io = captureIo(parent);
    expect(initCommand(["agent"], io, { templateDir: template, version: "1.2.3" })).toBe(0);
    const dir = join(parent, "agent");
    const pkg = readPackage(dir);
    expect(pkg.dependencies["@gtm-agents/core"]).toBe("1.2.3");
    expect(pkg.devDependencies["@gtm-agents/cli"]).toBe("1.2.3");
    expect(readFileSync(join(dir, "gtm.config.ts"), "utf8")).toContain("template marker: bundled");
    expect(readFileSync(join(dir, "public/admin/index.html"), "utf8")).toContain("built dashboard: bundled");
    expect(io.text()).not.toContain("runs from a checkout");
  });

  it("takes the template from the --local checkout, not from wherever the CLI runs", () => {
    const checkout = mkdtempSync(join(tmpdir(), "gtm-checkout-"));
    mkdirSync(join(checkout, "packages", "core"), { recursive: true });
    writeFileSync(join(checkout, "packages", "core", "package.json"), "{}\n");
    fakeTemplate(join(checkout, "apps", "worker"), "checkout");
    const parent = mkdtempSync(join(tmpdir(), "gtm-init-"));
    expect(initCommand(["agent", "--local", checkout], captureIo(parent))).toBe(0);
    expect(readFileSync(join(parent, "agent", "gtm.config.ts"), "utf8")).toContain("template marker: checkout");
  });

  it("looks for the bundled template beside its compiled commands, where the release build puts it", () => {
    // scripts/release/pack.mjs writes the template to dist/template; src/ and dist/ share a layout.
    expect(BUNDLED_TEMPLATE).toBe(join(REPO_ROOT, "packages", "cli", "src", "template") + "/");
    expect(existsSync(BUNDLED_TEMPLATE)).toBe(false);
  });

  it("refuses a --local path that is not a checkout", () => {
    const parent = mkdtempSync(join(tmpdir(), "gtm-init-"));
    const io = captureIo(parent);
    expect(initCommand(["agent", "--local", parent], io)).toBe(2);
    expect(io.text()).toContain("not a checkout");
    expect(existsSync(join(parent, "agent"))).toBe(false);
  });

  it("points migrations and assets at paths that exist after npm install, in both modes", () => {
    const parent = mkdtempSync(join(tmpdir(), "gtm-init-"));
    expect(initCommand(["npm-agent"], captureIo(parent), { version: "1.2.3" })).toBe(0);
    expect(initCommand(["local-agent", "--local", REPO_ROOT], captureIo(parent))).toBe(0);
    for (const project of ["npm-agent", "local-agent"]) {
      const dir = join(parent, project);
      const config = parseJsonc(readFileSync(join(dir, "wrangler.jsonc"), "utf8")) as {
        assets: { directory: string };
        d1_databases: { migrations_dir: string }[];
        env: { staging: { d1_databases: { migrations_dir: string }[] } };
      };
      // The installed core package carries its migrations at this path, whether linked or installed.
      for (const db of [...config.d1_databases, ...config.env.staging.d1_databases]) expect(db.migrations_dir, project).toBe("node_modules/@gtm-agents/core/migrations");
      expect(config.assets.directory, project).toBe("./public");
      expect(existsSync(join(dir, "public", "admin", "index.html")), project).toBe(true);
    }
    expect(existsSync(join(REPO_ROOT, "packages", "core", "migrations", "0001_baseline.sql"))).toBe(true);
  });
});

function readPackage(dir: string): { name: string; dependencies: Record<string, string>; devDependencies: Record<string, string> } {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; dependencies: Record<string, string>; devDependencies: Record<string, string> };
}

/** A copy of the worker template with a marker in gtm.config.ts and a built dashboard. */
function fakeTemplate(dir: string, marker: string): string {
  for (const file of TEMPLATE_FILES) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(REPO_ROOT, "apps", "worker", file), join(dir, file));
  }
  writeFileSync(join(dir, "gtm.config.ts"), `// template marker: ${marker}\n${readFileSync(join(dir, "gtm.config.ts"), "utf8")}`);
  mkdirSync(join(dir, "public", "admin"), { recursive: true });
  writeFileSync(join(dir, "public", "admin", "index.html"), `<!doctype html><title>built dashboard: ${marker}</title>\n`);
  return dir;
}

describe("gtm", () => {
  it("prints help and rejects unknown commands", async () => {
    const io = captureIo();
    expect(await main([], io)).toBe(0);
    expect(io.text()).toContain("Usage: gtm <command>");
    expect(await main(["frobnicate"], captureIo())).toBe(2);
  });

  it("lists every command in its help, and none as unavailable", async () => {
    const io = captureIo();
    expect(await main(["--help"], io)).toBe(0);
    for (const command of ["init", "setup", "migrate", "brain validate", "brain upload", "brain diff", "flags", "doctor", "deploy"]) expect(io.text()).toContain(`  ${command}`);
    expect(io.text()).not.toContain("not available");
    const sub = captureIo();
    expect(await main(["setup", "--help"], sub)).toBe(0);
    expect(sub.text()).toContain("Usage: gtm <command>");
  });
});

describe("the worker template's cron trigger", () => {
  const crons = (config: Record<string, unknown>) => (config.triggers as { crons: string[] }).crons;

  it("has exactly the per-minute trigger, at the top level and in staging", () => {
    const config = parseJsonc(readFileSync(join(REPO_ROOT, "apps/worker/wrangler.jsonc"), "utf8")) as Record<string, unknown> & { env: { staging: Record<string, unknown> } };
    expect(crons(config)).toEqual(["* * * * *"]);
    expect(crons(config.env.staging)).toEqual(["* * * * *"]);
  });

  it("keeps it in the copy gtm init makes", () => {
    const parent = mkdtempSync(join(tmpdir(), "gtm-init-"));
    expect(initCommand(["agent"], captureIo(parent))).toBe(0);
    const config = parseJsonc(readFileSync(join(parent, "agent", "wrangler.jsonc"), "utf8")) as Record<string, unknown> & { env: { staging: Record<string, unknown> } };
    expect(crons(config)).toEqual(["* * * * *"]);
    expect(crons(config.env.staging)).toEqual(["* * * * *"]);
  });
});
