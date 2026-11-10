// GTM-agents: the gtm command's dispatcher.
import { brainCommand } from "./commands/brain.ts";
import { deployCommand } from "./commands/deploy.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { flagsCommand } from "./commands/flags.ts";
import { initCommand } from "./commands/init.ts";
import { migrateCommand } from "./commands/migrate.ts";
import { setupCommand } from "./commands/setup.ts";
import { EXIT, processIo, type CommandRunner, type Io } from "./lib/io.ts";

export const HELP = `gtm: set up and operate a GTM-agents deployment

Usage: gtm <command> [options]

Commands, in the order a new deployment uses them:
  init <dir>        create a new deployment from the worker template
  setup             create the Cloudflare resources (D1, KV, R2, Vectorize, queues), reusing any
                    that exist, and fill their ids into wrangler.jsonc; lists the missing secrets
  migrate           apply the D1 migrations after checking their order
  brain validate    check brain/ and templates/ against the schema, byte budgets and lock file
  brain upload      upload the locked brain and approved templates to KV (files first, locks last)
  brain diff        show which components and templates differ from what is uploaded
  flags             list, get, set or unset feature flags in KV, checked against the flag registry
  doctor            check bindings, the cron trigger, configuration, adapters, secrets, webhooks,
                    the kill switch and flags (--remote reads the deployed secrets and the stop flags)
  deploy            doctor, migrate, a brain diff warning, then wrangler deploy (--dry-run changes nothing)

Commands that talk to Cloudflare take --env staging|production (production is the default) and run
Wrangler, which uses your Wrangler login. packages/cli/README.md and docs/DEPLOYING.md list every
option.`;

export interface CliOptions {
  /** Replaces the process runner for every Wrangler call (tests). */
  runner?: CommandRunner;
}

export async function main(argv: string[], io: Io = processIo, options: CliOptions = {}): Promise<number> {
  const [command, ...rest] = argv;
  if (rest.includes("--help") || rest.includes("-h")) {
    io.out(HELP);
    return EXIT.ok;
  }
  const runner = options.runner ? { runner: options.runner } : {};
  switch (command) {
    case "init":
      return initCommand(rest, io);
    case "setup":
      return setupCommand(rest, io, runner);
    case "migrate":
      return migrateCommand(rest, io, runner);
    case "brain":
      return brainCommand(rest, io, runner);
    case "flags":
      return flagsCommand(rest, io, runner);
    case "doctor":
      return doctorCommand(rest, io, runner);
    case "deploy":
      return deployCommand(rest, io, runner);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      io.out(HELP);
      return EXIT.ok;
    default:
      io.err(`gtm: unknown command "${command}"\n`);
      io.err(HELP);
      return EXIT.usage;
  }
}
