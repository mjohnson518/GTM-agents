// GTM-agents: tests for `gtm flags`: keys and values are checked against the flag registry before
// anything is written, permanently human-only autonomy can never rise above 1, and reads and writes
// go to the remote KV namespace.
import { describe, expect, it } from "vitest";
import { flagsCommand, validateFlagValue } from "../src/commands/flags.ts";
import { makeDeployment, setUpDeployment } from "./deployment.ts";
import { FakeAccount } from "./fake-wrangler.ts";
import { captureIo } from "./helpers.ts";

async function flags(dir: string, account: FakeAccount, args: string[]) {
  const io = captureIo(dir);
  const code = await flagsCommand(args, io, { runner: account.runner });
  return { code, text: io.text() };
}

describe("flag validation", () => {
  it("normalizes booleans and checks numbers and JSON", () => {
    expect(validateFlagValue("cold_batch:enabled", "on")).toMatchObject({ ok: true, value: "true" });
    expect(validateFlagValue("cold_batch:enabled", "No")).toMatchObject({ ok: true, value: "false" });
    expect(validateFlagValue("cold_batch:enabled", "maybe")).toMatchObject({ ok: false });
    expect(validateFlagValue("delivery:domain_daily_cap", "250")).toMatchObject({ ok: true, value: "250" });
    expect(validateFlagValue("delivery:domain_daily_cap", "lots")).toMatchObject({ ok: false });
    expect(validateFlagValue("system:halt", '{"reason":"maintenance"}')).toMatchObject({ ok: true });
    expect(validateFlagValue("system:halt", "{reason")).toMatchObject({ ok: false });
    expect(validateFlagValue("budget:job:discovery_cycle:daily_cents", "300")).toMatchObject({ ok: true });
  });

  it("refuses values the runtime would read as an error or clamp", () => {
    expect(validateFlagValue("budget:daily_limit_cents", "12.5")).toMatchObject({ ok: false });
    expect(validateFlagValue("budget:daily_limit_cents", "-5")).toMatchObject({ ok: false });
    expect(validateFlagValue("delivery:domain_daily_cap", "1.5")).toMatchObject({ ok: false });
    expect(validateFlagValue("budget:enforcement", "Hard")).toMatchObject({ ok: false });
    expect(validateFlagValue("budget:enforcement", "hard")).toMatchObject({ ok: true });
    expect(validateFlagValue("budget:alert_threshold", "0")).toMatchObject({ ok: false });
    expect(validateFlagValue("budget:alert_threshold", "0.9")).toMatchObject({ ok: true });
    expect(validateFlagValue("outreach:holdout_rate", "0.5")).toMatchObject({ ok: false });
    expect(validateFlagValue("outreach:holdout_rate", "0.1")).toMatchObject({ ok: true });
    expect(validateFlagValue("classifier_tier:triage", "maybe")).toMatchObject({ ok: false });
    expect(validateFlagValue("system:halt", "false")).toMatchObject({ ok: false });
    expect(validateFlagValue("system:halt", "1")).toMatchObject({ ok: false });
  });

  it("refuses unknown keys, patterns and empty values", () => {
    expect(validateFlagValue("brain:lock", "{}")).toMatchObject({ ok: false });
    expect(validateFlagValue("cold_batch:enabld", "true")).toMatchObject({ ok: false });
    expect(validateFlagValue("autonomy:<class>", "1")).toMatchObject({ ok: false });
    expect(validateFlagValue("cold_batch:enabled", "  ")).toMatchObject({ ok: false });
  });

  it("never sets a permanently human-only action class above 1", () => {
    for (const actionClass of ["merge_code", "pricing_billing_auth", "offers", "proof_of_value_send", "data_deletion"]) {
      expect(validateFlagValue(`autonomy:${actionClass}`, "2")).toMatchObject({ ok: false });
      expect(validateFlagValue(`autonomy:${actionClass}`, "3")).toMatchObject({ ok: false });
      expect(validateFlagValue(`autonomy:${actionClass}`, "1")).toMatchObject({ ok: true, value: "1" });
    }
    expect(validateFlagValue("autonomy:cold_batch", "3")).toMatchObject({ ok: true, value: "3" });
    expect(validateFlagValue("autonomy:cold_batch", "4")).toMatchObject({ ok: false });
    expect(validateFlagValue("autonomy:not_a_class", "1")).toMatchObject({ ok: false });
  });
});

