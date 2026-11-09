// GTM-agents: where an action class's level lives, and the one reader every caller uses.
//
// A level is stored in two places, and a class acts at the lower of them:
//   - the autonomy:<class> flag (KV), written by the operator's confirmed autonomy-set and by
//     `gtm flags set`; unset, the starting level in gtm.config.ts (autonomy.defaults), else 1;
//   - the latest row for the class in autonomy_level_changes (D1), written by the operator's
//     confirmed autonomy-set (source operator) and by an automatic demotion (source demotion).
// So a recorded change can only ever lower what the flag says. A class with no recorded change
// acts at its flag or starting level, which only someone with access to the deployment's flag
// store or its config can set. Once a class has a recorded change, raising it past that change
// needs a confirmed operator change; a demotion holds even when the flag store cannot be written,
// and a value written straight to the flag store cannot lift a class above its latest change.
//
// Every read fails closed, toward level 1:
//   - a flag that cannot be read, or holds anything but a single digit 0 to 3, is level 1;
//   - a change record that cannot be read caps the level at 1 and counts as a standing demotion;
//   - effectiveLevel caps the permanently human-only classes (PERMANENT_HUMAN) at 1 and gives an
//     unknown class string no more than 1, so nothing read from storage can loosen them.
// Callers that act on a level (the cold batch, the follow-up sweep, reply auto-send) pass the
// database, so a demotion recorded there applies at once.
import type { GtmConfig } from "../config/schema.ts";
import type { FlagReader } from "../jobs/registry.ts";
import { AUTONOMY_LEVELS, DEFAULT_AUTONOMY_LEVEL, effectiveLevel, type AutonomyLevel } from "./levels.ts";

/** The flag key that holds a class's level. */
export const levelFlagKey = (actionClass: string): string => `autonomy:${actionClass}`;

export type LevelChangeSource = "operator" | "demotion";

export interface LevelChange {
  id: number;
  actionClass: string;
  fromLevel: AutonomyLevel | null;
  toLevel: AutonomyLevel;
  source: LevelChangeSource;
  actor: string;
  reason: string | null;
  proposalId: string | null;
  createdAt: string;
}

interface LevelChangeRow {
  id: number;
  action_class: string;
  from_level: number | null;
  to_level: number;
  source: string;
  actor: string;
  reason: string | null;
  proposal_id: string | null;
  created_at: string;
}

const asLevel = (value: unknown): AutonomyLevel | null => (typeof value === "number" && (AUTONOMY_LEVELS as readonly number[]).includes(value) ? (value as AutonomyLevel) : null);

function toChange(row: LevelChangeRow): LevelChange {
  return {
    id: Number(row.id),
    actionClass: row.action_class,
    fromLevel: asLevel(row.from_level),
    // A row the CHECK constraint would refuse is read as the lowest level: it can only lower.
    toLevel: asLevel(row.to_level) ?? 0,
    source: row.source === "operator" ? "operator" : "demotion",
    actor: row.actor,
    reason: row.reason,
    proposalId: row.proposal_id,
    createdAt: row.created_at,
  };
}

export const LEVEL_CHANGE_COLUMNS = "id, action_class, from_level, to_level, source, actor, reason, proposal_id, created_at";

/** The latest recorded change for a class, or null when there is none. Throws on a database error. */
export async function latestLevelChange(db: D1Database, actionClass: string): Promise<LevelChange | null> {
  const row = await db
    .prepare(`SELECT ${LEVEL_CHANGE_COLUMNS} FROM autonomy_level_changes WHERE action_class = ?1 ORDER BY id DESC LIMIT 1`)
    .bind(actionClass)
    .first<LevelChangeRow>();
  return row ? toChange(row) : null;
}

/** The latest recorded change of every class that has one. Throws on a database error. */
export async function latestLevelChanges(db: D1Database): Promise<Map<string, LevelChange>> {
  const { results } = await db
    .prepare(
      `SELECT ${LEVEL_CHANGE_COLUMNS} FROM autonomy_level_changes c
        WHERE c.id = (SELECT MAX(id) FROM autonomy_level_changes x WHERE x.action_class = c.action_class)`,
    )
    .all<LevelChangeRow>();
  return new Map(results.map((r) => [r.action_class, toChange(r)]));
}

/** A flag value as a level: a single digit 0 to 3, or null for anything else. */
export function parseLevelFlag(raw: string | null | undefined): AutonomyLevel | null {
  const value = raw?.trim() ?? "";
  return /^[0-3]$/.test(value) ? (Number(value) as AutonomyLevel) : null;
}

export interface LevelReading {
  actionClass: string;
  /** The level the class acts at, after every cap. */
  level: AutonomyLevel;
  /** Where the flag side came from. */
  source: "flag" | "config" | "default" | "unreadable" | "malformed";
  /** The flag's level as stored, or null when unset, unreadable or malformed. */
  flag: AutonomyLevel | null;
  /** The latest recorded change, when the database was read and has one. */
  latest: LevelChange | null;
  /** True when the latest recorded change is a demotion, or the record could not be read. */
  demoted: boolean;
  /** Set when a read failed. The level is then at most 1. */
  error: string | null;
}

export interface LevelReadDeps {
  flags: FlagReader;
  /** The database. Without it, recorded changes (and demotions) are not applied. */
  db?: D1Database;
  /** The starting levels in gtm.config.ts, used when the flag is unset. */
  config?: Pick<GtmConfig, "autonomy">;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200);

/** Read a class's level. Never throws: every failure reads as level 1 at most. */
export async function readAutonomyLevel(deps: LevelReadDeps, actionClass: string): Promise<LevelReading> {
  let stored: unknown;
  let source: LevelReading["source"];
  let flag: AutonomyLevel | null = null;
  let error: string | null = null;
  try {
    const raw = await deps.flags.get(levelFlagKey(actionClass));
    if (raw === null || raw.trim() === "") {
      const configured = (deps.config?.autonomy.defaults as Partial<Record<string, number>> | undefined)?.[actionClass];
      stored = configured;
      source = configured === undefined ? "default" : "config";
    } else {
      flag = parseLevelFlag(raw);
      stored = flag ?? undefined;
      source = flag === null ? "malformed" : "flag";
    }
  } catch (e) {
    stored = undefined;
    source = "unreadable";
    error = `the flag could not be read: ${message(e)}`;
  }
  let level = effectiveLevel(actionClass, stored);
  let latest: LevelChange | null = null;
  let demoted = false;
  if (deps.db) {
    try {
      latest = await latestLevelChange(deps.db, actionClass);
      if (latest) {
        level = Math.min(level, latest.toLevel) as AutonomyLevel;
        demoted = latest.source === "demotion";
      }
    } catch (e) {
      level = Math.min(level, DEFAULT_AUTONOMY_LEVEL) as AutonomyLevel;
      demoted = true;
      error = `${error ? `${error}; ` : ""}the recorded changes could not be read: ${message(e)}`;
    }
  }
  return { actionClass, level, source, flag, latest, demoted, error };
}
