// GTM-agents: tests for `gtm init`.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REQUIRED_BINDINGS } from "@gtm-agents/core/config";
import { describe, expect, it } from "vitest";
import { initCommand } from "../src/commands/init.ts";
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
    expect(initCommand(["agent", "--name", "acme-gtm", "--local", "/opt/gtm-agents"], captureIo(parent))).toBe(0);
    const pkg = JSON.parse(readFileSync(join(parent, "agent", "package.json"), "utf8")) as { name: string; dependencies: Record<string, string> };
    expect(pkg.name).toBe("acme-gtm");
    expect(pkg.dependencies["@gtm-agents/core"]).toBe("file:/opt/gtm-agents/packages/core");
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
