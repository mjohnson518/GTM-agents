#!/usr/bin/env node
// GTM-agents: commit message check, run by .githooks/commit-msg.
//
// The subject (first line) must be present, start with a capital letter, stay within 72
// characters and not end with a period. A body after a blank line is allowed.
//
// Usage: node scripts/check-commit-msg.mjs <commit-message-file>
import { readFileSync } from "node:fs";
import { isMain } from "./lib/files.mjs";

/**
 * @param {string} message raw commit message, possibly with "#" comment lines
 * @returns {string[]} problems; empty when the message is acceptable
 */
export function checkCommitMessage(message) {
  const lines = message.split(/\r?\n/).filter((l) => !l.startsWith("#"));
  const subject = (lines.find((l) => l.trim() !== "") ?? "").trim();
  /** @type {string[]} */
  const problems = [];
  if (subject === "") return ["the commit message is empty"];
  if (!/^[A-Z0-9]/.test(subject)) problems.push("start the subject with a capital letter");
  if (subject.length > 72) problems.push(`keep the subject within 72 characters (it has ${subject.length})`);
  if (subject.endsWith(".")) problems.push("do not end the subject with a period");
  return problems;
}

if (isMain(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error("check-commit-msg: pass the commit message file");
    process.exitCode = 2;
  } else {
    const problems = checkCommitMessage(readFileSync(file, "utf8"));
    for (const p of problems) console.error(`commit-msg: ${p}`);
    if (problems.length) process.exitCode = 1;
  }
}
