// GTM-agents: tests for `gtm doctor`.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctorCommand } from "../src/commands/doctor.ts";
import type { CommandRunner } from "../src/lib/io.ts";
import { REPO_ROOT, captureIo } from "./helpers.ts";

const noRemote: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "not expected" });

describe("gtm doctor", () => {
  it("passes the worker template offline, warning about unfilled placeholders", async () => {
    const io = captureIo();
    const code = await doctorCommand(["--config", "apps/worker"], io, { runner: noRemote });
    expect(code).toBe(0);
    const text = io.text();
    expect(text).toMatch(/PASS\s+bindings\s+all 10 required bindings/);
    expect(text).toMatch(/WARN\s+placeholders/);
    expect(text).toMatch(/PASS\s+gtm\.config\.ts\s+Acme/);
    expect(text).toContain("system:halt");
    expect(text).toContain("budget:enforcement");
  });

  it("checks the staging environment's own bindings", async () => {
    const io = captureIo();
    expect(await doctorCommand(["--config", "apps/worker", "--env", "staging"], io, { runner: noRemote })).toBe(0);
    expect(io.text()).toContain("(staging)");
  });

  it("fails a deployment with missing bindings and an invalid config", async () => {
    const io = captureIo();
    const code = await doctorCommand(["--config", "packages/cli/test/fixtures/broken-worker"], io, { runner: noRemote });
    expect(code).toBe(1);
    const text = io.text();
    expect(text).toMatch(/FAIL\s+bindings\s+missing: DB/);
    expect(text).toMatch(/FAIL\s+gtm\.config\.ts/);
  });

  it("validates the manifest of every enabled adapter and adds its required secrets", async () => {
    const io = captureIo();
    const adaptersDir = join(REPO_ROOT, "packages/cli/test/fixtures/adapters");
    expect(await doctorCommand(["--config", "packages/cli/test/fixtures/adapters-worker"], io, { runner: noRemote, adaptersDir })).toBe(1);
    const text = io.text();
    expect(text).toMatch(/PASS\s+adapter email-example/);
    expect(text).toMatch(/FAIL\s+adapter broken-example\s+manifest\.json is invalid/);
    expect(text).toMatch(/FAIL\s+adapter missing-example\s+enabled in gtm\.config\.ts but no manifest/);
    expect(text).toContain("EXAMPLE_EMAIL_KEY");
  });

  it("with --remote, fails on missing secrets and on a flag store it cannot read, and warns when halted", async () => {
    const runner: CommandRunner = async (_cmd, args) => {
      if (args.includes("secret")) return { code: 0, stdout: JSON.stringify([{ name: "GATEWAY_TOKEN", type: "secret_text" }]), stderr: "" };
      if (args.includes("system:halt")) return { code: 0, stdout: '{"reason":"maintenance"}', stderr: "" };
      return { code: 1, stdout: "", stderr: "authentication error" };
    };
    const io = captureIo();
    expect(await doctorCommand(["--config", "apps/worker", "--remote"], io, { runner })).toBe(1);
    const text = io.text();
    expect(text).toMatch(/FAIL\s+secrets\s+missing: UNSUBSCRIBE_SIGNING_KEY/);
    expect(text).toMatch(/WARN\s+halt flag\s+the system is halted/);
    expect(text).toMatch(/FAIL\s+kill switch\s+could not read outreach:cold-pause/);
  });

  it("with --remote, passes when core and adapter secrets are set and the kill-switch flags are unset", async () => {
    const runner: CommandRunner = async (_cmd, args) => {
      if (args.includes("secret")) {
        const names = ["GATEWAY_TOKEN", "UNSUBSCRIBE_SIGNING_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "ANTHROPIC_API_KEY", "EXA_API_KEY", "HUNTER_API_KEY", "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET"];
        return { code: 0, stdout: JSON.stringify(names.map((name) => ({ name }))), stderr: "" };
      }
      return { code: 0, stdout: "Value not found", stderr: "" };
    };
    const io = captureIo();
    expect(await doctorCommand(["--config", "apps/worker", "--remote"], io, { runner })).toBe(0);
    expect(io.text()).toMatch(/PASS\s+secrets\s+all 9 required secrets are set/);
  });
});
