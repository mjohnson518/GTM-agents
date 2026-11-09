// GTM-agents: tests for `gtm migrate`: it checks the migration file order and the DB binding first,
// then applies the migrations remotely (or locally with --local) through Wrangler.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateCommand, migrationNameProblems } from "../src/commands/migrate.ts";
import { makeDeployment, setUpDeployment } from "./deployment.ts";
import { FakeAccount } from "./fake-wrangler.ts";
import { captureIo } from "./helpers.ts";

async function migrate(dir: string, account: FakeAccount, args: string[] = []) {
  const io = captureIo(dir);
  const code = await migrateCommand(args, io, { runner: account.runner });
  return { code, text: io.text() };
}

describe("migration order", () => {
  it("accepts 0001, 0002, ... and names gaps, duplicates and bad names", () => {
    expect(migrationNameProblems(["0001_a.sql", "0002_b.sql", "README.md"])).toEqual([]);
    expect(migrationNameProblems(["0001_a.sql", "0003_c.sql"]).join(" ")).toContain("expected migration 0002");
    expect(migrationNameProblems(["0001_a.sql", "0001_b.sql"]).join(" ")).toContain("also used by");
    expect(migrationNameProblems(["0001_a.sql", "Add-Table.sql"]).join(" ")).toContain("migration names look like");
    expect(migrationNameProblems([])).toEqual(["no .sql migrations were found"]);
  });
});

describe("gtm migrate", () => {
  it("asks before migrating production, needs --yes without a terminal, and never asks for staging or --local", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account);
    expect((await migrate(dir, account)).code).toBe(2);
    const declined = captureIo(dir);
    declined.confirm = async () => false;
    expect(await migrateCommand([], declined, { runner: account.runner })).toBe(0);
    expect(account.calls).toEqual([]);
    const accepted = captureIo(dir);
    let asked = "";
    accepted.confirm = async (q) => ((asked = q), true);
    expect(await migrateCommand([], accepted, { runner: account.runner })).toBe(0);
    expect(asked).toContain("in production");
    expect((await migrate(dir, account, ["--local"])).code).toBe(0);
    expect(account.calls.map((c) => c.args.at(4))).toEqual(["--remote", "--local"]);
  });

  it("applies the migrations to the remote DB binding", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account);
    const { code, text } = await migrate(dir, account, ["--yes"]);
    expect(code).toBe(0);
    expect(account.calls.map((c) => c.args)).toEqual([["d1", "migrations", "apply", "DB", "--remote"]]);
    expect(text).toContain("production database is up to date");
  });

  it("passes --env and --local through", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account, { env: "staging" });
    expect((await migrate(dir, account, ["--env", "staging"])).code).toBe(0);
    expect((await migrate(dir, account, ["--local"])).code).toBe(0);
    expect(account.calls.map((c) => c.args)).toEqual([
      ["d1", "migrations", "apply", "DB", "--remote", "--env", "staging"],
      ["d1", "migrations", "apply", "DB", "--local"],
    ]);
  });

  it("refuses before calling Wrangler while the database id is a placeholder or the files are out of order", async () => {
    const account = new FakeAccount();
    const fresh = await migrate(makeDeployment(), account);
    expect(fresh.code).toBe(1);
    expect(fresh.text).toContain("run gtm setup");

    const dir = await setUpDeployment(account);
    writeFileSync(join(dir, "node_modules/@gtm-agents/core/migrations/0004_skipped.sql"), "SELECT 1;\n");
    const gap = await migrate(dir, account);
    expect(gap.code).toBe(1);
    expect(gap.text).toContain("expected migration 0003");
    expect(account.calls).toEqual([]);
  });

  it("fails when Wrangler does", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account);
    account.intercept = () => ({ code: 1, stdout: "", stderr: "X [ERROR] near \"TABLEE\": syntax error" });
    const { code, text } = await migrate(dir, account, ["--yes"]);
    expect(code).toBe(1);
    expect(text).toContain("syntax error");
  });
});
