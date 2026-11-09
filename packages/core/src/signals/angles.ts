// GTM-agents: angles: the dated reason a first touch gives, built only from a real, unexpired signal.
//
// The angle variables a template may use:
//   {{angle_opener}}    a fixed opener per angle kind, written by the operator (or the defaults
//                       below), with only the account's name substituted for {account};
//   {{angle_age}}       when it happened, from the signal's event date: "this week", "last week" or
//                       "in March";
//   {{angle_headline}}  the signal's headline, only for source types the operator whitelists
//                       (quoteSources, empty by default), cleaned and capped. A template using it is
//                       reviewed by a person for every draft.
// Each kind comes from the signal's category: funding, hiring, launch, a job change, and leadership
// news (category news with evidence.category "leadership"). Other categories give no angle, and
// product usage never does (privacy).
//
// Rules, each failing toward "no angle", which holds a template that needs one:
//   - the signal has an event date, a source URL, an expiry after now, and is not dismissed;
//   - confidence is high within 14 days of the event and medium within 45; older gives none;
//   - only the contact's own signals count. A signal held at the account reaches a contact only
//     through routing or carry (at most 2 contacts per signal), never by being read for everyone;
//   - the account has a usable company name, or there is no opener;
//   - no provider text reaches the opener or the age: both are fixed text and a date.
import { inChunks, placeholders } from "../data/d1.ts";
import { isUsableAccountName } from "../quality/gate.ts";
import { cleanProviderText } from "../sourcing/text.ts";

export const ANGLE_KINDS = ["funding", "hiring", "launch", "new_leader", "job_change"] as const;
export type AngleKind = (typeof ANGLE_KINDS)[number];

export type AngleConfidence = "high" | "medium";

/** Defaults for the fixed openers. An operator replaces any of them through options.openers. */
export const DEFAULT_ANGLE_OPENERS: Readonly<Record<AngleKind, string>> = Object.freeze({
  funding: "Congratulations to the team at {account} on the new funding.",
  hiring: "I noticed {account} is growing the team.",
  launch: "I saw {account} just shipped something new.",
  new_leader: "I saw {account} recently brought on new leadership.",
  job_change: "Congratulations on the new role at {account}.",
});

export const ANGLE_HIGH_DAYS = 14;
export const ANGLE_MEDIUM_DAYS = 45;
export const HEADLINE_QUOTE_MAX = 120;
const DAY_MS = 86_400_000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export interface Angle {
  kind: AngleKind;
  confidence: AngleConfidence;
  opener: string;
  age: string;
  /** Only for whitelisted source types. */
  headline?: string;
  signalId: string;
  eventDate: string;
  sourceUrl: string;
}

export interface AngleOptions {
  openers?: Partial<Record<AngleKind, string>>;
  /** Source types whose headline may be quoted with {{angle_headline}}. Empty by default. */
  quoteSources?: readonly string[];
}

export interface AngleSubject {
  contactId: string;
  accountKey: string | null;
  accountName: string | null;
}

interface SignalRow {
  id: string;
  type: string;
  contact_id: string | null;
  account_key: string | null;
  headline: string;
  evidence: string | null;
  source_url: string | null;
  source: string | null;
  severity: number;
  event_date: string | null;
  expires_at: string | null;
}

/** The angle kind for a signal's category, or null when the category gives no angle. Pure. */
export function angleKind(type: string, evidence: string | null): AngleKind | null {
  if (type === "funding" || type === "hiring" || type === "launch" || type === "job_change") return type;
  if (type === "news") {
    try {
      const parsed: unknown = evidence ? JSON.parse(evidence) : null;
      if (parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).category === "leadership") return "new_leader";
    } catch {
      return null;
    }
  }
  return null;
}

/** Confidence from the event's age, or null when it is too old (or in the future). Pure. */
export function angleConfidence(eventDate: string, now: Date): AngleConfidence | null {
  const t = Date.parse(eventDate);
  if (!Number.isFinite(t)) return null;
  const days = (now.getTime() - t) / DAY_MS;
  if (days < -1) return null;
  if (days <= ANGLE_HIGH_DAYS) return "high";
  if (days <= ANGLE_MEDIUM_DAYS) return "medium";
  return null;
}

/** The dated age of an event: "this week", "last week" or "in March". Pure. */
export function angleAge(eventDate: string, now: Date): string | null {
  const t = Date.parse(eventDate);
  if (!Number.isFinite(t)) return null;
  const days = Math.floor((now.getTime() - t) / DAY_MS);
  if (days < 7) return "this week";
  if (days < 14) return "last week";
  return `in ${MONTHS[new Date(t).getUTCMonth()]}`;
}

