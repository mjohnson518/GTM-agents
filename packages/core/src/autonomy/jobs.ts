// GTM-agents: the autonomy jobs a deployment registers.
//
//   createAutonomyJobs({ operator: (env) => operatorChannel(env) })
//
// returns two job definitions for the job registry:
//   - autonomy_review  Mondays 06:00 UTC, flag autonomy_review:enabled: the promotion review
//                      (promotion.ts). It proposes, with evidence, and changes nothing; the operator
//                      applies a proposal with its autonomy-confirm command. No model call.
//   - autonomy_watch   every hour at :15, no flag: the safety net for demotion. It records every
//                      incident the opt-out path could not (incidents.ts, reconcileIncidents), runs
//                      the cold batch's rate check, writes a demoted class's flag down to the
//                      demoted level where the flag is higher, tells the operator about every new
//                      demotion, and expires stale proposals. It has no flag because it only ever
//                      tightens: everything starts at level 1, so until a person raises a class or
//                      turns on auto-approve it finds nothing to do. No model call.
// The job runner checks the halt first; while halted nothing is sent, so nothing needs watching.
import { defineJob, type JobContext, type RegisteredJob } from "../jobs/registry.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import type { KvStore } from "../shared/kv.ts";
import { claimEffect, releaseEffect } from "../events/effects.ts";
import { DAY_MS } from "../metrics/window.ts";
import { AUTONOMY_FLAGS, readFlagState } from "./flags.ts";
import { checkColdBatchRates, reconcileIncidents, INCIDENT_WINDOW_DAYS, type RateCheckResult } from "./incidents.ts";
import { effectiveLevel } from "./levels.ts";
import { runAutonomyReview } from "./promotion.ts";
import { expireProposals } from "./proposals.ts";
import { latestLevelChange, latestLevelChanges, levelFlagKey, parseLevelFlag, LEVEL_CHANGE_COLUMNS } from "./store.ts";
import type { GtmConfig } from "../config/schema.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";

export const AUTONOMY_REVIEW_JOB = "autonomy_review";
export const AUTONOMY_WATCH_JOB = "autonomy_watch";

/** The bindings the autonomy jobs read. A deployment's Env satisfies it. */
export interface AutonomyEnv {
  DB: D1Database;
  KV?: KvStore;
}

export interface AutonomyJobOptions {
  reviewSchedule: string;
  watchSchedule: string;
  /** Suppression entries the watch re-checks per run. */
  watchMaxRows: number;
  /** The chat proposals and demotion notices go to. Defaults to the first allowlisted chat. */
  chatId?: string;
}

export const DEFAULT_AUTONOMY_JOB_OPTIONS: Readonly<AutonomyJobOptions> = Object.freeze({
  reviewSchedule: "0 6 * * MON",
  watchSchedule: "15 * * * *",
  watchMaxRows: 200,
});

export interface AutonomyDeps<E extends AutonomyEnv = AutonomyEnv> {
  /** Where proposals and demotion notices go. */
  operator?: (env: E) => OperatorChannel | undefined;
  options?: Partial<AutonomyJobOptions>;
}

const tryBuild = <E, T>(factory: ((env: E) => T | undefined) | undefined, env: E): T | undefined => {
  try {
    return factory?.(env);
  } catch {
    return undefined;
  }
};

export interface WatchDeps {
  db: D1Database;
  kv: KvStore | undefined;
  flags: FlagReader;
  config: Pick<GtmConfig, "autonomy" | "operator">;
  operator?: OperatorChannel;
  chatId?: string;
  now: Date;
  log: JobLogger;
  maxRows: number;
}

export interface WatchResult {
  reconciled: number;
  reconcileFailed: number;
  rates: RateCheckResult["status"] | "unreadable";
  flagsWritten: number;
  notified: number;
  expired: number;
}

const NOTICE_EFFECT = "autonomy_demotion_notice";

