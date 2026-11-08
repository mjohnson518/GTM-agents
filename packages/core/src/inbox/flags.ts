// GTM-agents: the inbox's flag and KV state keys, and how they are read.
//
// inbox:enabled is the master switch and defaults off. While it is off (or cannot be read):
//   - the poll, sweep and watch renewal jobs do not run (the job runner skips them, and each job
//     checks the flag again itself);
//   - the push webhook still verifies its shared secret, then acknowledges and does nothing;
//   - the email() entry point records nothing: it forwards the message when a forward address is
//     configured, and otherwise rejects it so the sender learns it was not delivered.
// Nothing is recorded, classified or acted on, so no sequence is stopped or held by the inbox.
// Every key is listed in packages/core/src/flags/registry.ts, so `gtm doctor` shows it.
import { isFlagOn } from "../jobs/loop.ts";
import type { FlagReader } from "../jobs/registry.ts";

export const INBOX_FLAGS = Object.freeze({
  enabled: "inbox:enabled",
});

/** When the last push-triggered poll started, so a burst of pushes runs one poll. */
export const PUSH_LAST_KEY = "inbox:push_last";

/** Whether the inbox is on. Unreadable means off. */
export async function inboxEnabled(flags: FlagReader): Promise<boolean> {
  try {
    return isFlagOn(await flags.get(INBOX_FLAGS.enabled));
  } catch {
    return false;
  }
}
