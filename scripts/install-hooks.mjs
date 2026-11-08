#!/usr/bin/env node
// GTM-agents: points git at the repository's hooks in .githooks/. Runs from `npm install`
// (the "prepare" script). Outside a git checkout, for example in an unpacked tarball, it does
// nothing.
import { execFileSync } from "node:child_process";

try {
  execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
  console.log("install-hooks: git hooks run from .githooks/");
} catch {
  console.log("install-hooks: not a git checkout, skipping");
}
