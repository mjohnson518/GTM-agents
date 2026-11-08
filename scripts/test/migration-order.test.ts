// GTM-agents: tests for the migration order and idempotency check.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkMigrationNames, checkMigrationSql, checkMigrationsDir } from "../check-migration-order.mjs";

const goodTable = `CREATE TABLE IF NOT EXISTS widgets (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_widgets_created ON widgets(created_at);`;

describe("check-migration-order: names", () => {
  it("accepts a contiguous sequence", () => {
    expect(checkMigrationNames(["0001_baseline.sql", "0002_widgets.sql"])).toEqual([]);
  });

  it("rejects a gap, a duplicate number and a bad name", () => {
    const rules = checkMigrationNames(["0001_a.sql", "0003_c.sql", "0003_d.sql", "4_bad.sql"]).map((f) => f.rule);
    expect(rules).toEqual(expect.arrayContaining(["gap", "duplicate", "name"]));
  });
});

describe("check-migration-order: statements", () => {
  it("accepts idempotent DDL with created_at", () => {
    expect(checkMigrationSql("0001_widgets.sql", goodTable)).toEqual([]);
  });

  it("rejects CREATE without IF NOT EXISTS and DROP without IF EXISTS", () => {
    const sql = "CREATE TABLE gadgets (id TEXT, created_at TEXT);\nDROP INDEX idx_old;";
    expect(checkMigrationSql("0002.sql", sql).map((f) => f.rule)).toEqual(["not-idempotent", "not-idempotent"]);
  });

  it("rejects a seed without OR IGNORE", () => {
    const sql = "INSERT INTO widgets (id) VALUES ('w1');";
    expect(checkMigrationSql("0002.sql", sql).map((f) => f.rule)).toEqual(["not-idempotent"]);
    expect(checkMigrationSql("0002.sql", "INSERT OR IGNORE INTO widgets (id) VALUES ('w1');")).toEqual([]);
  });

  it("requires a -- once: comment before ADD COLUMN", () => {
    expect(checkMigrationSql("0003.sql", "ALTER TABLE widgets ADD COLUMN color TEXT;").map((f) => f.rule)).toEqual([
      "unguarded-alter",
    ]);
    const guarded = "-- once: applied a single time by the migration runner\nALTER TABLE widgets ADD COLUMN color TEXT;";
    expect(checkMigrationSql("0003.sql", guarded)).toEqual([]);
  });

  it("requires created_at on every table", () => {
    const sql = "CREATE TABLE IF NOT EXISTS widgets (\n  id TEXT PRIMARY KEY,\n  CHECK (id <> '')\n);";
    expect(checkMigrationSql("0002.sql", sql).map((f) => f.rule)).toEqual(["created-at"]);
  });

  it("passes when the directory does not exist yet", () => {
    expect(checkMigrationsDir(join(tmpdir(), "gtm-no-such-migrations-dir"))).toEqual({ findings: [], count: 0 });
  });

  it("checks names and contents of a real directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "gtm-migrations-"));
    writeFileSync(join(dir, "0001_widgets.sql"), goodTable);
    writeFileSync(join(dir, "0002_gadgets.sql"), "CREATE TABLE gadgets (id TEXT, created_at TEXT);");
    const { findings, count } = checkMigrationsDir(dir);
    expect(count).toBe(2);
    expect(findings.map((f) => `${f.file}:${f.rule}`)).toEqual(["0002_gadgets.sql:not-idempotent"]);
  });
});
