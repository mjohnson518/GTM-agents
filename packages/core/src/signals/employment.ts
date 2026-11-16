// GTM-agents: employment checks and champion moves (docs/SIGNALS.md#employment-checks).
//
// Each run checks up to SIGNAL_LIMITS.employmentChecksPerRun contacts through an EmploymentChecker
// (the data-leadmagic adapter). A contact is due when it has an https profile URL and an account,
// is not already moved, opted out or churned, is not suppressed or tombstoned, and was never
// checked, checked over 90 days ago, or came back inconclusive over 30 days ago. Customers, hot,
// engaged and warming contacts go first, then the rest, oldest check first. The suppression check
// runs again before each paid call and fails closed; a contact it blocks is set aside for 90 days,
// so blocked contacts never hold the head of the queue.
//
// What a check does:
//   - current: employment_status becomes current. A current role that began in the last 90 days
//     is one job_change signal for that contact (the "new role" angle), with a fixed headline and
//     the profile as its source URL;
//   - moved: employment_status becomes moved, so cold selection and sequences stop on their own.
//     For a warming or warmer contact, the operator gets one notice written only from our own
//     columns (their name, our account key and the contact id), never from the provider's text;
//   - anything else (never worked there, ambiguous, unknown, profile not found): employment_status
//     becomes unknown, and the contact is checked again after 30 days.
// Every check writes employment_checked_at and bumps updated_at.
//
// Champion moves (signals:champion_moves_enabled) are a second pass in the same run, over every
// moved contact who was engaged, hot or a customer and has not been looked up yet, so a move found
// while the flag was off, or a lookup the budget or a provider error stopped, is picked up later.
// At most championFindsPerRun lookups a run; each finished lookup is marked on the contact
// (attributes.champion_lookup_at), found or not, and never repeated. The address is kept only when
// it is a clean work address at the domain the provider names, that domain is not the old account,
// and it is not suppressed. It becomes a raw candidate (source champion_move) linked to the old
// contact by source_contact_id, so the ordinary discovery cycle screens, verifies, qualifies (the
// ICP, the never list, person fit on the new title) and promotes it like any other candidate;
// promotion also refuses it if the person has since opted out at their earlier address, and
// erasure follows the link. Nothing is sent.
//
// Every paid call goes through the job's spend gate. A provider error stops the run: the contacts
// not yet checked stay due. The provider's title and company name are stored on the candidate as
// cleaned data, like any provider's, and never reach a notice or a signal headline.
import { claimEffect } from "../events/effects.ts";
import { accountKey } from "../data/keys.ts";
import type { JobLogger } from "../jobs/registry.ts";
import type { EmploymentChecker, EmploymentStatus } from "../ports/contact.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { checkSuppression } from "../sending/suppression.ts";
import { insertCandidate } from "../sourcing/candidates.ts";
import { screenAddress } from "../sourcing/identity.ts";
import type { SpendGate } from "../sourcing/spend.ts";
import { PROVIDER_TEXT_CAPS, cleanProviderText, cleanProviderUrl } from "../sourcing/text.ts";
import { SIGNAL_LIMITS } from "./flags.ts";
import { expiryAfter, recordSignal } from "./record.ts";

const DAY_MS = 86_400_000;
/** The source type of the signals and the candidates this module writes. */
export const EMPLOYMENT_SIGNAL_SOURCE = "employment_check";
export const CHAMPION_SOURCE = "champion_move";
export const NEW_ROLE_HEADLINE = "Started a new role";

/** Warmth at which a move is worth telling the operator. */
const NOTICE_WARMTH: ReadonlySet<string> = new Set(["warming", "engaged", "hot", "customer"]);

export interface EmploymentRunInput {
  db: D1Database;
  checker: EmploymentChecker;
  gate: SpendGate;
  now: Date;
  log: JobLogger;
  /** Notices about moved contacts go here. Without one, the move is only recorded. */
  operator?: OperatorChannel;
  /** Follow engaged contacts who moved to their new company (signals:champion_moves_enabled). */
  champions: boolean;
  maxChecks?: number;
  signal?: AbortSignal;
}

