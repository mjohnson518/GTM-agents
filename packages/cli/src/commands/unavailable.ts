// GTM-agents: the message for commands that are planned but not available in this version.
import { EXIT, type Io } from "../lib/io.ts";

export function unavailable(command: string, io: Io): number {
  io.err(`gtm ${command} is not available in this version. docs/ROADMAP.md lists what exists today and what is planned.`);
  return EXIT.usage;
}
