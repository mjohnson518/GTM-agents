// GTM-agents: booking attribution: which contact a booked meeting belongs to.
//
// In order, over the event's outside attendees (state.ts), first match wins:
//   1. accepted_contact: an attendee who accepted is a known contact (by address, any +tag);
//   2. organized_contact: the operator organized it and an invitee is a known contact;
//   3. domain_contacted: the operator organized it, and exactly one contact at an attendee's company
//      domain was written to in the last 60 days. Never for personal mail domains or shared hosts
//      (accountKey has no account for them), and never for an invite from outside: anyone can send
//      one. Two or more such contacts make the meeting ambiguous instead.
// The domain rule looks back from when the booking was first seen, not from now, so a contact
// written to after an unmatched meeting appeared never inherits it.
// Erased people are invisible here: withoutErased drops every attendee an erasure tombstone covers
// (exact address or mailbox) before anything is stored or matched, so a sync never brings back
// what an erasure removed.
// There is no click-based matching: booking links record nothing per person.
// An ambiguous meeting is not attributed; the operator is told once and links it with a command.
// Every read here is a lookup by hash or account key, and throws on a database error: attribution
// that cannot be read is retried on the next sync, never guessed.
import { accountKey } from "../data/keys.ts";
import type { MeetingAttribution } from "../metrics/meetings.ts";
import { addressHash, mailboxOf } from "../sending/suppression.ts";
import { CONVERT_LIMITS } from "./flags.ts";
import { isBooking, type ClassifiedEvent, type OutsideAttendee } from "./state.ts";
import type { CalendarEventSummary } from "../ports/business.ts";

const DAY_MS = 86_400_000;

export type AttributionResult =
  | { kind: "attributed"; method: MeetingAttribution; contactIds: string[] }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "unmatched" };

export interface AttendeeFingerprint {
  /** SHA-256 of each outside attendee's address, as stored for matching and erasure. */
  hashes: string[];
  /** One entry per attendee: exact hash, mailbox hash and domain, so erasure can remove one attendee whole. */
  entries: Array<{ h: string; m: string; d: string }>;
  /** Each outside attendee's domain. */
  domains: string[];
}

/**
 * What calendar_events keeps about the attendees: hashes and domains, never an address. Each
 * attendee contributes the hash of the exact address and of the address without a +tag, so erasing
 * any subaddress of the mailbox finds the row.
 */
export async function attendeeFingerprint(outside: readonly OutsideAttendee[]): Promise<AttendeeFingerprint> {
  const entries = await Promise.all(outside.map(async (a) => ({ h: await addressHash(a.email), m: await addressHash(mailboxOf(a.email)), d: a.email.slice(a.email.lastIndexOf("@") + 1) })));
  const hashes = entries.flatMap((e) => [e.h, e.m]);
  const domains = [...new Set(entries.map((e) => e.d))];
  return { hashes: [...new Set(hashes)].sort(), entries, domains: domains.sort() };
}

interface ContactMatch {
  id: string;
  email_sha256: string;
  mailbox_sha256: string;
  last_contacted_at: string | null;
}

/** Most recently written to first, then by id, so the primary contact is the same on every run. */
const byRecency = (a: ContactMatch, b: ContactMatch) => (b.last_contacted_at ?? "").localeCompare(a.last_contacted_at ?? "") || a.id.localeCompare(b.id);

/** The event without the attendees an erasure tombstone covers, its booking rule applied again. Throws on a database error. */
export async function withoutErased(db: D1Database, event: Pick<CalendarEventSummary, "status">, classified: ClassifiedEvent): Promise<ClassifiedEvent> {
  if (classified.outside.length === 0) return classified;
  const pairs = await Promise.all(classified.outside.map(async (a) => ({ a, hashes: [await addressHash(a.email), await addressHash(mailboxOf(a.email))] })));
  const { results } = await db
    .prepare(
      `SELECT value AS h FROM json_each(?1)
        WHERE value IN (SELECT email_sha256 FROM erasure_tombstones) OR value IN (SELECT mailbox_sha256 FROM erasure_tombstones WHERE mailbox_sha256 IS NOT NULL)`,
    )
    .bind(JSON.stringify(pairs.flatMap((p) => p.hashes)))
    .all<{ h: string }>();
  if (results.length === 0) return classified;
  const erased = new Set(results.map((r) => r.h));
  const outside = pairs.filter((p) => !p.hashes.some((h) => erased.has(h))).map((p) => p.a);
  const rest = { timed: classified.timed, operatorOrganized: classified.operatorOrganized, operatorDeclined: classified.operatorDeclined, operatorAccepted: classified.operatorAccepted, outside };
  return { ...rest, booking: isBooking(event, rest) };
}

