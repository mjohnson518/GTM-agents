// GTM-agents: the meeting notes jobs a deployment registers (docs/MEETING-NOTES.md).
//
//   createMeetingNotesJobs({ providers: (env) => [fathom(env)], model: (env) => gateway(env) })
//
// returns three jobs. Ingest and extraction run behind convert:notes_enabled (default off), each
// checking the flag again itself (failing closed):
//   - meeting_notes_ingest           hourly at :10   no model, no spend; 20 recordings a run per provider
//   - meeting_notes_extract          hourly at :40   one worker-role call per meeting, 5 a run,
//                                                    100 cents a day (budget:job:meeting_notes_extract:daily_cents)
//   - meeting_transcript_retention   daily 03:50     transcripts over a year old, 200 a run; no flag:
//                                                    it only deletes, so turning the feature off never
//                                                    keeps a transcript past its year
// They need the BUCKET binding: without it nothing is read or written. Providers and the model are
// built per run, so secrets are read when a job runs. A provider error fails the run.
import { defineJob, type RegisteredJob } from "../jobs/registry.ts";
import type { MeetingNotesProvider } from "../ports/business.ts";
import type { ModelGateway } from "../ports/model.ts";
import { assertModelSchedule } from "../replies/jobs.ts";
import { createSpendGate } from "../sourcing/spend.ts";
import { EXTRACT_JOB, runNotesExtract } from "./extract.ts";
import { NOTES_FLAGS, NOTES_LIMITS, notesEnabled } from "./flags.ts";
import { runNotesIngest } from "./ingest.ts";
import { runTranscriptRetention } from "./retention.ts";
import type { BrainKv } from "../learning/brain-edit.ts";

export const INGEST_JOB = "meeting_notes_ingest";
export const RETENTION_JOB = "meeting_transcript_retention";

export interface MeetingNotesEnv {
  DB: D1Database;
  BUCKET?: R2Bucket;
  KV?: BrainKv;
}

export interface MeetingNotesDeps<E extends MeetingNotesEnv = MeetingNotesEnv> {
  /** The meeting-notes tools to read, built per run. Empty when none is configured. */
  providers: (env: E) => MeetingNotesProvider[];
  model?: (env: E) => ModelGateway | undefined;
  schedules?: Partial<{ ingest: string; extract: string; retention: string }>;
}

const quietly = <T>(fn: () => T): T | undefined => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};

export function createMeetingNotesJobs<E extends MeetingNotesEnv>(deps: MeetingNotesDeps<E>): RegisteredJob<E>[] {
  const schedules = { ingest: "10 * * * *", extract: "40 * * * *", retention: "50 3 * * *", ...(deps.schedules ?? {}) };
  assertModelSchedule(schedules.extract, EXTRACT_JOB);

  const ingest = defineJob<E>({
    name: INGEST_JOB,
    schedule: schedules.ingest,
    flag: NOTES_FLAGS.enabled,
    ceilings: { maxDurationMs: 240_000, maxRows: NOTES_LIMITS.ingestPerRun * 2, maxSpendCents: 0 },
    rerunnable: true,
    async run(ctx) {
      if (!(await notesEnabled(ctx.flags))) return { summary: "flag off" };
      if (!ctx.env.BUCKET) return { summary: "no BUCKET binding: transcripts have nowhere to go, so nothing was read" };
      const providers = quietly(() => deps.providers(ctx.env)) ?? [];
      if (providers.length === 0) return { summary: "no meeting-notes provider configured" };
      const parts: string[] = [];
      const errors: string[] = [];
      let rows = 0;
      for (const provider of providers) {
        const r = await runNotesIngest({ db: ctx.env.DB, bucket: ctx.env.BUCKET, provider, now: ctx.now, log: ctx.log, signal: ctx.signal });
        rows += r.listed;
        parts.push(`${provider.name}: listed ${r.listed}, matched ${r.matched}, skipped ${r.skipped.no_contact} no contact, ${r.skipped.ambiguous} ambiguous, ${r.skipped.suppressed} suppressed, ${r.skipped.no_transcript} without a transcript, ${r.skipped.invalid} invalid, ${r.waiting} waiting`);
        if (r.error) errors.push(`${provider.name}: ${r.error}`);
      }
      if (errors.length > 0) throw new Error(`the meeting-notes provider failed (${parts.join("; ")}): ${errors.join("; ")}`);
      return { summary: parts.join("; "), rows };
    },
  });

  const extract = defineJob<E>({
    name: EXTRACT_JOB,
    schedule: schedules.extract,
    flag: NOTES_FLAGS.enabled,
    ceilings: { maxDurationMs: 360_000, maxRows: NOTES_LIMITS.extractPerRun, maxSpendCents: NOTES_LIMITS.extractDailyCents },
    rerunnable: true,
    async run(ctx) {
      if (!(await notesEnabled(ctx.flags))) return { summary: "flag off" };
      if (!ctx.env.BUCKET) return { summary: "no BUCKET binding" };
      const spend = createSpendGate({ db: ctx.env.DB, flags: ctx.flags, job: EXTRACT_JOB, ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}), jobCapCents: NOTES_LIMITS.extractDailyCents, log: ctx.log });
      const r = await runNotesExtract({
        db: ctx.env.DB,
        bucket: ctx.env.BUCKET,
        kv: ctx.env.KV,
        model: quietly(() => deps.model?.(ctx.env)),
        config: ctx.config,
        spend,
        now: ctx.now,
        log: ctx.log,
        ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
        signal: ctx.signal,
      });
      return { summary: `processed ${r.processed}, empty ${r.empty}, released ${r.released}, failed ${r.failed}, objections filed ${r.objectionsFiled}${r.stopped ? `; stopped: ${r.stopped}` : ""}`, rows: r.processed + r.empty + r.failed };
    },
  });

  const retention = defineJob<E>({
    name: RETENTION_JOB,
    schedule: schedules.retention,
    ceilings: { maxDurationMs: 60_000, maxRows: NOTES_LIMITS.retentionPerRun },
    rerunnable: true,
    async run(ctx) {
      if (!ctx.env.BUCKET) return { summary: "no BUCKET binding" };
      const deleted = await runTranscriptRetention({ db: ctx.env.DB, bucket: ctx.env.BUCKET, now: ctx.now });
      return { summary: `deleted ${deleted} transcripts over ${NOTES_LIMITS.retentionDays} days old`, rows: deleted };
    },
  });

  return [ingest, extract, retention];
}
