// GTM-agents: the operator's autonomy commands. They never reach the model, and only an allowlisted
// operator can send them (the chat consumer checks before routing here).
//
//   autonomy-status                     every class: its level, why, its evidence, and open proposals
//   autonomy-set <class> <0-3>          step one: shows the class, its level, its evidence and a
//                                       confirm command; nothing changes yet
//   autonomy-confirm-<id>-<code>        step two: applies that change, or a promotion the weekly
//                                       review proposed, only if the level has not changed since
//                                       (proposals.ts)
// A permanently human-only class is refused above level 1 at both steps. These commands are the
// only way a level is raised from the chat; no tool, job, model output or inbound text can set one.
import type { GtmConfig } from "../config/schema.ts";
import type { FlagReader } from "../jobs/registry.ts";
import type { KvStore } from "../shared/kv.ts";
import { emptyEvidence, evidenceLine, loadEvidence, type ClassEvidence } from "./evidence.ts";
import { ACTION_CLASSES, EARNABLE_ACTION_CLASSES, PERMANENT_HUMAN, isPermanentHuman, type AutonomyLevel } from "./levels.ts";
import { AUTOMATIC_PATHS, decidePromotion } from "./promotion.ts";
import { confirmCommand, confirmProposal, createProposal, openProposals, OPERATOR_PROPOSAL_TTL_MS } from "./proposals.ts";
import { readAutonomyLevel, type LevelReading } from "./store.ts";
import { evalGap } from "./writers.ts";

export type AutonomyCommand =
  | { kind: "status" }
  | { kind: "set"; actionClass: string; level: string }
  | { kind: "confirm"; id: string; code: string };

const SET = /^\/?autonomy[-_]set(?:@[A-Za-z0-9_]{1,64})?(?:\s+(\S+))?(?:\s+(\S+))?\s*$/i;
const CONFIRM = /^\/?autonomy[-_]confirm[-_]([0-9a-f]{10})[-_]([0-9a-f]{6})$/i;
const STATUS = /^\/?autonomy(?:[-_]status)?(?:@[A-Za-z0-9_]{1,64})?$/i;

/** The autonomy command in a message, or null when it is not one. */
export function parseAutonomyCommand(text: string): AutonomyCommand | null {
  const trimmed = text.trim();
  const confirm = CONFIRM.exec(trimmed);
  if (confirm) return { kind: "confirm", id: (confirm[1] ?? "").toLowerCase(), code: (confirm[2] ?? "").toLowerCase() };
  const set = SET.exec(trimmed);
  if (set) return { kind: "set", actionClass: set[1] ?? "", level: set[2] ?? "" };
  if (STATUS.test(trimmed)) return { kind: "status" };
  return null;
}

export const AUTONOMY_HELP_LINES: readonly string[] = Object.freeze([
  "autonomy-status  every action class's level, its evidence and open proposals",
  "autonomy-set <class> <0-3>  propose a level for a class; nothing changes until you send the confirm command it gives you",
  "autonomy-confirm-<id>-<code>  apply a proposed level (from autonomy-set or the weekly review), if the class has not changed since",
]);

export interface AutonomyCommandDeps {
  db: D1Database;
  /** The flag store levels are written to. */
  kv: Pick<KvStore, "put"> | undefined;
  flags: FlagReader;
  config: Pick<GtmConfig, "autonomy">;
  /** The allowlisted operator who sent the command. */
  userId: string;
  now?: () => Date;
}

function levelLine(reading: LevelReading): string {
  const parts = [`level ${reading.level}`];
  if (reading.error) parts.push(`read as 1 because ${reading.error}`);
  else if (reading.demoted && reading.latest) parts.push(`demoted ${reading.latest.createdAt.slice(0, 10)}: ${reading.latest.reason ?? "an incident"}`);
  else if (reading.source === "config") parts.push("the starting level in gtm.config.ts");
  else if (reading.source === "malformed") parts.push("the flag holds something other than 0 to 3, so it reads as 1");
  return parts.join("; ");
}

function pathLine(actionClass: string): string {
  const path = AUTOMATIC_PATHS[actionClass as keyof typeof AUTOMATIC_PATHS];
  return path ? `At level 2 or 3, ${path}.` : "Nothing acts on this class's level yet: its drafts wait for a person at every level.";
}

