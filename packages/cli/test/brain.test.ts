// GTM-agents: tests for `gtm brain validate`.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/index.ts";
import { REPO_ROOT, captureIo } from "./helpers.ts";

function copyAcme(): string {
  const dir = mkdtempSync(join(tmpdir(), "gtm-brain-"));
  cpSync(join(REPO_ROOT, "examples/brains/acme"), join(dir, "acme"), { recursive: true });
  return join(dir, "acme");
}

describe("gtm brain validate", () => {
  it("passes the example brain with its lock and templates", async () => {
    const io = captureIo();
    expect(await main(["brain", "validate", "examples/brains/acme"], io)).toBe(0);
    expect(io.text()).toMatch(/14 component\(s\), 10 template\(s\), 0 error\(s\), 0 warning\(s\), version [0-9a-f]{12}/);
  });

  it("fails when an approved file changed after it was locked, and --write-lock fixes it", async () => {
    const dir = copyAcme();
    const facts = join(dir, "facts.md");
    writeFileSync(facts, readFileSync(facts, "utf8").replace("under an hour", "in minutes"));
    const io = captureIo(dir);
    expect(await main(["brain", "validate", "."], io)).toBe(1);
    expect(io.text()).toContain("facts.md changed since it was locked");

    const relock = captureIo(dir);
    expect(await main(["brain", "validate", ".", "--write-lock"], relock)).toBe(0);
    expect(await main(["brain", "validate", "."], captureIo(dir))).toBe(0);
  });

  it("refuses to write a lock while there are errors", async () => {
    const dir = copyAcme();
    const lockBefore = readFileSync(join(dir, "brain.lock.json"), "utf8");
    writeFileSync(join(dir, "voice.md"), readFileSync(join(dir, "voice.md"), "utf8").replace("kind: do", "kind: maybe"));
    const io = captureIo(dir);
    expect(await main(["brain", "validate", ".", "--write-lock"], io)).toBe(1);
    expect(readFileSync(join(dir, "brain.lock.json"), "utf8")).toBe(lockBefore);
  });

  it("checks template links against the company domain", async () => {
    const dir = copyAcme();
    const tpl = join(dir, "templates", "follow-up.md");
    writeFileSync(tpl, readFileSync(tpl, "utf8").replace("{{booking_url}}", "https://elsewhere.example/book"));
    const io = captureIo(dir);
    expect(await main(["brain", "validate", ".", "--domain", "acme.example"], io)).toBe(1);
    expect(io.text()).toContain("is not allowed");
  });

  it("explains usage errors and missing directories", async () => {
    expect(await main(["brain"], captureIo())).toBe(2);
    expect(await main(["brain", "validate", "no/such/dir"], captureIo())).toBe(2);
  });
});