export interface EmploymentStats {
  checked: number;
  current: number;
  moved: number;
  inconclusive: number;
  skipped: number;
  signals: number;
  notices: number;
  champions: number;
  championLookups: number;
  /** Set when a provider error stopped the run, sanitized. */
  error?: string;
}

interface DueContact {
  id: string;
  /** The title the provider reported at the new employer, cleaned, for a moved contact. */
  moved_title?: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string;
  account_key: string;
  account_name: string | null;
  warmth: string;
  profile_url: string;
}

/** Neither the contact's address nor its mailbox is suppressed or tombstoned. */
const NOT_BLOCKED = `NOT EXISTS (SELECT 1 FROM suppression s WHERE s.email_sha256 IN (c.email_sha256, c.mailbox_sha256))
          AND NOT EXISTS (SELECT 1 FROM erasure_tombstones t WHERE t.email_sha256 IN (c.email_sha256, c.mailbox_sha256) OR t.mailbox_sha256 = c.mailbox_sha256)`;

/** Contacts due an employment check, most valuable first. */
export async function dueForEmploymentCheck(db: D1Database, now: Date, limit: number): Promise<DueContact[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.first_name, c.last_name, c.email, c.account_key, a.name AS account_name, c.warmth, json_extract(c.attributes, '$.profile_url') AS profile_url
         FROM contacts c LEFT JOIN accounts a ON a.account_key = c.account_key
        WHERE c.account_key IS NOT NULL
          AND json_extract(c.attributes, '$.profile_url') LIKE 'https://%'
          AND (c.employment_status IS NULL OR c.employment_status <> 'moved')
          AND c.warmth NOT IN ('opted_out', 'churned')
          AND ${NOT_BLOCKED}
          AND (c.employment_checked_at IS NULL OR c.employment_checked_at < ?1
               OR (c.employment_status = 'unknown' AND c.employment_checked_at < ?2))
        ORDER BY CASE c.warmth WHEN 'customer' THEN 0 WHEN 'hot' THEN 1 WHEN 'engaged' THEN 2 WHEN 'warming' THEN 3 WHEN 'contacted' THEN 4 ELSE 5 END,
                 (c.employment_checked_at IS NOT NULL), c.employment_checked_at, c.id
        LIMIT ?3`,
    )
    .bind(
      new Date(now.getTime() - SIGNAL_LIMITS.employmentRecheckDays * DAY_MS).toISOString(),
      new Date(now.getTime() - SIGNAL_LIMITS.employmentUnknownRecheckDays * DAY_MS).toISOString(),
      limit,
    )
    .all<DueContact>();
  return results;
}

async function setEmployment(db: D1Database, contactId: string, status: "current" | "moved" | "unknown", now: Date): Promise<void> {
  const stamp = now.toISOString();
  await db.prepare("UPDATE contacts SET employment_status = ?2, employment_checked_at = ?3, updated_at = ?3 WHERE id = ?1").bind(contactId, status, stamp).run();
}

/** Set a contact aside for the full recheck interval without changing its status. */
async function setAside(db: D1Database, contactId: string, now: Date): Promise<void> {
  const stamp = now.toISOString();
  await db.prepare("UPDATE contacts SET employment_checked_at = ?2, updated_at = ?2 WHERE id = ?1").bind(contactId, stamp).run();
}

/** Moved contacts worth following who have not been looked up yet, most recent move first. */
async function dueForChampionLookup(db: D1Database, limit: number): Promise<DueContact[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.first_name, c.last_name, c.email, c.account_key, a.name AS account_name, c.warmth, json_extract(c.attributes, '$.profile_url') AS profile_url,
              json_extract(c.attributes, '$.moved_title') AS moved_title
         FROM contacts c LEFT JOIN accounts a ON a.account_key = c.account_key
        WHERE c.employment_status = 'moved' AND c.warmth IN ('engaged', 'hot', 'customer') AND c.account_key IS NOT NULL
          AND json_extract(c.attributes, '$.profile_url') LIKE 'https://%'
          AND json_extract(c.attributes, '$.champion_lookup_at') IS NULL
          AND ${NOT_BLOCKED}
        ORDER BY c.employment_checked_at DESC, c.id
        LIMIT ?1`,
    )
    .bind(limit)
    .all<DueContact>();
  return results;
}

