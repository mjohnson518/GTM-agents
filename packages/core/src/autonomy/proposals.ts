// GTM-agents: proposals: a change to a class's level that waits for the operator's confirmation.
//
// Two things make one:
//   - autonomy-set <class> <0-3> from the operator (origin operator, valid OPERATOR_PROPOSAL_TTL_MS);
//   - the weekly promotion review (origin review, valid REVIEW_PROPOSAL_TTL_MS), with its evidence.
// Each records the level the class was at (from_level) and the id of its latest recorded change
// (based_on_change, 0 for none) when it was made. Only `autonomy-confirm-<id>-<code>`, from an
// allowlisted operator, applies one, and only when, in order:
//   1. the proposal exists, is open and has not expired, and the code matches. The code confirms
//      intent and is not a secret; the operator allowlist is the control;
//   2. a permanently human-only class is not being raised above 1 (checked again here, and by a
//      CHECK constraint in the database);
//   3. the class's level reads cleanly and still equals from_level, and its latest recorded change
//      is still based_on_change. A demotion, another confirmed change, or a level written straight
//      to the flag store in between refuses it;
//   4. for a raise, no incident was recorded for the class since it was proposed, checked again
//      inside the write itself (an incident while a demotion already stands adds no change row);
//   5. the change row is written with a compare-and-set on the latest change, in one batch with the
//      proposal's status, so two confirmations can never both apply.
// Then the flag is written, and the reply reports the level read back afterwards. A class acts at
// the lower of its flag and its latest change (store.ts), so a flag write that fails may leave a
// raise unapplied, and always leaves a lowering applied. Lowering a class to 1
// or below also returns its automatically approved, unsent drafts to review.
import type { GtmConfig } from "../config/schema.ts";
import type { FlagReader } from "../jobs/registry.ts";
import { DAY_MS } from "../metrics/window.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import type { KvStore } from "../shared/kv.ts";
import { returnAutomaticApprovals } from "./incidents.ts";
import { ACTION_CLASSES, AUTONOMY_LEVELS, isPermanentHuman, type ActionClass, type AutonomyLevel } from "./levels.ts";
import { levelFlagKey, readAutonomyLevel } from "./store.ts";

export const OPERATOR_PROPOSAL_TTL_MS = 30 * 60_000;
export const REVIEW_PROPOSAL_TTL_MS = 14 * DAY_MS;

export type ProposalOrigin = "operator" | "review";
export type ProposalStatus = "open" | "applied" | "refused" | "expired";

export interface Proposal {
  id: string;
  code: string;
  actionClass: ActionClass;
  from: AutonomyLevel;
  to: AutonomyLevel;
  origin: ProposalOrigin;
  basedOnChange: number;
  evidence: unknown;
  requestedBy: string | null;
  status: ProposalStatus;
  expiresAt: string;
  createdAt: string;
}

interface ProposalRow {
  id: string;
  code: string;
  action_class: string;
  from_level: number;
  to_level: number;
  origin: string;
  based_on_change: number;
  evidence: string | null;
  requested_by: string | null;
  status: string;
  expires_at: string;
  created_at: string;
}

const PROPOSAL_COLUMNS = "id, code, action_class, from_level, to_level, origin, based_on_change, evidence, requested_by, status, expires_at, created_at";

const isLevel = (n: unknown): n is AutonomyLevel => typeof n === "number" && (AUTONOMY_LEVELS as readonly number[]).includes(n);
const known: ReadonlySet<string> = new Set(ACTION_CLASSES);

