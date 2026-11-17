// GTM-agents: the account watch's chat commands (docs/OPERATOR.md#commands).
//
//   watch-add <domain>      pin an existing account, so the account watch always covers it
//   watch-remove <domain>   unpin it
//   watch-list              the pinned accounts, then the accounts the next run would cover
//
// They are a ModuleCommand: matched before the model sees the message, for allowlisted operators
// only, run once per message. A command only writes accounts.attributes.watch on an account that
// already exists (by its key, the lowercased registrable domain); it searches nothing and spends
// nothing.
import { accountKey } from "../data/keys.ts";
import type { Env } from "../env.ts";
import type { ModuleCommand, ModuleCommandHandler } from "../operator/module-commands.ts";
import { SIGNAL_LIMITS } from "./flags.ts";
import { distinctiveName } from "./news.ts";
import { watchedAccounts } from "./watch.ts";

export const WATCH_HELP_LINES: readonly string[] = Object.freeze([
  "watch-add <domain>  pin an account for the weekly account watch",
  "watch-remove <domain>  unpin it",
  "watch-list  pinned accounts, and the accounts the next watch covers",
]);

const COMMAND = /^watch-(add|remove|list)(?:\s+(\S+))?\s*$/i;

async function setPinned(db: D1Database, raw: string, pinned: boolean): Promise<string> {
  const key = accountKey(raw);
  if (!key) return `"${raw.slice(0, 80)}" is not a company domain. Give the account's domain, for example brightloop.example.`;
  const account = await db.prepare("SELECT name, json_extract(attributes, '$.watch') AS watch FROM accounts WHERE account_key = ?1").bind(key).first<{ name: string; watch: unknown }>();
  if (!account) return `No account ${key} is known. Only an existing account can be pinned.`;
  const was = account.watch === 1 || account.watch === "true" || account.watch === true;
  if (was === pinned) return pinned ? `${key} is already pinned.` : `${key} was not pinned.`;
  await db
    .prepare(
      pinned
        ? "UPDATE accounts SET attributes = json_set(attributes, '$.watch', json('true')), updated_at = ?2 WHERE account_key = ?1"
        : "UPDATE accounts SET attributes = json_remove(attributes, '$.watch'), updated_at = ?2 WHERE account_key = ?1",
    )
    .bind(key, new Date().toISOString())
    .run();
  if (!pinned) return `Unpinned ${key}.`;
  return distinctiveName(account.name)
    ? `Pinned ${key}: the weekly account watch covers it first, from the next run.`
    : `Pinned ${key}, but its name ("${account.name.slice(0, 80)}") is too generic to match in a news title, so the watch skips it. Give the account a more distinctive name to have it covered.`;
}

async function list(db: D1Database): Promise<string> {
  const accounts = await watchedAccounts(db, SIGNAL_LIMITS.watchAccountsPerRun);
  if (accounts.length === 0) return "Nothing is watched yet: pin an account with watch-add <domain>, or the watch covers open deals and the best fit once there are any.";
  const reason = { pinned: "pinned", deal: "open deal", fit: "top fit" } as const;
  return [`The next account watch covers ${accounts.length}:`, ...accounts.map((a) => `- ${a.accountKey} (${reason[a.reason]})`)].join("\n");
}

/** The watch commands, for createWorker's `commands`. */
export function watchCommands<E extends Env = Env>(): ModuleCommand<E> {
  return {
    module: "account-watch",
    helpLines: WATCH_HELP_LINES,
    match(text: string): ModuleCommandHandler<E> | null {
      const m = COMMAND.exec(text.trim());
      if (!m) return null;
      const verb = (m[1] ?? "").toLowerCase();
      const arg = m[2];
      if (verb === "list") return arg ? null : (ctx) => list(ctx.env.DB);
      if (!arg) return null;
      return (ctx) => setPinned(ctx.env.DB, arg, verb === "add");
    },
  };
}