describe("gtm flags", () => {
  it("sets a flag in the remote namespace, normalized, and reads it back", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account);
    expect((await flags(dir, account, ["set", "cold_batch:enabled", "on", "--yes"])).code).toBe(0);
    expect(account.store().get("cold_batch:enabled")).toBe("true");
    const put = account.callsTo("kv", "bulk", "put")[0];
    expect(put?.args).toEqual(expect.arrayContaining(["--binding", "KV", "--remote"]));
    expect(put?.args).not.toContain("--env");
    const got = await flags(dir, account, ["get", "cold_batch:enabled"]);
    expect(got.text).toContain("cold_batch:enabled = true");
  });

  it("asks before writing a production flag, needs --yes without a terminal, and writes staging without asking", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account);
    expect((await flags(dir, account, ["set", "cold_batch:enabled", "true"])).code).toBe(2);
    expect((await flags(dir, account, ["unset", "cold_batch:enabled"])).code).toBe(2);
    expect(account.calls).toEqual([]);
    const io = captureIo(dir);
    io.confirm = async () => false;
    expect(await flagsCommand(["set", "cold_batch:enabled", "true"], io, { runner: account.runner })).toBe(0);
    expect(account.store().has("cold_batch:enabled")).toBe(false);
    expect((await flags(dir, account, ["get", "cold_batch:enabled"])).code).toBe(0);
  });

  it("refuses before calling Wrangler when the key or value is wrong", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account);
    expect((await flags(dir, account, ["set", "autonomy:offers", "2"])).code).toBe(2);
    expect((await flags(dir, account, ["set", "not:a_flag", "1"])).code).toBe(2);
    expect((await flags(dir, account, ["get", "brain:lock"])).code).toBe(2);
    expect((await flags(dir, account, ["set", "cold_batch:enabled"])).code).toBe(2);
    expect(account.calls).toEqual([]);
  });

  it("lists every flag with its default and remote value, including members of a pattern family", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account);
    const kv = account.store();
    kv.set("discovery:enabled", "true");
    kv.set("autonomy:cold_batch", "2");
    kv.set("brain:lock", "{}");
    const { code, text } = await flags(dir, account, ["list"]);
    expect(code).toBe(0);
    expect(text).toMatch(/discovery:enabled\s+false\s+true/);
    expect(text).toMatch(/system:halt\s+unset\s+unset/);
    expect(text).toMatch(/autonomy:<class>\s+1/);
    expect(text).toMatch(/\n {4}autonomy:cold_batch\s+2/);
    expect(text).not.toContain("brain:lock");
    expect(account.callsTo("kv", "bulk", "get")[0]?.file).toEqual(["autonomy:cold_batch", "discovery:enabled"]);
  });

  it("unsets a flag remotely, and reports an unset flag's default", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account);
    account.store().set("delivery:enabled", "true");
    expect((await flags(dir, account, ["unset", "delivery:enabled", "--yes"])).code).toBe(0);
    expect(account.callsTo("kv", "key", "delete")[0]?.args).toEqual(["kv", "key", "delete", "delivery:enabled", "--binding", "KV", "--remote"]);
    expect((await flags(dir, account, ["get", "delivery:enabled"])).text).toContain("delivery:enabled is unset (default: false)");
  });

  it("targets the staging namespace with --env staging", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account, { env: "staging" });
    expect((await flags(dir, account, ["set", "ops:daily_scorecard", "true", "--env", "staging"])).code).toBe(0);
    expect(account.store("staging").get("ops:daily_scorecard")).toBe("true");
    expect(account.store().has("ops:daily_scorecard")).toBe(false);
  });

  it("asks for gtm setup while the KV id is still a placeholder", async () => {
    const account = new FakeAccount();
    const { code, text } = await flags(makeDeployment(), account, ["list"]);
    expect(code).toBe(1);
    expect(text).toContain("run gtm setup");
    expect(account.calls).toEqual([]);
  });
});