/**
 * Attribute one booking first seen at `firstSeenAt` (the domain rule looks back 60 days from then).
 * Throws on a database error.
 */
export async function attributeEvent(db: D1Database, event: Pick<ClassifiedEvent, "outside" | "operatorOrganized">, firstSeenAt: Date): Promise<AttributionResult> {
  const attendees = await Promise.all(
    event.outside.map(async (a) => ({ ...a, hash: await addressHash(a.email), mailbox: await addressHash(mailboxOf(a.email)) })),
  );
  if (attendees.length === 0) return { kind: "unmatched" };
  const hashes = JSON.stringify([...new Set(attendees.flatMap((a) => [a.hash, a.mailbox]))]);
  const { results: known } = await db
    .prepare(
      `SELECT id, email_sha256, mailbox_sha256, last_contacted_at FROM contacts
        WHERE email_sha256 IN (SELECT value FROM json_each(?1)) OR mailbox_sha256 IN (SELECT value FROM json_each(?1))`,
    )
    .bind(hashes)
    .all<ContactMatch>();
  const matchesOf = (a: (typeof attendees)[number]) => known.filter((c) => c.email_sha256 === a.hash || c.mailbox_sha256 === a.mailbox || c.email_sha256 === a.mailbox);
  const unique = (rows: ContactMatch[]) => [...new Map(rows.map((r) => [r.id, r])).values()].sort(byRecency).map((r) => r.id);

  const accepted = unique(attendees.filter((a) => a.accepted).flatMap(matchesOf));
  if (accepted.length > 0) {
    const invited = event.operatorOrganized ? unique(attendees.flatMap(matchesOf)) : [];
    return { kind: "attributed", method: "accepted_contact", contactIds: [...new Set([...accepted, ...invited])] };
  }
  if (!event.operatorOrganized) return { kind: "unmatched" };

  const invited = unique(attendees.flatMap(matchesOf));
  if (invited.length > 0) return { kind: "attributed", method: "organized_contact", contactIds: invited };

  const keys = [...new Set(attendees.map((a) => accountKey(a.email)).filter((k): k is string => k !== null))];
  if (keys.length === 0) return { kind: "unmatched" };
  const since = new Date(firstSeenAt.getTime() - CONVERT_LIMITS.domainContactedDays * DAY_MS).toISOString();
  const until = firstSeenAt.toISOString();
  const { results: contacted } = await db
    .prepare(
      `SELECT c.id, c.account_key, c.last_contacted_at FROM contacts c
        WHERE c.account_key IN (SELECT value FROM json_each(?1))
          AND EXISTS (SELECT 1 FROM outreach_sends os WHERE os.contact_id = c.id AND os.sent_at >= ?2 AND os.sent_at <= ?3)
        ORDER BY c.id LIMIT 50`,
    )
    .bind(JSON.stringify(keys), since, until)
    .all<{ id: string; account_key: string; last_contacted_at: string | null }>();
  const candidates = [...new Set(contacted.map((c) => c.id))];
  if (candidates.length === 0) return { kind: "unmatched" };
  const perDomain = new Map<string, number>();
  for (const c of contacted) perDomain.set(c.account_key, (perDomain.get(c.account_key) ?? 0) + 1);
  if (candidates.length === 1 && [...perDomain.values()].every((count) => count === 1)) {
    return { kind: "attributed", method: "domain_contacted", contactIds: candidates };
  }
  return { kind: "ambiguous", candidates };
}