/** An opener fit to use: fixed one-line text, no variables other than {account}, no link or markup. */
export function validOpener(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const v = text.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (v.length === 0 || v.length > 200 || /[<>@]|:\/\/|www\.|\{\{/.test(v)) return null;
  const vars = [...v.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
  return vars.every((name) => name === "account") ? v : null;
}

/** The opener for a kind and account name, or null when either is unusable. Pure. */
export function openerFor(kind: AngleKind, accountName: string, options: AngleOptions = {}): string | null {
  const template = validOpener(options.openers?.[kind] ?? DEFAULT_ANGLE_OPENERS[kind]);
  if (!template) return null;
  const name = accountName.normalize("NFKC").replace(/\s+/g, " ").trim();
  return template.replace(/\{account\}/g, name);
}

/** A headline fit to quote: cleaned, capped, no link or markup. Pure. */
export function quotableHeadline(headline: string): string | null {
  const cleaned = cleanProviderText(headline, HEADLINE_QUOTE_MAX * 2);
  if (!cleaned || /[<>{}@]|:\/\/|www\.|\[REDACTED\]/.test(cleaned)) return null;
  if (cleaned.length <= HEADLINE_QUOTE_MAX) return cleaned;
  const cut = cleaned.slice(0, HEADLINE_QUOTE_MAX);
  return cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : HEADLINE_QUOTE_MAX).trim();
}

/** The angle one signal gives a subject, or null. Pure. */
export function angleFromSignal(row: SignalRow, subject: AngleSubject, now: Date, options: AngleOptions = {}): Angle | null {
  if (row.type === "product_usage") return null;
  if (!row.event_date || !row.source_url || !row.expires_at) return null;
  const expires = Date.parse(row.expires_at);
  if (!Number.isFinite(expires) || expires <= now.getTime()) return null;
  const kind = angleKind(row.type, row.evidence);
  if (!kind) return null;
  const confidence = angleConfidence(row.event_date, now);
  const age = angleAge(row.event_date, now);
  if (!confidence || !age) return null;
  if (!isUsableAccountName(subject.accountName, subject.accountKey) || !subject.accountName) return null;
  const opener = openerFor(kind, subject.accountName, options);
  if (!opener) return null;
  const quote = row.source && (options.quoteSources ?? []).includes(row.source) ? quotableHeadline(row.headline) : null;
  return { kind, confidence, opener, age, ...(quote ? { headline: quote } : {}), signalId: row.id, eventDate: row.event_date, sourceUrl: row.source_url };
}

const rank = (a: Angle, severity: number) => (a.confidence === "high" ? 2 : 1) * 10 + severity;

/**
 * The best angle per subject, from the subject's own signals (routed or carried to it).
 * Subjects with none are absent. A read error gives no angles, so templates that need one are held.
 */
export async function loadAngles(db: D1Database, subjects: readonly AngleSubject[], now: Date, options: AngleOptions = {}): Promise<Map<string, Angle>> {
  const out = new Map<string, Angle>();
  if (subjects.length === 0) return out;
  const stamp = now.toISOString();
  const rows: SignalRow[] = [];
  const columns = "id, type, contact_id, account_key, headline, evidence, source_url, source, severity, event_date, expires_at";
  const live = "status IN ('new', 'acknowledged', 'actioned') AND expires_at IS NOT NULL AND expires_at > ?1 AND source_url IS NOT NULL AND event_date IS NOT NULL AND type <> 'product_usage'";
  try {
    const ids = [...new Set(subjects.map((s) => s.contactId))];
    for (const chunk of inChunks(ids, { reserved: 1 })) {
      const { results } = await db.prepare(`SELECT ${columns} FROM signal_events WHERE contact_id IN (${placeholders(chunk.length, 2)}) AND ${live}`).bind(stamp, ...chunk).all<SignalRow>();
      rows.push(...results);
    }
  } catch {
    return new Map();
  }
  for (const subject of subjects) {
    let best: { angle: Angle; score: number } | null = null;
    for (const row of rows) {
      const mine = row.contact_id === subject.contactId;
      if (!mine) continue;
      const angle = angleFromSignal(row, subject, now, options);
      if (!angle) continue;
      const score = rank(angle, row.severity);
      if (!best || score > best.score || (score === best.score && angle.eventDate > best.angle.eventDate)) best = { angle, score };
    }
    if (best) out.set(subject.contactId, best.angle);
  }
  return out;
}