function toProposal(row: ProposalRow): Proposal | null {
  if (!known.has(row.action_class) || !isLevel(row.from_level) || !isLevel(row.to_level)) return null;
  let evidence: unknown;
  try {
    evidence = row.evidence ? JSON.parse(row.evidence) : null;
  } catch {
    evidence = null;
  }
  return {
    id: row.id,
    code: row.code,
    actionClass: row.action_class as ActionClass,
    from: row.from_level,
    to: row.to_level,
    origin: row.origin === "review" ? "review" : "operator",
    basedOnChange: Number(row.based_on_change) || 0,
    evidence,
    requestedBy: row.requested_by,
    status: (["open", "applied", "refused", "expired"].includes(row.status) ? row.status : "refused") as ProposalStatus,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

const hex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The command that applies a proposal. */
export const confirmCommand = (p: Pick<Proposal, "id" | "code">): string => `autonomy-confirm-${p.id}-${p.code}`;

export interface NewProposal {
  actionClass: string;
  from: AutonomyLevel;
  to: AutonomyLevel;
  origin: ProposalOrigin;
  basedOnChange: number;
  evidence?: unknown;
  requestedBy: string;
  ttlMs: number;
  now: Date;
}

/** Write a proposal. Throws on an invalid one or a database error. */
export async function createProposal(db: D1Database, input: NewProposal): Promise<Proposal> {
  if (!known.has(input.actionClass)) throw new Error(`${input.actionClass} is not an action class`);
  if (!isLevel(input.from) || !isLevel(input.to)) throw new Error("a level is 0, 1, 2 or 3");
  if (isPermanentHuman(input.actionClass) && input.to > 1) throw new Error(`${input.actionClass} is permanently human-only and never goes above level 1`);
  const id = hex(5);
  const code = hex(3);
  const createdAt = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + input.ttlMs).toISOString();
  await db
    .prepare(
      `INSERT INTO autonomy_proposals (id, code, action_class, from_level, to_level, origin, based_on_change, evidence, requested_by, status, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'open', ?10, ?11)`,
    )
    .bind(id, code, input.actionClass, input.from, input.to, input.origin, input.basedOnChange, input.evidence === undefined ? null : JSON.stringify(input.evidence), input.requestedBy, expiresAt, createdAt)
    .run();
  return { id, code, actionClass: input.actionClass as ActionClass, from: input.from, to: input.to, origin: input.origin, basedOnChange: input.basedOnChange, evidence: input.evidence ?? null, requestedBy: input.requestedBy, status: "open", expiresAt, createdAt };
}

/** A proposal by id, or null. Throws on a database error. */
export async function loadProposal(db: D1Database, id: string): Promise<Proposal | null> {
  const row = await db.prepare(`SELECT ${PROPOSAL_COLUMNS} FROM autonomy_proposals WHERE id = ?1`).bind(id).first<ProposalRow>();
  return row ? toProposal(row) : null;
}

/** Open, unexpired proposals, newest first. Throws on a database error. */
export async function openProposals(db: D1Database, now: Date, limit = 20): Promise<Proposal[]> {
  const { results } = await db
    .prepare(`SELECT ${PROPOSAL_COLUMNS} FROM autonomy_proposals WHERE status = 'open' AND expires_at > ?1 ORDER BY created_at DESC LIMIT ?2`)
    .bind(now.toISOString(), limit)
    .all<ProposalRow>();
  return results.map(toProposal).filter((p): p is Proposal => p !== null);
}

/** Mark open proposals past their time expired. Returns how many. Throws on a database error. */
export async function expireProposals(db: D1Database, now: Date): Promise<number> {
  const result = await db.prepare("UPDATE autonomy_proposals SET status = 'expired', decided_at = ?1 WHERE status = 'open' AND expires_at <= ?1").bind(now.toISOString()).run();
  return result.meta.changes ?? 0;
}

async function settle(db: D1Database, id: string, status: "refused" | "expired", by: string, detail: string, now: Date): Promise<void> {
  try {
    await db
      .prepare("UPDATE autonomy_proposals SET status = ?2, decided_by = ?3, decided_at = ?4, detail = ?5 WHERE id = ?1 AND status = 'open'")
      .bind(id, status, by, now.toISOString(), detail.slice(0, 300))
      .run();
  } catch {
    // Bookkeeping: the proposal stays open until it expires, and confirming it re-checks everything.
  }
}

export interface ConfirmDeps {
  db: D1Database;
  /** The flag store the level is written to. */
  kv: Pick<KvStore, "put"> | undefined;
  flags: FlagReader;
  config: Pick<GtmConfig, "autonomy">;
  /** The allowlisted operator who sent the command. */
  userId: string;
  now: Date;
}

export type ConfirmResult = { ok: true; level: AutonomyLevel; actionClass: ActionClass; text: string } | { ok: false; text: string };

/** Apply a proposal on the operator's confirmation. Throws only on a database error before anything is written. */
export async function confirmProposal(deps: ConfirmDeps, command: { id: string; code: string }): Promise<ConfirmResult> {
  const { db, now } = deps;
  const actor = `operator:${deps.userId}`;
  const refuse = async (proposal: Proposal | null, text: string, status: "refused" | "expired" | null = "refused"): Promise<ConfirmResult> => {
    if (proposal && status) await settle(db, proposal.id, status, actor, text, now);
    return { ok: false, text };
  };
  const proposal = await loadProposal(db, command.id);
  if (!proposal) return { ok: false, text: `There is no autonomy proposal ${command.id}. Nothing changed.` };
  if (proposal.code !== command.code.toLowerCase()) return { ok: false, text: `That code does not match proposal ${proposal.id}. Nothing changed. Copy the command from the message it came in.` };
  if (proposal.status !== "open") return { ok: false, text: `Proposal ${proposal.id} is ${proposal.status}. Nothing changed.` };
  if (Date.parse(proposal.expiresAt) <= now.getTime()) return refuse(proposal, `Proposal ${proposal.id} has expired. Nothing changed; send autonomy-set ${proposal.actionClass} ${proposal.to} to start again.`, "expired");
  if (isPermanentHuman(proposal.actionClass) && proposal.to > 1) return refuse(proposal, `${proposal.actionClass} is permanently human-only and never goes above level 1. Nothing changed.`);

  const reading = await readAutonomyLevel({ flags: deps.flags, db, config: deps.config }, proposal.actionClass);
  if (reading.error) return { ok: false, text: `${proposal.actionClass}'s level could not be read (${reading.error}), so nothing changed. Send the same command again once it can be.` };
  const latestId = reading.latest?.id ?? 0;
  if (reading.level !== proposal.from || latestId !== proposal.basedOnChange) {
    return refuse(proposal, `${proposal.actionClass} changed since this was proposed (it is at level ${reading.level} now, and was at ${proposal.from}${latestId !== proposal.basedOnChange ? "; a change was recorded since" : ""}). Nothing changed.`);
  }
  if (proposal.to > proposal.from) {
    // When the incident was recorded (its claim), not when the harm happened: a late report counts.
    const incident = await db
      .prepare("SELECT 1 AS hit FROM event_effects WHERE effect = 'autonomy_incident' AND (event_id LIKE '%:' || ?1 OR event_id LIKE 'autonomy_incident:' || ?1 || '_rate:%') AND created_at > ?2 LIMIT 1")
      .bind(proposal.actionClass, proposal.createdAt)
      .first();
    if (incident) return refuse(proposal, `An incident was recorded for ${proposal.actionClass} since this was proposed, so it is not applied. Nothing changed.`);
  }

  const at = now.toISOString();
  const reason = proposal.origin === "review" ? "promotion proposed by the weekly review, confirmed by the operator" : "autonomy-set, confirmed by the operator";
  let applied: boolean;
  try {
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO autonomy_level_changes (action_class, from_level, to_level, source, actor, reason, proposal_id, created_at)
           SELECT ?1, ?2, ?3, 'operator', ?4, ?5, ?6, ?7
            WHERE COALESCE((SELECT MAX(id) FROM autonomy_level_changes WHERE action_class = ?1), 0) = ?8
              AND EXISTS (SELECT 1 FROM autonomy_proposals WHERE id = ?6 AND status = 'open')
              AND (?3 <= ?2 OR NOT EXISTS (SELECT 1 FROM event_effects WHERE effect = 'autonomy_incident' AND event_id LIKE 'autonomy_incident:%' AND (event_id LIKE '%:' || ?1 OR event_id LIKE 'autonomy_incident:' || ?1 || '_rate:%') AND created_at > ?9))`,
        )
        .bind(proposal.actionClass, proposal.from, proposal.to, actor, reason, proposal.id, at, proposal.basedOnChange, proposal.createdAt),
      db
        .prepare("UPDATE autonomy_proposals SET status = 'applied', decided_by = ?2, decided_at = ?3 WHERE id = ?1 AND status = 'open' AND EXISTS (SELECT 1 FROM autonomy_level_changes WHERE proposal_id = ?1)")
        .bind(proposal.id, actor, at),
    ]);
    applied = (results[0]?.meta.changes ?? 0) === 1;
  } catch (error) {
    return { ok: false, text: `The change could not be recorded (${sanitizeErrorMessage(error)}), so nothing changed. Send the same command again to retry.` };
  }
  if (!applied) return refuse(proposal, `${proposal.actionClass} changed, or had an incident, while this was being confirmed. Nothing changed.`);

  let flagWritten = false;
  if (deps.kv) {
    try {
      await deps.kv.put(levelFlagKey(proposal.actionClass), String(proposal.to));
      flagWritten = true;
    } catch {
      flagWritten = false;
    }
  }
  if (proposal.to <= 1) await returnAutomaticApprovals(db, proposal.actionClass, now);
  // Report the level the class acts at now, read again, never the one that was asked for: a flag
  // that could not be written may leave it lower (or, after an earlier level, exactly at the target).
  const after = await readAutonomyLevel({ flags: deps.flags, db, config: deps.config }, proposal.actionClass);
  const flagNote = flagWritten ? "" : ` The ${levelFlagKey(proposal.actionClass)} flag could not be written, so it still shows its old value.`;
  if (after.error) {
    return { ok: false, text: `The change to level ${proposal.to} was recorded, but ${proposal.actionClass}'s level could not be read back (${after.error}), so it counts as level 1 until it can be.${flagNote}` };
  }
  if (after.level !== proposal.to) {
    return {
      ok: false,
      text: `The change to level ${proposal.to} was recorded, but ${proposal.actionClass} acts at level ${after.level}.${flagNote} Send autonomy-set ${proposal.actionClass} ${proposal.to} again to retry.`,
    };
  }
  return { ok: true, level: after.level, actionClass: proposal.actionClass, text: `${proposal.actionClass} is now at level ${after.level} (it was at ${proposal.from}).${flagNote}` };
}