async function status(deps: AutonomyCommandDeps, now: Date): Promise<string> {
  let evidence: Map<string, ClassEvidence> | null;
  try {
    evidence = await loadEvidence(deps.db, now);
  } catch {
    evidence = null;
  }
  const lines = ["Autonomy levels: 0 observe, 1 draft and ask, 2 act and notify, 3 act and report in a digest."];
  const quiet: string[] = [];
  for (const actionClass of EARNABLE_ACTION_CLASSES) {
    const reading = await readAutonomyLevel({ flags: deps.flags, db: deps.db, config: deps.config }, actionClass);
    const e = evidence?.get(actionClass) ?? emptyEvidence(actionClass);
    const interesting = reading.level !== 1 || reading.demoted || reading.error !== null || AUTOMATIC_PATHS[actionClass] !== undefined || e.approvedUnchanged + e.approvedEdited + e.rejected + e.autoSent + e.incidents > 0;
    if (!interesting) {
      quiet.push(actionClass);
      continue;
    }
    const gap = evalGap(actionClass);
    lines.push(`- ${actionClass}: ${levelLine(reading)}. ${evidence ? evidenceLine(e) : "Evidence could not be read"}.${gap ? ` Not proposable: ${gap}.` : ""}`);
  }
  if (quiet.length > 0) lines.push(`- At level 1 with no evidence and nothing acting on them: ${quiet.join(", ")}.`);
  lines.push(`- Permanently human-only, never above level 1: ${PERMANENT_HUMAN.join(", ")}.`);
  try {
    const open = await openProposals(deps.db, now);
    if (open.length > 0) {
      lines.push("", "Open proposals:");
      for (const p of open) lines.push(`- ${p.actionClass} level ${p.from} to ${p.to} (${p.origin === "review" ? "weekly review" : "autonomy-set"}, until ${p.expiresAt.slice(0, 16).replace("T", " ")} UTC): ${confirmCommand(p)}`);
    }
  } catch {
    lines.push("", "Open proposals could not be read.");
  }
  return lines.join("\n");
}

async function set(deps: AutonomyCommandDeps, command: Extract<AutonomyCommand, { kind: "set" }>, now: Date): Promise<string> {
  const actionClass = command.actionClass.trim();
  if (!actionClass || !command.level) return "Usage: autonomy-set <class> <0-3>. Send autonomy-status for the classes and their levels.";
  if (!(ACTION_CLASSES as readonly string[]).includes(actionClass)) return `"${actionClass.slice(0, 40)}" is not an action class. The classes are: ${ACTION_CLASSES.join(", ")}.`;
  if (!/^[0-3]$/.test(command.level)) return "A level is 0 (observe), 1 (draft and ask), 2 (act and notify) or 3 (act and report in a digest).";
  const level = Number(command.level) as AutonomyLevel;
  if (isPermanentHuman(actionClass) && level > 1) return `${actionClass} is permanently human-only: it never goes above level 1, whatever the evidence. Nothing changed.`;

  const reading = await readAutonomyLevel({ flags: deps.flags, db: deps.db, config: deps.config }, actionClass);
  if (reading.error) return `${actionClass}'s level could not be read (${reading.error}), so nothing was proposed. Try again once it can be.`;
  if (reading.level === level && !reading.demoted) return `${actionClass} is already at level ${level}. Nothing changed.`;

  let e: ClassEvidence | null;
  try {
    e = (await loadEvidence(deps.db, now)).get(actionClass) ?? emptyEvidence(actionClass);
  } catch {
    e = null;
  }
  const proposal = await createProposal(deps.db, {
    actionClass,
    from: reading.level,
    to: level,
    origin: "operator",
    basedOnChange: reading.latest?.id ?? 0,
    ...(e ? { evidence: { evidence: e } } : {}),
    requestedBy: `operator:${deps.userId}`,
    ttlMs: OPERATOR_PROPOSAL_TTL_MS,
    now,
  });
  const lines = [`${actionClass}: ${levelLine(reading)}.`, `Evidence: ${e ? evidenceLine(e) : "could not be read"}.`];
  if (level > reading.level && level >= 2) {
    lines.push(pathLine(actionClass));
    const gap = evalGap(actionClass);
    if (gap) lines.push(`Note: ${gap}, so the weekly review would not propose this.`);
    if (e) {
      const decision = decidePromotion({ actionClass, level: reading.level, evidence: e, outcome: undefined });
      if (!decision.propose && actionClass !== "cold_batch") lines.push(`Note: the evidence does not meet the promotion rule yet (${decision.reason}).`);
      if (actionClass === "cold_batch") lines.push("Note: the weekly review also checks the cold batch's matured reply and bounce rates before proposing this.");
    }
  }
  lines.push(`To set ${actionClass} to level ${level}, send within ${OPERATOR_PROPOSAL_TTL_MS / 60_000} minutes: ${confirmCommand(proposal)}`, `It applies only if the class is still at level ${reading.level} then.`);
  return lines.join("\n");
}

/** Run an autonomy command and return the reply text. Throws on a database error; the caller reports it. */
export async function runAutonomyCommand(deps: AutonomyCommandDeps, command: AutonomyCommand): Promise<string> {
  const now = deps.now?.() ?? new Date();
  switch (command.kind) {
    case "status":
      return status(deps, now);
    case "set":
      return set(deps, command, now);
    case "confirm": {
      const result = await confirmProposal({ db: deps.db, kv: deps.kv, flags: deps.flags, config: deps.config, userId: deps.userId, now }, command);
      if (!result.ok || result.level < 2) return result.text;
      const proposalClass = result.actionClass;
      return `${result.text} ${pathLine(proposalClass)} An incident (a hard bounce, a complaint or an unsubscribe after an automatic send) drops it back to level 1 at once. To lower it yourself, send autonomy-set ${proposalClass} 1.`;
    }
  }
}
