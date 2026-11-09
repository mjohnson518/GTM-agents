// GTM-agents: the operator's self-improvement commands. They never reach the model, run once per
// message (the chat consumer claims each message), and only an allowlisted operator reaches them.
//
//   learning-list [kind]              pending proposals from every loop
//   learning-show <id>                one proposal's exact detail and the command that approves it
//   learning-approve-<id>-<code>      apply it, bound to the detail shown (<code> is its digest's
//                                     first 32 hex characters)
//   learning-reject-<id> [reason]     turn it down
//   learnings                         the learnings document as it stands
//   objection-list                    real objections with no approved answer
//   objection-answer <id> <answer>    propose your answer; approve it with the command it returns
//   voice-build <thread> [<thread>]   rebuild the voice profile from threads you pick
//   voice-status                      the edit rate the weekly drift check reads
//   fitness [days]                    today's fitness score and each dimension's trend
import type { GtmConfig } from "../config/schema.ts";
import type { FlagReader } from "../jobs/registry.ts";
import type { InboxProvider } from "../ports/email.ts";
import { approveLearningProposal, rejectLearningProposal } from "./apply.ts";
import type { BrainKv } from "./brain-edit.ts";
import { dimensionTrends, fitnessTrend } from "./fitness.ts";
import { LEARNING_FLAGS, learningFlagOn } from "./flags.ts";
import { learningsText } from "./learnings.ts";
import { proposeObjectionAnswer, unansweredObjections } from "./objections.ts";
import { detailOf, listLearningProposals, loadLearningProposal, PROPOSAL_KINDS, proposalTitle, type LearningProposal, type ProposalKind } from "./proposals.ts";
import { buildVoiceProposal, voiceDrift } from "./voice.ts";

export type LearningCommand =
  | { kind: "list"; filter: string | null }
  | { kind: "show"; id: string }
  | { kind: "approve"; id: string; code: string }
  | { kind: "reject"; id: string; reason: string }
  | { kind: "document" }
  | { kind: "objections" }
  | { kind: "answer"; id: string; text: string }
  | { kind: "voice_build"; threads: string[] }
  | { kind: "voice_status" }
  | { kind: "fitness"; days: number };

const BOT = "(?:@[A-Za-z0-9_]{1,64})?";
const LIST = new RegExp(`^/?learning[-_]list${BOT}(?:\\s+([a-z_]+))?\\s*$`, "i");
const SHOW = new RegExp(`^/?learning[-_]show${BOT}\\s+([0-9a-z_]{6,32})\\s*$`, "i");
const APPROVE = /^\/?learning[-_]approve[-_]([0-9a-f]{8})[-_]([0-9a-f]{32,64})$/i;
const REJECT = /^\/?learning[-_]reject[-_]([0-9a-f]{8})(?:\s+([\s\S]{0,300}))?$/i;
const DOCUMENT = new RegExp(`^/?learnings${BOT}\\s*$`, "i");
const OBJECTIONS = new RegExp(`^/?objection[-_]list${BOT}\\s*$`, "i");
const ANSWER = new RegExp(`^/?objection[-_]answer${BOT}\\s+(\\S+)\\s+([\\s\\S]+)$`, "i");
const VOICE_BUILD = new RegExp(`^/?voice[-_]build${BOT}((?:\\s+\\S+){1,20})\\s*$`, "i");
const VOICE_STATUS = new RegExp(`^/?voice[-_]status${BOT}\\s*$`, "i");
const FITNESS = new RegExp(`^/?fitness${BOT}(?:\\s+(\\d{1,3}))?\\s*$`, "i");

/** The self-improvement command in a message, or null when it is not one. */
export function parseLearningCommand(text: string): LearningCommand | null {
  const t = text.trim();
  let m: RegExpExecArray | null;
  if ((m = APPROVE.exec(t))) return { kind: "approve", id: (m[1] ?? "").toLowerCase(), code: (m[2] ?? "").toLowerCase() };
  if ((m = REJECT.exec(t))) return { kind: "reject", id: (m[1] ?? "").toLowerCase(), reason: (m[2] ?? "").trim() };
  if ((m = LIST.exec(t))) return { kind: "list", filter: m[1]?.toLowerCase() ?? null };
  if ((m = SHOW.exec(t))) return { kind: "show", id: (m[1] ?? "").toLowerCase() };
  if (DOCUMENT.test(t)) return { kind: "document" };
  if (OBJECTIONS.test(t)) return { kind: "objections" };
  if ((m = ANSWER.exec(t))) return { kind: "answer", id: m[1] ?? "", text: (m[2] ?? "").trim() };
  if ((m = VOICE_BUILD.exec(t))) return { kind: "voice_build", threads: (m[1] ?? "").trim().split(/\s+/) };
  if (VOICE_STATUS.test(t)) return { kind: "voice_status" };
  if ((m = FITNESS.exec(t))) return { kind: "fitness", days: m[1] ? Number(m[1]) : 14 };
  return null;
}

export const LEARNING_HELP_LINES: readonly string[] = Object.freeze([
  "learning-list [kind]  pending proposals from the self-improvement loops",
  "learning-show <id>  a proposal's exact text or diff, and the command that approves it",
  "learning-approve-<id>-<code> / learning-reject-<id>  apply or decline a proposal you were shown",
  "learnings  the learnings document",
  "objection-list / objection-answer <id> <answer>  real objections, and propose your answer to one",
  "voice-build <thread id> ...  rebuild the voice profile from threads you pick; voice-status shows the edit rate",
  "fitness [days]  the fitness score and each dimension's trend",
]);

