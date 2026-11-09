// GTM-agents: tests for `gtm doctor`.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctorCommand, jobsQueueCheck, triggerCheck } from "../src/commands/doctor.ts";
import type { CommandRunner } from "../src/lib/io.ts";
import { ADAPTERS_DIR, makeDeployment, setUpDeployment } from "./deployment.ts";
import { FakeAccount } from "./fake-wrangler.ts";
import { REPO_ROOT, captureIo } from "./helpers.ts";

/** Answers `wrangler kv bulk get` with these values for the keys in the request file. */
function bulkGet(values: Record<string, string | null>, args: string[]): { code: number; stdout: string; stderr: string } {
  const keys = JSON.parse(readFileSync(args[args.indexOf("get") + 1] ?? "", "utf8")) as string[];
  return { code: 0, stdout: JSON.stringify(Object.fromEntries(keys.map((k) => [k, values[k] ?? null]))), stderr: "" };
}

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
      if (args.includes("bulk")) return bulkGet({ "system:halt": '{"reason":"maintenance"}' }, args);
      return { code: 1, stdout: "", stderr: "authentication error" };
    };
    const io = captureIo();
    expect(await doctorCommand(["--config", "apps/worker", "--remote"], io, { runner })).toBe(1);
    const text = io.text();
    expect(text).toMatch(/FAIL\s+secrets\s+missing: UNSUBSCRIBE_SIGNING_KEY/);
    expect(text).toMatch(/WARN\s+halt flag\s+the system is halted/);
    expect(text).toMatch(/PASS\s+kill switch\s+outreach:cold-pause is unset/);
  });

  it("with --remote, fails every stop flag when the flag store cannot be read", async () => {
    const runner: CommandRunner = async (_cmd, args) =>
      args.includes("secret") ? { code: 0, stdout: "[]", stderr: "" } : { code: 1, stdout: "", stderr: "X [ERROR] Authentication error [code: 10000]" };
    const io = captureIo();
    expect(await doctorCommand(["--config", "apps/worker", "--remote"], io, { runner })).toBe(1);
    const text = io.text();
    expect(text).toMatch(/FAIL\s+halt flag\s+could not read system:halt/);
    expect(text).toMatch(/FAIL\s+kill switch \(critical\)\s+could not read/);
    expect(text).toMatch(/FAIL\s+kill switch\s+could not read outreach:cold-pause/);
  });

  it("with --remote, passes when core and adapter secrets are set and the kill-switch flags are unset", async () => {
    const runner: CommandRunner = async (_cmd, args) => {
      if (args.includes("secret")) {
        const names = ["GATEWAY_TOKEN", "UNSUBSCRIBE_SIGNING_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "ANTHROPIC_API_KEY", "EXA_API_KEY", "HUNTER_API_KEY", "RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN", "GOOGLE_CALENDAR_REFRESH_TOKEN"];
        return { code: 0, stdout: JSON.stringify(names.map((name) => ({ name }))), stderr: "" };
      }
      return bulkGet({}, args);
    };
    const io = captureIo();
    expect(await doctorCommand(["--config", "apps/worker", "--remote"], io, { runner })).toBe(0);
    expect(io.text()).toMatch(/PASS\s+secrets\s+all 13 required secrets are set/);
  });

  it("passes exactly one per-minute cron trigger and fails a missing or extra one", () => {
    expect(triggerCheck(["* * * * *"]).status).toBe("PASS");
    expect(triggerCheck([]).status).toBe("FAIL");
    expect(triggerCheck(["0 9 * * MON-FRI"]).detail).toContain("no per-minute trigger");
    const extra = triggerCheck(["* * * * *", "0 9 * * MON-FRI"]);
    expect(extra.status).toBe("FAIL");
    expect(extra.detail).toContain('"0 9 * * MON-FRI"');
    expect(triggerCheck(["* * * * *", "* * * * *"]).status).toBe("FAIL");
  });

  it("checks the jobs queue: optional, but once bound it needs a consumer, one job per batch and a watched dead-letter queue", () => {
    const producers = [{ binding: "JOBS_QUEUE", queue: "acme-gtm-jobs" }];
    const good = { queues: { producers, consumers: [
      { queue: "acme-gtm-jobs", max_batch_size: 1, max_retries: 1, dead_letter_queue: "acme-gtm-jobs-dlq" },
      { queue: "acme-gtm-jobs-dlq", max_batch_size: 10, max_retries: 0 },
    ] } };
    expect(jobsQueueCheck(good).status).toBe("PASS");
    expect(jobsQueueCheck({ queues: { producers: [] } })).toMatchObject({ status: "INFO" });
    expect(jobsQueueCheck({ queues: { producers, consumers: [] } })).toMatchObject({ status: "FAIL" });
    const batched = jobsQueueCheck({ queues: { producers, consumers: [{ queue: "acme-gtm-jobs", max_batch_size: 10, max_retries: 5 }] } });
    expect(batched.status).toBe("WARN");
    expect(batched.detail).toContain("max_batch_size to 1");
    expect(batched.detail).toContain("max_retries is 5");
    expect(batched.detail).toContain("dead_letter_queue");
    const unwatched = jobsQueueCheck({ queues: { producers, consumers: [{ queue: "acme-gtm-jobs", max_batch_size: 1, max_retries: 0, dead_letter_queue: "acme-gtm-jobs-dlq" }] } });
    expect(unwatched).toMatchObject({ status: "WARN" });
    expect(unwatched.detail).toContain("consumer for its dead-letter queue");
  });

  it("passes the template's jobs queue, in production and staging", async () => {
    for (const args of [[], ["--env", "staging"]]) {
      const io = captureIo();
      await doctorCommand(["--config", "apps/worker", ...args], io, { runner: noRemote });
      expect(io.text()).toMatch(/PASS\s+jobs queue\s+due jobs go to \$\{(STAGING_)?JOBS_QUEUE_NAME\}/);
    }
  });

  it("checks the trigger an environment inherits from the top level", async () => {
    const dir = makeDeployment();
    const path = join(dir, "wrangler.jsonc");
    writeFileSync(path, readFileSync(path, "utf8").replace(/,\n\s*"triggers": \{ "crons": \["\* \* \* \* \*"\] \}\n(\s*\}\n\s*\}\n\})/, "\n$1"));
    const io = captureIo(dir);
    await doctorCommand(["--env", "staging"], io, { runner: noRemote, adaptersDir: ADAPTERS_DIR });
    expect(io.text()).toMatch(/PASS\s+cron trigger/);
    writeFileSync(path, readFileSync(path, "utf8").replace('"triggers": { "crons": ["* * * * *"] },', '"triggers": { "crons": [] },'));
    const after = captureIo(dir);
    expect(await doctorCommand(["--env", "staging"], after, { runner: noRemote, adaptersDir: ADAPTERS_DIR })).toBe(1);
    expect(after.text()).toMatch(/FAIL\s+cron trigger\s+no per-minute trigger/);
  });

  it("counts only the selected environment's placeholders", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account);
    const production = captureIo(dir);
    await doctorCommand([], production, { runner: noRemote, adaptersDir: ADAPTERS_DIR });
    expect(production.text()).toMatch(/PASS\s+placeholders/);
    const staging = captureIo(dir);
    await doctorCommand(["--env", "staging"], staging, { runner: noRemote, adaptersDir: ADAPTERS_DIR });
    expect(staging.text()).toMatch(/WARN\s+placeholders.*run gtm setup --env staging/);
  });
});
