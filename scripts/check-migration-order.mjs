#!/usr/bin/env node
// GTM-agents: migration order and idempotency check.
//
// D1 applies migrations in filename order and records which ones ran. This check keeps the
// directory safe to apply on a fresh database and safe to re-run by hand:
//   - names are NNNN_snake_case.sql, numbered from 0001 with no gaps or duplicates
//   - CREATE TABLE / INDEX / TRIGGER / VIEW use IF NOT EXISTS; DROP uses IF EXISTS
//   - seed rows use INSERT OR IGNORE (or OR REPLACE)
//   - ALTER TABLE ... ADD COLUMN, which SQLite cannot guard, is preceded by a comment line that
//     starts with "-- once:" explaining that it relies on the migration runner
//   - every table (except virtual tables) has a created_at column
//
// Usage: node scripts/check-migration-order.mjs [directory]   (default: packages/core/migrations)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isMain, repoRoot, report } from "./lib/files.mjs";

const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** @typedef {import("./lib/files.mjs").Finding} Finding */

/**
 * @param {string[]} names file names in the migrations directory
 * @returns {Finding[]}
 */
export function checkMigrationNames(names) {
  /** @type {Finding[]} */
  const findings = [];
  const sql = names.filter((n) => n.endsWith(".sql")).sort();
  /** @type {Map<number, string>} */
  const seen = new Map();
  for (const name of sql) {
    const m = NAME.exec(name);
    if (!m) {
      findings.push({ file: name, line: 0, rule: "name", detail: "migration names must look like 0001_create_contacts.sql" });
      continue;
    }
    const num = Number(m[1]);
    const prior = seen.get(num);
    if (prior) findings.push({ file: name, line: 0, rule: "duplicate", detail: `number ${m[1]} is also used by ${prior}` });
    seen.set(num, name);
  }
  const numbers = [...seen.keys()].sort((a, b) => a - b);
  numbers.forEach((num, i) => {
    if (num !== i + 1) {
      const name = seen.get(num) ?? String(num);
      findings.push({ file: name, line: 0, rule: "gap", detail: `expected migration ${String(i + 1).padStart(4, "0")} before this one` });
    }
  });
  return findings;
}

/**
 * @param {string} file
 * @param {string} sql
 * @returns {Finding[]}
 */
export function checkMigrationSql(file, sql) {
  /** @type {Finding[]} */
  const findings = [];
  const lines = sql.split(/\r?\n/);

  lines.forEach((raw, index) => {
    const line = raw.replace(/--.*$/, "");
    const n = index + 1;
    const push = (/** @type {string} */ rule, /** @type {string} */ detail) => findings.push({ file, line: n, rule, detail });

    if (/\bCREATE\s+(UNIQUE\s+|VIRTUAL\s+)?(TABLE|INDEX|TRIGGER|VIEW)\b/i.test(line) && !/\bIF\s+NOT\s+EXISTS\b/i.test(line)) {
      push("not-idempotent", "CREATE needs IF NOT EXISTS");
    }
    if (/\bDROP\s+(TABLE|INDEX|TRIGGER|VIEW)\b/i.test(line) && !/\bIF\s+EXISTS\b/i.test(line)) {
      push("not-idempotent", "DROP needs IF EXISTS");
    }
    if (/\bINSERT\s+INTO\b/i.test(line)) {
      push("not-idempotent", "seed rows need INSERT OR IGNORE (or INSERT OR REPLACE)");
    }
    if (/\bALTER\s+TABLE\b[\s\S]*\bADD\s+(COLUMN\s+)?/i.test(line)) {
      let prev = index - 1;
      while (prev >= 0 && (lines[prev] ?? "").trim() === "") prev--;
      if (prev < 0 || !(lines[prev] ?? "").trim().startsWith("-- once:")) {
        push("unguarded-alter", 'ADD COLUMN cannot be guarded in SQLite; precede it with a "-- once: ..." comment');
      }
    }
  });

  const stripped = sql.replace(/--.*$/gm, "");
  const tables = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z0-9_]+)["`]?\s*\(([\s\S]*?)\)\s*;/gi;
  for (const m of stripped.matchAll(tables)) {
    const body = m[2] ?? "";
    if (!/\bcreated_at\b/i.test(body)) {
      const line = stripped.slice(0, m.index).split("\n").length;
      findings.push({ file, line, rule: "created-at", detail: `table ${m[1] ?? "?"} needs a created_at column` });
    }
  }
  return findings;
}

/**
 * @param {string} dir migrations directory
 * @returns {{ findings: Finding[], count: number }}
 */
export function checkMigrationsDir(dir) {
  if (!existsSync(dir)) return { findings: [], count: 0 };
  const names = readdirSync(dir).filter((n) => n.endsWith(".sql"));
  const findings = [...checkMigrationNames(names)];
  for (const name of names) findings.push(...checkMigrationSql(name, readFileSync(join(dir, name), "utf8")));
  return { findings, count: names.length };
}

if (isMain(import.meta.url)) {
  const dir = resolve(repoRoot(), process.argv[2] ?? "packages/core/migrations");
  const { findings, count } = checkMigrationsDir(dir);
  report("check-migration-order", findings, count === 0 ? "no migrations yet" : `clean (${count} migration(s))`);
}
