// GTM-agents: helpers for running CLI commands in-process in tests.
import type { Io } from "../src/lib/io.ts";

export const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

export function captureIo(cwd: string = REPO_ROOT): Io & { stdout: string[]; stderr: string[]; text(): string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    cwd,
    stdout,
    stderr,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    text: () => [...stdout, ...stderr].join("\n"),
  };
}
