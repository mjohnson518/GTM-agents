// GTM-agents: the CLI's input and output, injectable so every command can be tested in-process.
import { spawn } from "node:child_process";

export interface Io {
  cwd: string;
  out(line: string): void;
  err(line: string): void;
}

export const processIo: Io = {
  cwd: process.cwd(),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs an external command (Wrangler, for remote checks). Injectable for tests. */
export type CommandRunner = (command: string, args: string[], options: { cwd: string }) => Promise<CommandResult>;

export const spawnRunner: CommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

/** Exit codes: 0 success, 1 a check failed, 2 usage error or unavailable command. */
export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;
