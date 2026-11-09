// GTM-agents: the CLI's input and output, injectable so every command can be tested in-process.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

export interface Io {
  cwd: string;
  out(line: string): void;
  err(line: string): void;
  /** Ask a yes or no question. Absent when there is no terminal to ask on; commands then need --yes. */
  confirm?(question: string): Promise<boolean>;
}

async function askOnTerminal(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(?:es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

export const processIo: Io = {
  cwd: process.cwd(),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  ...(process.stdin.isTTY ? { confirm: askOnTerminal } : {}),
};

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs an external command: every Wrangler call the CLI makes goes through one. Injectable for tests. */
export type CommandRunner = (command: string, args: string[], options: { cwd: string }) => Promise<CommandResult>;

export const spawnRunner: CommandRunner = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    // On Windows npx is npx.cmd, which spawn cannot start without a shell; run the CLI under WSL there.
    child.on("error", (e) =>
      resolve({ code: 127, stdout, stderr: `${stderr}${e.message}${process.platform === "win32" ? " (on Windows, run gtm from WSL)" : ""}` }),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

/** Exit codes: 0 success, 1 a check or a Wrangler call failed, 2 a usage error. */
export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

/**
 * The gate before a command writes to production: the deployment's live database, KV namespace or
 * Worker. Staging (any named environment) proceeds without asking. Wrangler runs with no terminal,
 * so its own prompts auto-confirm; this question is the real one. Returns null to proceed, or the
 * exit code to stop with.
 */
export async function confirmProductionWrite(io: Io, env: string | undefined, yes: boolean, command: string, what: string): Promise<number | null> {
  if (env !== undefined || yes) return null;
  if (!io.confirm) {
    io.err(`${command}: this writes to production (${what}) and there is no terminal to confirm on; rerun with --yes`);
    return EXIT.usage;
  }
  if (await io.confirm(`${command}: ${what} in production?`)) return null;
  io.out(`${command}: nothing was changed.`);
  return EXIT.ok;
}
