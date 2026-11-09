// GTM-agents: the one definition of a send's cohort: what kind of reason the message had.
//
//   - signalled: the contact, or the contact's account, had a signal (a job change, hiring, funding,
//     a launch, a post and the like, in signal_events) detected in the 90 days before the send. A
//     signal the operator dismissed does not count;
//   - segment_routed: no such signal, and the template the message was built from targets segments,
//     personas or team sizes;
//   - generic: neither. Reported on its own and never called personalized.
//
// The composer works the cohort out when it writes a draft (the cold batch and the follow-up sweep),
// the draft carries it to the send function, and the send function records it on the ledger
// (outreach_sends.cohort). A signal lookup that fails leaves the cohort unknown (null) rather than
// guessing generic: the send still goes, and reports show it as unlabelled.
import { inChunks, placeholders } from "../data/d1.ts";
import { DAY_MS } from "./window.ts";

export const SEND_COHORTS = ["signalled", "segment_routed", "generic"] as const;
export type SendCohort = (typeof SEND_COHORTS)[number];

/** A signal counts toward the cohort when it was detected at most this many days before the send. */
export const COHORT_SIGNAL_DAYS = 90;

export function isSendCohort(value: unknown): value is SendCohort {
  return typeof value === "string" && (SEND_COHORTS as readonly string[]).includes(value);
}

/** The cohort from its two facts. Pure. */
export function sendCohort(input: { signalled: boolean; templateTargeted: boolean }): SendCohort {
  if (input.signalled) return "signalled";
  if (input.templateTargeted) return "segment_routed";
  return "generic";
}

/** True when a template targets at least one segment, persona or team size. Pure. */
export function templateIsTargeted(meta: { segments?: readonly string[] | undefined; personas?: readonly string[] | undefined; team_sizes?: readonly string[] | undefined } | null | undefined): boolean {
  if (!meta) return false;
  return [meta.segments, meta.personas, meta.team_sizes].some((list) => Array.isArray(list) && list.length > 0);
}

export interface CohortSubject {
  contactId: string;
  accountKey: string | null;
}

/**
 * The contacts among `subjects` with a signal (their own, or their account's) detected in the
 * COHORT_SIGNAL_DAYS before `at`. Null when the signals could not be read: the caller records no
 * cohort rather than a guessed one. Never throws.
 */
export async function signalledContacts(db: D1Database, subjects: readonly CohortSubject[], at: Date): Promise<Set<string> | null> {
  const out = new Set<string>();
  if (subjects.length === 0) return out;
  const to = at.toISOString();
  const from = new Date(at.getTime() - COHORT_SIGNAL_DAYS * DAY_MS).toISOString();
  try {
    const contactIds = [...new Set(subjects.map((s) => s.contactId).filter((id) => id.length > 0))];
    for (const chunk of inChunks(contactIds, { reserved: 2 })) {
      const { results } = await db
        .prepare(
          `SELECT DISTINCT contact_id FROM signal_events
            WHERE contact_id IN (${placeholders(chunk.length, 3)}) AND detected_at >= ?1 AND detected_at <= ?2 AND status <> 'dismissed'`,
        )
        .bind(from, to, ...chunk)
        .all<{ contact_id: string }>();
      for (const r of results) out.add(r.contact_id);
    }
    const accounts = [...new Set(subjects.map((s) => s.accountKey).filter((k): k is string => typeof k === "string" && k.length > 0))];
    const signalledAccounts = new Set<string>();
    for (const chunk of inChunks(accounts, { reserved: 2 })) {
      const { results } = await db
        .prepare(
          `SELECT DISTINCT account_key FROM signal_events
            WHERE account_key IN (${placeholders(chunk.length, 3)}) AND detected_at >= ?1 AND detected_at <= ?2 AND status <> 'dismissed'`,
        )
        .bind(from, to, ...chunk)
        .all<{ account_key: string }>();
      for (const r of results) signalledAccounts.add(r.account_key);
    }
    for (const s of subjects) if (s.accountKey && signalledAccounts.has(s.accountKey)) out.add(s.contactId);
    return out;
  } catch {
    return null;
  }
}

/** The cohort for one subject, given the lookup's result: null when the lookup failed. Pure. */
export function cohortFor(signalled: ReadonlySet<string> | null, contactId: string, templateTargeted: boolean): SendCohort | null {
  if (signalled === null) return null;
  return sendCohort({ signalled: signalled.has(contactId), templateTargeted });
}
