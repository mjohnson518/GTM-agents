// GTM-agents: the gates every send passes, checked inside the send path itself so no caller can
// skip them. In order:
//   1. the system halt, for every path;
//   2. the cold outreach kill switch, for the cold and sequence paths;
//   3. suppression, for every recipient.
// Each gate fails closed. A refusal comes back as a message that starts with
// "[SEND BLOCKED:<reason>]", for logs, the operator and the model alike. On success it returns the
// normalized recipient addresses, and the send path must send to exactly those, never to the raw
// strings it was given. Every send path must call this inside its send function.
//
// The rest of the send path (content lint, verification policy, send window, per-domain and
// per-account caps, the provider circuit breaker) runs after these and is documented in
// docs/ARCHITECTURE.md.
import { readHalt } from "../security/halt.ts";
import type { KvStore } from "../shared/kv.ts";
import { readColdPause } from "./kill-switch.ts";
import { checkSuppression, type BlockedRecipient } from "./suppression.ts";

/**
 * cold: first-touch outreach; sequence: follow-ups to people who have not replied;
 * reply: answers to someone who wrote in; lifecycle: mail to product users.
 */
export const SEND_PATHS = ["cold", "sequence", "reply", "lifecycle"] as const;
export type SendPath = (typeof SEND_PATHS)[number];

const PAUSABLE: ReadonlySet<string> = new Set(["cold", "sequence"]);

export type SendBlockReason = "no_recipients" | "halted" | "cold_paused" | "suppressed";

export type SendGateResult =
  | { ok: true; recipients: string[] }
  | { ok: false; reason: SendBlockReason; message: string; blocked: BlockedRecipient[] };

export interface SendGateDeps {
  kv: Pick<KvStore, "get"> | undefined | null;
  db: D1Database;
}

function refuse(reason: SendBlockReason, detail: string, blocked: BlockedRecipient[] = []): SendGateResult {
  return { ok: false, reason, message: `[SEND BLOCKED:${reason}] ${detail}`, blocked };
}

export async function checkSendGates(deps: SendGateDeps, send: { path: SendPath; recipients: readonly string[] }): Promise<SendGateResult> {
  if (send.recipients.length === 0) return refuse("no_recipients", "a send needs at least one recipient.");

  const halt = await readHalt(deps.kv);
  if (halt.halted) return refuse("halted", `the system is halted${halt.reason ? `: ${halt.reason}` : ""}.`);

  // An unknown path is treated as cold, the strictest.
  const path: string = (SEND_PATHS as readonly string[]).includes(send.path) ? send.path : "cold";
  if (PAUSABLE.has(path)) {
    const pause = await readColdPause(deps.kv);
    if (pause.paused) return refuse("cold_paused", `cold outreach is paused (${pause.severity ?? "critical"})${pause.reason ? `: ${pause.reason}` : ""}.`);
  }

  const suppression = await checkSuppression(deps.db, send.recipients);
  if (!suppression.ok) {
    const reasons = [...new Set(suppression.blocked.map((b) => b.reason))].join(", ");
    return refuse("suppressed", `${suppression.blocked.length} of ${send.recipients.length} recipient(s) may not be emailed (${reasons}).`, suppression.blocked);
  }
  return { ok: true, recipients: suppression.allowed };
}
