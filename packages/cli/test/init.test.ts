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
import { captureIo } from "./helpers.ts";

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

  it.each(["setup", "migrate", "flags", "deploy"])("explains that %s is not available yet", async (command) => {
    const io = captureIo();
    expect(await main([command], io)).toBe(2);
    expect(io.text()).toContain("not available in this version");
  });

  it.each([["brain", "upload"], ["brain", "diff"]])("explains that %s %s is not available yet", async (a, b) => {
    const io = captureIo();
    expect(await main([a, b], io)).toBe(2);
    expect(io.text()).toContain("not available in this version");
  });
});