/** One run of the watch. Throws only when the incident list cannot be read at all. */
export async function runAutonomyWatch(deps: WatchDeps): Promise<WatchResult> {
  const { db, now, log } = deps;
  const result: WatchResult = { reconciled: 0, reconcileFailed: 0, rates: "unreadable", flagsWritten: 0, notified: 0, expired: 0 };

  // 1. Incidents the opt-out path could not record.
  const reconciled = await reconcileIncidents(db, now, deps.maxRows);
  result.reconciled = reconciled.recorded.length;
  result.reconcileFailed = reconciled.failed;

  // 2. The cold batch's rate check.
  try {
    result.rates = (await checkColdBatchRates({ db, flags: deps.flags, config: deps.config, now })).status;
  } catch (error) {
    log.warn("the cold batch's rates could not be read; the rate check runs again next hour", { error: sanitizeErrorMessage(error) });
  }

  // 3. Each class's flag written down to its latest recorded change, so the flag store shows the
  //    level the class acts at. The recorded change already applies without it.
  if (deps.kv) {
    try {
      for (const [actionClass, change] of await latestLevelChanges(db)) {
        // Only a standing demotion: the operator's confirm writes its own flag.
        if (change.source !== "demotion") continue;
        let flagLevel: number;
        try {
          const raw = await deps.kv.get(levelFlagKey(actionClass));
          flagLevel = raw === null || raw.trim() === "" ? effectiveLevel(actionClass, deps.config.autonomy.defaults[actionClass as keyof typeof deps.config.autonomy.defaults]) : (parseLevelFlag(raw) ?? 1);
        } catch {
          continue;
        }
        if (flagLevel > change.toLevel) {
          try {
            // Read again right before writing: a change confirmed meanwhile wins.
            if ((await latestLevelChange(db, actionClass))?.id !== change.id) continue;
            await deps.kv.put(levelFlagKey(actionClass), String(change.toLevel));
            result.flagsWritten += 1;
          } catch (error) {
            log.warn("a demoted class's flag could not be written; the recorded change still holds it", { actionClass, error: sanitizeErrorMessage(error) });
          }
        }
      }
    } catch (error) {
      log.warn("the recorded level changes could not be read", { error: sanitizeErrorMessage(error) });
    }
  }

  // 4. A notice for every new demotion, once each, retried until it is delivered.
  try {
    const since = new Date(now.getTime() - INCIDENT_WINDOW_DAYS * DAY_MS).toISOString();
    const { results } = await db
      .prepare(
        `SELECT ${LEVEL_CHANGE_COLUMNS} FROM autonomy_level_changes c
          WHERE c.source = 'demotion' AND c.created_at >= ?1
            AND NOT EXISTS (SELECT 1 FROM event_effects ee WHERE ee.event_id = 'autonomy_demotion:' || c.id AND ee.effect = ?2)
          ORDER BY c.id ASC LIMIT 20`,
      )
      .bind(since, NOTICE_EFFECT)
      .all<{ id: number; action_class: string; to_level: number; reason: string | null; created_at: string }>();
    const chat = deps.chatId ?? deps.config.operator.allowedChatIds[0];
    for (const row of results) {
      if (!deps.operator) break;
      const key = `autonomy_demotion:${row.id}`;
      if (!(await claimEffect(db, key, NOTICE_EFFECT))) continue;
      try {
        await deps.operator.notify({
          text: `Autonomy demoted: ${row.action_class} is back to level ${row.to_level} at most, after ${row.reason ?? "an incident"} (${row.created_at.slice(0, 16).replace("T", " ")} UTC). Its automatically approved drafts that had not gone out are back for review, and nothing in it goes out on its own (the cold batch's auto-approve switch included) until you record a level again with autonomy-set ${row.action_class} <level>.`,
          ...(chat ? { chatId: chat } : {}),
        });
        result.notified += 1;
      } catch (error) {
        await releaseEffect(db, key, NOTICE_EFFECT);
        log.warn("a demotion notice could not be sent; it is retried next hour", { error: sanitizeErrorMessage(error) });
      }
    }
  } catch (error) {
    log.warn("demotion notices could not be read", { error: sanitizeErrorMessage(error) });
  }

  // 5. Proposals past their time.
  try {
    result.expired = await expireProposals(db, now);
  } catch {
    // Bookkeeping: a stale proposal is refused when confirmed anyway.
  }
  if (reconciled.failed > 0 && deps.operator) {
    try {
      await deps.operator.notify({ text: `The autonomy watch could not record ${reconciled.failed} incident(s) after an automatic send. It tries again next hour; until then every level read that fails counts as level 1.`, ...(deps.chatId ? { chatId: deps.chatId } : {}) });
    } catch {
      // The run row records the failure count.
    }
  }
  return result;
}

export function createAutonomyJobs<E extends AutonomyEnv>(deps: AutonomyDeps<E> = {}): RegisteredJob<E>[] {
  const options: AutonomyJobOptions = { ...DEFAULT_AUTONOMY_JOB_OPTIONS, ...(deps.options ?? {}) };
  if (!Number.isInteger(options.watchMaxRows) || options.watchMaxRows < 1 || options.watchMaxRows > 1000) throw new Error("autonomy option watchMaxRows must be a whole number from 1 to 1000");
  const chatOf = (ctx: JobContext<E>) => options.chatId ?? ctx.config.operator.allowedChatIds[0];

  const review = defineJob<E>({
    name: AUTONOMY_REVIEW_JOB,
    schedule: options.reviewSchedule,
    flag: AUTONOMY_FLAGS.review,
    ceilings: { maxDurationMs: 60_000, maxRows: 20 },
    rerunnable: true,
    async run(ctx) {
      if ((await readFlagState(ctx.flags, AUTONOMY_FLAGS.review)) !== true) return { summary: "flag off" };
      const operator = tryBuild(deps.operator, ctx.env);
      const chat = chatOf(ctx);
      const result = await runAutonomyReview({ db: ctx.env.DB, flags: ctx.flags, config: ctx.config, ...(operator ? { operator } : {}), ...(chat ? { chatId: chat } : {}), now: ctx.now, log: ctx.log });
      return { summary: `classes ${result.classes}, proposals ${result.proposals.length}${result.proposals.length ? (result.notified ? " (sent)" : " (not sent)") : ""}`, rows: result.classes };
    },
  });

  const watch = defineJob<E>({
    name: AUTONOMY_WATCH_JOB,
    schedule: options.watchSchedule,
    ceilings: { maxDurationMs: 120_000, maxRows: options.watchMaxRows },
    critical: true,
    rerunnable: true,
    async run(ctx) {
      const operator = tryBuild(deps.operator, ctx.env);
      const chat = chatOf(ctx);
      const result = await runAutonomyWatch({
        db: ctx.env.DB,
        kv: ctx.env.KV,
        flags: ctx.flags,
        config: ctx.config,
        ...(operator ? { operator } : {}),
        ...(chat ? { chatId: chat } : {}),
        now: ctx.now,
        log: ctx.log,
        maxRows: Math.min(options.watchMaxRows, ctx.ceilings.maxRows ?? options.watchMaxRows),
      });
      return {
        summary: `incidents recorded ${result.reconciled}${result.reconcileFailed ? ` (${result.reconcileFailed} failed)` : ""}, cold batch rates ${result.rates}, flags written ${result.flagsWritten}, notices ${result.notified}, proposals expired ${result.expired}`,
        rows: result.reconciled + result.flagsWritten + result.notified,
      };
    },
  });

  return [review, watch];
}
