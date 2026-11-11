// GTM-agents: tests for `gtm deploy`: doctor, placeholders, migrations and the brain diff come before
// wrangler deploy, each stop is honoured, and --dry-run changes nothing.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deployCommand } from "../src/commands/deploy.ts";
import { ADAPTERS_DIR, makeDeployment, setUpDeployment } from "./deployment.ts";
import { FakeAccount } from "./fake-wrangler.ts";
import { captureIo } from "./helpers.ts";

async function deploy(dir: string, account: FakeAccount, args: string[] = []) {
  const io = captureIo(dir);
  const code = await deployCommand(args, io, { runner: account.runner, adaptersDir: ADAPTERS_DIR });
  return { code, text: io.text() };
}

// gtm deploy runs doctor offline, so it never resolves DNS; the global fetch fails the test if it tries.
beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("gtm deploy tests must not reach the network");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const steps = (account: FakeAccount) => account.calls.map((c) => c.args.slice(0, 3).join(" "));

describe("gtm deploy", () => {
  it("migrates, compares the brain, then deploys, in that order", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account, { brain: true });
    const { code, text } = await deploy(dir, account, ["--yes"]);
    expect(code).toBe(0);
    expect(steps(account)).toEqual(["d1 migrations apply", "kv bulk get", "deploy"]);
    expect(account.calls.at(-1)?.args).toEqual(["deploy"]);
    expect(text).toContain("WARN  the uploaded brain or templates differ");
    expect(text).toContain("gtm deploy: deployed production");
  });

  it("asks before deploying production, and needs --yes without a terminal", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account);
    const { code, text } = await deploy(dir, account);
    expect(code).toBe(2);
    expect(text).toContain("--yes");
    expect(steps(account)).toEqual([]);
  });

  it("stops on a doctor FAIL and deploys nothing", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account);
    const path = join(dir, "wrangler.jsonc");
    writeFileSync(path, readFileSync(path, "utf8").replace('"triggers": { "crons": ["* * * * *"] },', '"triggers": { "crons": [] },'));
    const { code, text } = await deploy(dir, account);
    expect(code).toBe(1);
    expect(text).toMatch(/FAIL\s+cron trigger/);
    expect(steps(account)).toEqual([]);
  });

  it("stops while placeholders remain", async () => {
    const account = new FakeAccount();
    const { code, text } = await deploy(makeDeployment(), account);
    expect(code).toBe(1);
    expect(text).toContain("run gtm setup");
    expect(steps(account)).toEqual([]);
  });

  it("does not deploy when the migrations fail", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account);
    account.intercept = (args) => (args[0] === "d1" ? { code: 1, stdout: "", stderr: "X [ERROR] D1_ERROR: no such table" } : undefined);
    const { code } = await deploy(dir, account, ["--yes"]);
    expect(code).toBe(1);
    expect(steps(account)).toEqual(["d1 migrations apply"]);
  });

  it("with --dry-run lists pending migrations and bundles without deploying or applying", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account, { env: "staging" });
    const { code, text } = await deploy(dir, account, ["--dry-run", "--env", "staging"]);
    expect(code).toBe(0);
    expect(steps(account)).toEqual(["d1 migrations list", "kv bulk get", "deploy --env staging"]);
    expect(account.calls[0]?.args).toEqual(["d1", "migrations", "list", "DB", "--remote", "--env", "staging"]);
    expect(account.calls[1]?.args).toEqual(expect.arrayContaining(["--remote", "--env", "staging"]));
    expect(account.calls[2]?.args).toEqual(["deploy", "--env", "staging", "--dry-run"]);
    expect(text).toContain("nothing was changed");
  });

  it("with --dry-run on a fresh template, skips the resource checks and still bundles", async () => {
    const account = new FakeAccount();
    const { code } = await deploy(makeDeployment(), account, ["--dry-run"]);
    expect(code).toBe(0);
    expect(account.calls.map((c) => c.args)).toEqual([["deploy", "--dry-run"]]);
  });
});