/** What our own row calls the person: their name, or a plain stand-in. Never provider text. */
function displayName(c: DueContact): string {
  const name = cleanProviderText([c.first_name, c.last_name].filter(Boolean).join(" "), PROVIDER_TEXT_CAPS.name);
  return name ?? "A contact";
}

/** One champion lookup. True when it added a candidate. Throws on a provider error. */
async function followChampion(input: EmploymentRunInput, c: DueContact, profileUrl: string): Promise<boolean> {
  const result = await input.checker.findCurrentWorkEmail({ profileUrl, ...(c.first_name ? { firstName: c.first_name } : {}), ...(c.last_name ? { lastName: c.last_name } : {}) });
  await input.gate.record(result.cost, { provider: input.checker.name, capability: "email_find" });
  // The lookup is done, found or not: it is not repeated.
  await input.db
    .prepare("UPDATE contacts SET attributes = json_set(attributes, '$.champion_lookup_at', ?2), updated_at = ?2 WHERE id = ?1")
    .bind(c.id, input.now.toISOString())
    .run();
  if (result.email === null) return false;
  const account = accountKey(result.domain);
  if (!account || account === c.account_key) return false;
  const screen = screenAddress(result.email, account);
  if (screen.verdict !== "clean" || !screen.email) return false;
  // A new address that is already suppressed, tombstoned or opted out is never stored.
  if (!(await checkSuppression(input.db, [screen.email])).ok) return false;
  return insertCandidate(
    input.db,
    {
      source: CHAMPION_SOURCE,
      sourceRef: `${c.id}:${account}`,
      searchType: "person",
      url: profileUrl,
      firstName: c.first_name,
      lastName: c.last_name,
      email: screen.email,
      emailSource: input.checker.name,
      jobTitle: cleanProviderText(result.title ?? c.moved_title, PROVIDER_TEXT_CAPS.title),
      accountName: cleanProviderText(result.companyName, PROVIDER_TEXT_CAPS.accountName),
      accountKey: account,
      status: "raw",
      attributes: { profile_url: profileUrl, champion_of: c.id },
      sourceContactId: c.id,
    },
    input.now,
  );
}

/** Champion lookups for moved contacts not yet looked up. Returns the contacts that became candidates. */
async function runChampionPass(input: EmploymentRunInput, stats: EmploymentStats): Promise<Map<string, DueContact>> {
  const followed = new Map<string, DueContact>();
  for (const c of await dueForChampionLookup(input.db, SIGNAL_LIMITS.championFindsPerRun)) {
    if (input.signal?.aborted) break;
    const profileUrl = cleanProviderUrl(c.profile_url);
    if (!profileUrl?.startsWith("https://")) continue;
    const check = await checkSuppression(input.db, [c.email]);
    if (!check.ok) continue;
    if (!(await input.gate.allow())) break;
    stats.championLookups += 1;
    try {
      if (await followChampion(input, c, profileUrl)) {
        stats.champions += 1;
        followed.set(c.id, c);
      }
    } catch (error) {
      stats.error = sanitizeErrorMessage(error);
      input.log.warn("the champion lookup failed; the run stops", { provider: input.checker.name, error: stats.error });
      break;
    }
  }
  return followed;
}

const NEW_CANDIDATE = "They were added as a candidate at their new company, and go through the usual checks before anything is sent.";

async function notify(input: EmploymentRunInput, key: string, text: string, stats: EmploymentStats): Promise<void> {
  if (!input.operator) return;
  try {
    if (!(await claimEffect(input.db, key, "operator_notice"))) return;
    await input.operator.notify({ text });
    stats.notices += 1;
  } catch (error) {
    input.log.warn("a notice about an employment change could not be sent", { error: sanitizeErrorMessage(error) });
  }
}

