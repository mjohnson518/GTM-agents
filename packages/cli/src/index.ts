// GTM-agents: the gtm command's dispatcher.
import { brainCommand } from "./commands/brain.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { initCommand } from "./commands/init.ts";
import { unavailable } from "./commands/unavailable.ts";
import { EXIT, processIo, type Io } from "./lib/io.ts";

export const HELP = `gtm: set up and operate a GTM-agents deployment

Usage: gtm <command> [options]

Commands:
  init <dir>        create a new deployment from the worker template
  doctor            check bindings, configuration, adapters, secrets, webhooks, the kill switch and flags
  brain validate    check brain/ and templates/ against the schema, byte budgets and lock file
  setup             create Cloudflare resources and fill in placeholders   (not available yet)
  migrate           apply D1 migrations after checking their order         (not available yet)
  brain upload|diff upload the locked brain, or show what changed          (not available yet)
  flags             list, get or set feature flags                         (not available yet)
  deploy            run the checks, then deploy the Worker                 (not available yet)

Run gtm <command> --help for a command's options.`;

export async function main(argv: string[], io: Io = processIo): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "init":
      return initCommand(rest, io);
    case "doctor":
      return doctorCommand(rest, io);
    case "brain":
      return brainCommand(rest, io);
    case "setup":
    case "migrate":
    case "flags":
    case "deploy":
      return unavailable(command, io);
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