export interface LearningCommandDeps {
  db: D1Database;
  /** The KV namespace the brain is served from. */
  kv: BrainKv | undefined;
  flags: FlagReader;
  inbox?: InboxProvider;
  config?: Pick<GtmConfig, "operator">;
  userId: string;
  now?: () => Date;
}

/** Hex characters of the digest the chat approval carries: enough that no altered row can match it. */
export const APPROVAL_CODE_CHARS = 32;

/** The code that approves a proposal: the first APPROVAL_CODE_CHARS hex characters of its digest. */
export const approvalCode = (p: Pick<LearningProposal, "digest">): string => p.digest.slice(0, APPROVAL_CODE_CHARS);

function showText(p: LearningProposal): string {
  const lines = [`${p.shortId}  ${proposalTitle(p)}`, `From ${p.proposedBy}, ${p.createdAt.slice(0, 10)}, ${p.status}${p.statusReason ? ` (${p.statusReason})` : ""}.`, "", detailOf(p)];
  if (p.status === "pending") lines.push("", `Approve exactly this: learning-approve-${p.shortId}-${approvalCode(p)}`, `Decline: learning-reject-${p.shortId}`);
  return lines.join("\n");
}

/** Resolve inbound message ids (or unique prefixes of 6+) to their thread ids; anything else is taken as a thread id. */
async function threadIds(db: D1Database, refs: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const ref of refs) {
    const row = await db
      .prepare("SELECT provider_thread_id FROM inbound_emails WHERE (id = ?1 OR (length(?1) >= 6 AND id LIKE ?1 || '%')) AND provider_thread_id IS NOT NULL LIMIT 2")
      .bind(ref)
      .all<{ provider_thread_id: string }>();
    out.push(row.results.length === 1 ? (row.results[0]?.provider_thread_id ?? ref) : ref);
  }
  return [...new Set(out)];
}

/** Run a self-improvement command and return the reply. Throws on a database error; the caller reports it. */
export async function runLearningCommand(deps: LearningCommandDeps, command: LearningCommand): Promise<string> {
  const now = deps.now?.() ?? new Date();
  const actor = `operator:${deps.userId}`;
  switch (command.kind) {
    case "list": {
      const kinds = command.filter && (PROPOSAL_KINDS as readonly string[]).includes(command.filter) ? [command.filter as ProposalKind] : undefined;
      const pending = await listLearningProposals(deps.db, { status: "pending", ...(kinds ? { kinds } : {}), limit: 30 });
      if (pending.length === 0) return "No proposals wait for you.";
      return [`${pending.length} proposal(s) wait for you:`, ...pending.map((p) => `${p.shortId}  ${proposalTitle(p)} (from ${p.proposedBy}, ${p.createdAt.slice(0, 10)})`), "", "Show one with learning-show <id>."].join("\n");
    }
    case "show": {
      const p = await loadLearningProposal(deps.db, command.id);
      return p ? showText(p) : `No proposal ${command.id}.`;
    }
    case "approve":
      return (await approveLearningProposal({ db: deps.db, ...(deps.kv ? { kv: deps.kv } : {}), now }, command.id, command.code, actor)).message;
    case "reject":
      return (await rejectLearningProposal({ db: deps.db, now }, command.id, actor, command.reason)).message;
    case "document":
      return (await learningsText(deps.db)) || "The learnings document is empty. Entries arrive only through approved proposals.";
    case "objections": {
      const open = await unansweredObjections(deps.db);
      if (open.length === 0) return "Every filed objection has an approved answer.";
      return [
        "Objections with no approved answer:",
        ...open.map((o) => `${o.id}  ${o.pattern}${o.competitor ? ` (competitor ${o.competitor})` : ""}`),
        "",
        "Propose an answer with objection-answer <id> <your answer>.",
      ].join("\n");
    }
    case "answer": {
      if (!(await learningFlagOn(deps.flags, LEARNING_FLAGS.objections))) return `Objection curation is off. Turn on ${LEARNING_FLAGS.objections} first.`;
      const r = await proposeObjectionAnswer(deps.db, { objectionId: command.id, response: command.text, actor, now });
      if (!r.ok) return `That answer was not stored: ${r.problems.join("; ")}.`;
      return showText(r.proposal);
    }
    case "voice_build": {
      if (!(await learningFlagOn(deps.flags, LEARNING_FLAGS.voice))) return `The voice profile is off. Turn on ${LEARNING_FLAGS.voice} first.`;
      const r = await buildVoiceProposal({ db: deps.db, kv: deps.kv, inbox: deps.inbox, now, actor }, await threadIds(deps.db, command.threads));
      if (!r.ok) return `No voice profile was built: ${r.problems.join("; ")}.`;
      return showText(r.proposal);
    }
    case "voice_status": {
      const d = await voiceDrift(deps.db, now);
      return d.rate === null
        ? "No reply decisions in the last 30 days."
        : `You edited ${d.edited} of the last ${d.decisions} reply drafts (${Math.round(d.rate * 100)}%).${d.suggest ? " That is high enough to rebuild the voice profile: voice-build <thread id> ..." : ""}`;
    }
    case "fitness": {
      const days = Math.max(3, Math.min(90, command.days));
      const points = await fitnessTrend(deps.db, now, days);
      const latest = [...points].reverse().find((p) => p.score !== null);
      if (!latest) return "No fitness score yet. It is computed daily while learning:fitness_enabled is on.";
      const trends = dimensionTrends(points);
      return [
        `Fitness ${latest.score} on ${latest.day}.`,
        ...trends.map((t) => `${t.dimension}: ${latest.dimensions[t.dimension] ?? "unknown"}, ${t.direction}${t.direction === "insufficient" ? "" : ` (${t.slope} per day)`}`),
      ].join("\n");
    }
  }
}
