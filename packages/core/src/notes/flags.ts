// GTM-agents: the meeting notes flags and limits (docs/MEETING-NOTES.md).
//
// convert:notes_enabled turns on reading recordings and extracting from them (and so the objections
// filed from calls). What was already processed stays in your briefs and the weekly digest after it
// is turned off, until erasure or retention removes it; retention itself runs whatever the flag
// says, since it only deletes. convert:notes_in_recap adds agreed next steps to recap drafts. Both
// default off, and a flag that cannot be read is off.
// Every key is listed in packages/core/src/flags/registry.ts, so `gtm doctor` shows it.
import { isFlagOn } from "../jobs/loop.ts";
import type { FlagReader } from "../jobs/registry.ts";

export const NOTES_FLAGS = Object.freeze({
  enabled: "convert:notes_enabled",
  inRecap: "convert:notes_in_recap",
});

export const NOTES_LIMITS = Object.freeze({
  /** Recordings one ingest run looks at, at most. */
  ingestPerRun: 20,
  /** Recordings asked for per page. */
  pageSize: 25,
  /** A provider's first run lists this far back. */
  firstLookbackDays: 7,
  /** Later runs list from the last finished run, less this overlap. */
  overlapHours: 24,
  /** A calendar meeting and a recording are the same meeting when their starts are this close. */
  matchWindowMinutes: 30,
  /** A stored transcript keeps at most this many bytes of segments. */
  transcriptMaxBytes: 200_000,
  /** Meetings one extraction run reads, at most, one model call each. */
  extractPerRun: 5,
  /** The most a UTC day of extraction may spend, in cents. */
  extractDailyCents: 100,
  /** Transcript characters the model reads, at most. */
  modelInputChars: 30_000,
  /** Model calls tried on one transcript without a usable answer, before it is left unextracted. */
  maxAttempts: 3,
  /** Items kept per kind (pain points, objections, next steps). */
  itemsPerKind: 5,
  quoteMaxChars: 300,
  /** Transcripts are deleted this long after the meeting. */
  retentionDays: 365,
  retentionPerRun: 200,
  /** Next steps a recap may carry. */
  recapNextSteps: 3,
  /** Processed meetings a brief shows. */
  briefMeetings: 2,
});

async function on(flags: FlagReader, key: string): Promise<boolean> {
  try {
    return isFlagOn(await flags.get(key));
  } catch {
    return false;
  }
}

export const notesEnabled = (flags: FlagReader): Promise<boolean> => on(flags, NOTES_FLAGS.enabled);
export const notesInRecap = (flags: FlagReader): Promise<boolean> => on(flags, NOTES_FLAGS.inRecap);