/** Run the checks, then the champion pass. Throws only on a database error; a provider error is returned as `error`. */
export async function runEmploymentChecks(input: EmploymentRunInput): Promise<EmploymentStats> {
  const stats: EmploymentStats = { checked: 0, current: 0, moved: 0, inconclusive: 0, skipped: 0, signals: 0, notices: 0, champions: 0, championLookups: 0 };
  const { db, now } = input;
  const moved: DueContact[] = [];
  const due = await dueForEmploymentCheck(db, now, input.maxChecks ?? SIGNAL_LIMITS.employmentChecksPerRun);
  for (const c of due) {
    if (input.signal?.aborted) break;
    const profileUrl = cleanProviderUrl(c.profile_url);
    if (!profileUrl?.startsWith("https://")) {
      stats.skipped += 1;
      await setAside(db, c.id, now);
      continue;
    }
    // Suppressed, tombstoned or opted out: no paid call, and set aside. A check that cannot be
    // read skips the contact for this run only.
    const check = await checkSuppression(db, [c.email]);
    if (!check.ok) {
      stats.skipped += 1;
      if (!check.blocked.some((b) => b.reason === "check_failed")) await setAside(db, c.id, now);
      continue;
    }
    if (!(await input.gate.allow())) break;
    let status: EmploymentStatus;
    let roleStartedAt: string | undefined;
    let title: string | undefined;
    try {
      const result = await input.checker.checkEmployment({ profileUrl, companyDomain: c.account_key, ...(c.account_name ? { companyName: c.account_name } : {}) });
      await input.gate.record(result.cost, { provider: input.checker.name, capability: "job_change" });
      ({ status, roleStartedAt, title } = result);
    } catch (error) {
      stats.error = sanitizeErrorMessage(error);
      input.log.warn("the employment check failed; the run stops", { provider: input.checker.name, error: stats.error });
      break;
    }
    stats.checked += 1;

    if (status === "current") {
      stats.current += 1;
      await setEmployment(db, c.id, "current", now);
      const started = roleStartedAt ? Date.parse(roleStartedAt) : NaN;
      if (Number.isFinite(started) && started <= now.getTime() && now.getTime() - started <= SIGNAL_LIMITS.employmentNewRoleDays * DAY_MS) {
        const outcome = await recordSignal(
          db,
          {
            type: "job_change",
            source: EMPLOYMENT_SIGNAL_SOURCE,
            accountKey: c.account_key,
            contactId: c.id,
            headline: NEW_ROLE_HEADLINE,
            url: profileUrl,
            eventDate: new Date(started).toISOString(),
            severity: SIGNAL_LIMITS.sourcedSeverity,
            expiresAt: expiryAfter(now, SIGNAL_LIMITS.employmentSignalExpiryDays),
            evidence: { checked_by: input.checker.name },
            eventKey: `${c.id}:${new Date(started).toISOString().slice(0, 10)}`,
          },
          now,
        );
        if (outcome.status === "recorded" && outcome.inserted > 0) stats.signals += 1;
      }
    } else if (status === "moved") {
      stats.moved += 1;
      await setEmployment(db, c.id, "moved", now);
      // The new title, cleaned, for the champion lookup: person fit reads it like any provider's.
      const movedTitle = cleanProviderText(title, PROVIDER_TEXT_CAPS.title);
      if (movedTitle) await db.prepare("UPDATE contacts SET attributes = json_set(attributes, '$.moved_title', ?2) WHERE id = ?1").bind(c.id, movedTitle).run();
      moved.push(c);
    } else {
      stats.inconclusive += 1;
      await setEmployment(db, c.id, "unknown", now);
    }
  }

  const followed = input.champions && stats.error === undefined ? await runChampionPass(input, stats) : new Map<string, DueContact>();

  // Notices, from our own columns only. The contact id lets erasure find a notice still held.
  for (const c of moved) {
    if (!NOTICE_WARMTH.has(c.warmth)) continue;
    const text = `${displayName(c)} at ${c.account_key} (contact ${c.id}) has moved to another company. No more cold or follow-up mail will go to their address there.${followed.has(c.id) ? ` ${NEW_CANDIDATE}` : ""}`;
    await notify(input, `employment_moved:${c.id}`, text, stats);
  }
  for (const c of followed.values()) {
    if (moved.some((m) => m.id === c.id)) continue;
    await notify(input, `employment_champion:${c.id}`, `${displayName(c)}, who moved from ${c.account_key} (contact ${c.id}): ${NEW_CANDIDATE}`, stats);
  }
  return stats;
}
