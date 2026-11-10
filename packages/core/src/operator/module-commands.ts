// GTM-agents: operator chat commands contributed by an optional module (packages/modules).
//
// A module command is matched before the model sees the message, exactly like the built-in
// commands: the operator allowlist has already been checked, the text never reaches the model, and
// the handler runs the module's own function with its own gates. A module passes its commands to
// createWorker as `commands`; /help lists their helpLines.
//
// The chat consumer (chat.ts) runs a matched command once per message (claimed in the effects
// ledger), after every built-in command has had its turn and before the model. A handler that
// throws is answered with a generic error and leaves an audit row naming the module; its error text
// is never shown to the operator, since a module may have read untrusted data on the way.
import type { Env } from "../env.ts";

export interface ModuleCommandContext<E extends Env = Env> {
  env: E;
  now: Date;
  /** Who sent it, as the operator actor string used in audit rows (for example `operator:<id>`). */
  actor: string;
  /** The chat session the command came from. */
  sessionKey: string;
}

/** Runs a matched command and returns the reply text. Throwing is answered with a generic error. */
export type ModuleCommandHandler<E extends Env = Env> = (ctx: ModuleCommandContext<E>) => Promise<string>;

export interface ModuleCommand<E extends Env = Env> {
  /** A short name for logs and audit rows, for example "ship". */
  module: string;
  /** Lines /help shows, one per command form. */
  helpLines: readonly string[];
  /**
   * Returns the handler when `text` is one of this module's commands, otherwise null. Matching is on
   * the exact command word, never a substring, and never throws.
   */
  match(text: string): ModuleCommandHandler<E> | null;
}

/**
 * The built-in slash commands. They always win: a module command that would answer to one of them
 * is never matched, so no module can change what /clean, /status or /help do.
 */
export const BUILT_IN_COMMAND_NAMES: ReadonlySet<string> = new Set(["clean", "help", "start", "status"]);

const builtInName = (text: string): string | null => /^\/([A-Za-z][A-Za-z0-9_]{0,31})(?:@[A-Za-z0-9_]{1,64})?(?:\s|$)/.exec(text.trim())?.[1]?.toLowerCase() ?? null;

/** A module's handler for `text`, or null when it does not match, answers with something else, or throws. */
function safeMatch<E extends Env>(command: ModuleCommand<E>, text: string): ModuleCommandHandler<E> | null {
  try {
    const handler = command.match(text);
    return typeof handler === "function" ? handler : null;
  } catch {
    return null;
  }
}

export interface MatchedModuleCommand<E extends Env = Env> {
  module: string;
  handler: ModuleCommandHandler<E>;
}

/**
 * The first module command that answers to `text`, or null. A built-in command name is never
 * matched, and a module whose match throws (which it must not) is skipped as if it did not match.
 */
export function matchModuleCommand<E extends Env>(commands: ReadonlyArray<ModuleCommand<E>> | undefined, text: string): MatchedModuleCommand<E> | null {
  if (!commands || commands.length === 0 || typeof text !== "string") return null;
  const name = builtInName(text);
  if (name !== null && BUILT_IN_COMMAND_NAMES.has(name)) return null;
  for (const command of commands) {
    const handler = safeMatch(command, text);
    if (handler) return { module: command.module, handler };
  }
  return null;
}

/** Every module's /help lines, in registration order. */
export function moduleHelpLines<E extends Env>(commands: ReadonlyArray<ModuleCommand<E>> | undefined): string[] {
  return (commands ?? []).flatMap((c) => [...c.helpLines]);
}
