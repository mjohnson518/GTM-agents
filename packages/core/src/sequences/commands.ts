// GTM-agents: the operator's sequence commands. None of them reaches the model; the chat consumer
// routes them before anything else, once per message.
//
//   sequence-release-<id>-<code>        send the follow-ups a sweep put up for release (release.ts)
//   sequence-resume-<contact id>        resume a contact's paused sequence; every check runs again
//   channel-done-<touch id> [linkedin|x] the manual touch before the last step was sent by hand
//   channel-skip-<touch id>             no manual touch; the last step may go
//
// Each accepts an optional leading slash. Ids are matched exactly; nothing in a command is ever
// passed to a model or used as anything but a lookup key.
import type { KVReader } from "../brain/load.ts";
import type { GtmConfig } from "../config/schema.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import type { ReleaseCommand } from "../outreach/release.ts";
import type { EmailProvider } from "../ports/email.ts";
import type { SendOutreach } from "../sending/types.ts";
import { recordManualTouch, type ManualChannel } from "./manual.ts";
import { parseSequenceReleaseCommand, releaseSequenceManifest } from "./release.ts";
import { resumeSequences } from "./state.ts";

export type SequenceCommand =
  | { kind: "release"; command: ReleaseCommand }
  | { kind: "resume"; contactId: string }
  | { kind: "channel"; decision: "done" | "skip"; touchId: string; channel: ManualChannel };

const RESUME = /^\/?sequence-resume-([A-Za-z0-9_-]{2,80})$/;
const CHANNEL = /^\/?channel-(done|skip)-(mt[0-9a-f]{10})(?:\s+(linkedin|x))?$/i;

/** A sequence command in a message, or null. */
export function parseSequenceCommand(text: string): SequenceCommand | null {
  const trimmed = text.trim();
  const release = parseSequenceReleaseCommand(trimmed);
  if (release) return { kind: "release", command: release };
  const resume = RESUME.exec(trimmed);
  if (resume) return { kind: "resume", contactId: resume[1] ?? "" };
  const channel = CHANNEL.exec(trimmed);
  if (channel) {
    const decision = (channel[1] ?? "").toLowerCase() === "done" ? "done" : "skip";
    if (decision === "skip" && channel[3]) return null;
    return { kind: "channel", decision, touchId: (channel[2] ?? "").toLowerCase(), channel: (channel[3]?.toLowerCase() ?? "linkedin") as ManualChannel };
  }
  return null;
}

export interface SequenceCommandDeps {
  db: D1Database;
  flags: FlagReader;
  /** The KV namespace holding the brain. */
  kv: KVReader | undefined;
  config: Pick<GtmConfig, "sequences">;
  /** The send function for sequence steps. Undefined when the deployment has not wired one. */
  send: SendOutreach | undefined;
  provider: EmailProvider | undefined;
  /** The operator's user id, recorded as who released or decided. */
  userId: string;
  now?: () => Date;
  log?: JobLogger;
}

/** Run a sequence command and return the reply text. Throws on a database error; the caller reports it. */
export async function runSequenceCommand(deps: SequenceCommandDeps, command: SequenceCommand): Promise<string> {
  const now = deps.now?.() ?? new Date();
  const actor = `operator:${deps.userId}`;
  switch (command.kind) {
    case "release": {
      if (!deps.send) return "No send function is configured for follow-up steps (the email provider is not wired into the operator chat), so nothing was released.";
      const result = await releaseSequenceManifest(
        { db: deps.db, flags: deps.flags, kv: deps.kv, send: deps.send, provider: deps.provider, config: deps.config, actor, now: () => now, ...(deps.log ? { log: deps.log } : {}) },
        command.command,
      );
      return result.text;
    }
    case "resume": {
      const { results } = await deps.db
        .prepare("SELECT campaign_id FROM campaign_contacts WHERE contact_id = ?1 AND sequence_active = 1 AND sequence_paused_at IS NOT NULL")
        .bind(command.contactId)
        .all<{ campaign_id: string }>();
      const resumed = await resumeSequences(deps.db, command.contactId, { now });
      if (resumed === 0) return `No paused sequence for ${command.contactId}; nothing changed. A sequence that ended or stopped is not resumed.`;
      // A step whose draft was rejected is drafted afresh once the operator resumes it.
      for (const r of results) {
        await deps.db
          .prepare("UPDATE drafts SET idempotency_key = NULL, updated_at = ?3 WHERE campaign_id = ?1 AND contact_id = ?2 AND status = 'rejected' AND idempotency_key LIKE 'seq:%'")
          .bind(r.campaign_id, command.contactId, now.toISOString())
          .run();
      }
      return `Resumed ${resumed} sequence(s) for ${command.contactId}. The next step goes on the next sweep, after every check runs again.`;
    }
    case "channel":
      return recordManualTouch(deps.db, { id: command.touchId, decision: command.decision, channel: command.channel, by: actor, now });
  }
}
