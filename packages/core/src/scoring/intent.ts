// GTM-agents: the intent score: how ready a contact is for a first touch, from fit, title, signals
// and angle. Computed nightly; shadow until enforced.
//
// Components, out of 100:
//   - fit, up to 30: the account's model fit score times 3, or, unscored, min(18, prescore * 0.18);
//   - title, up to 20: the contact's seniority rank from the one title classifier (rank / 7 * 20);
//   - signal, up to 35: the best live signal (the contact's own, or its account's account-level
//     ones; product usage excluded): 35 * severity * freshness, where freshness is 1 within 14 days
//     of the event, 0.6 within 45 and 0.3 within 90, from the event date;
//   - angle: 15 when the best signal gives a high-confidence angle (within 14 days), 10 for medium
//     (within 45), 3 otherwise.
// Bands: 80 and up first_touch; 65 to 79 soft_touch; 45 to 64 nurture; below 45 none.
// The score is written to contacts.attributes.intent ({score, band, components, at}) for cold,
// never-contacted contacts, the never-scored and least recently scored first, so every contact is
// reached over successive runs. It changes nothing until intent_score:enforce is on, and then only
// through intentAllowsFirstTouch, which selection reads; an unreadable or missing score never
// blocks while enforcement is off and always blocks while it is on (fail closed).
import { angleKind } from "../signals/angles.ts";
import type { SourcingBrain } from "../sourcing/brain.ts";
import { classifyTitle, SENIORITY_RANK } from "./titles.ts";

export const INTENT_BANDS = ["first_touch", "soft_touch", "nurture", "none"] as const;
export type IntentBand = (typeof INTENT_BANDS)[number];

const DAY_MS = 86_400_000;
const MAX_RANK = Math.max(...Object.values(SENIORITY_RANK));

export interface IntentInput {
  fitScore: number | null;
  prescore: number | null;
  titleRank: number;
  /** The best live signal, or null. */
  signal: { severity: number; eventDate: string; givesAngle: boolean } | null;
  now: Date;
}

export interface IntentScore {
  score: number;
  band: IntentBand;
  components: { fit: number; title: number; signal: number; angle: number };
}

export function signalFreshness(eventDate: string, now: Date): number {
  const t = Date.parse(eventDate);
  if (!Number.isFinite(t)) return 0;
  const days = (now.getTime() - t) / DAY_MS;
  if (days < -1) return 0;
  if (days <= 14) return 1;
  if (days <= 45) return 0.6;
  if (days <= 90) return 0.3;
  return 0;
}

export function intentBand(score: number): IntentBand {
  if (score >= 80) return "first_touch";
  if (score >= 65) return "soft_touch";
  if (score >= 45) return "nurture";
  return "none";
}

/** The intent score. Pure. */
export function intentScore(input: IntentInput): IntentScore {
  const round = (n: number) => Math.round(n * 10) / 10;
  const fit = input.fitScore !== null && Number.isFinite(input.fitScore) ? Math.max(0, Math.min(30, input.fitScore * 3)) : Math.max(0, Math.min(18, (input.prescore ?? 0) * 0.18));
  const title = Math.max(0, Math.min(20, (input.titleRank / MAX_RANK) * 20));
  let signal = 0;
  let angle = 3;
  if (input.signal) {
    const freshness = signalFreshness(input.signal.eventDate, input.now);
    signal = 35 * Math.max(0, Math.min(1, input.signal.severity)) * freshness;
    const days = (input.now.getTime() - Date.parse(input.signal.eventDate)) / DAY_MS;
    if (input.signal.givesAngle && freshness > 0) angle = days <= 14 ? 15 : days <= 45 ? 10 : 3;
  }
  const score = round(fit + title + signal + angle);
  return { score, band: intentBand(score), components: { fit: round(fit), title: round(title), signal: round(signal), angle } };
}

/**
 * Whether selection may give this contact a first touch. With enforcement off, always true. With it
 * on, only a recorded first_touch band passes; a missing or unreadable score does not.
 */
export function intentAllowsFirstTouch(attributesJson: string | null | undefined, enforced: boolean): boolean {
  if (!enforced) return true;
  try {
    const parsed: unknown = attributesJson ? JSON.parse(attributesJson) : null;
    const intent = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).intent : null;
    return Boolean(intent && typeof intent === "object" && (intent as Record<string, unknown>).band === "first_touch");
  } catch {
    return false;
  }
}

interface ContactRow {
  id: string;
  account_key: string | null;
  job_title: string | null;
  fit_score: number | null;
  fit_status: string | null;
  prescore: number | null;
}

interface SignalRow {
  contact_id: string | null;
  account_key: string | null;
  type: string;
  evidence: string | null;
  severity: number;
  event_date: string;
}

/** Score up to `limit` cold, never-contacted contacts and record each score. Returns how many were written. */
export async function runIntentScoring(args: { db: D1Database; brain: SourcingBrain; now: Date; limit: number; signal?: AbortSignal }): Promise<number> {
  const { db, now } = args;
  const stamp = now.toISOString();
  const { results: contacts } = await db
    .prepare(
      `SELECT c.id, c.account_key, c.job_title, af.fit_score, af.status AS fit_status, af.prescore FROM contacts c
         LEFT JOIN account_fit af ON af.account_key = c.account_key
        WHERE c.warmth = 'cold' AND c.last_contacted_at IS NULL
        ORDER BY (json_extract(c.attributes, '$.intent.at') IS NOT NULL), json_extract(c.attributes, '$.intent.at'), c.id LIMIT ?1`,
    )
    .bind(args.limit)
    .all<ContactRow>();
  if (contacts.length === 0) return 0;
  const since = new Date(now.getTime() - 90 * DAY_MS).toISOString();
  const { results: signals } = await db
    .prepare(
      `SELECT contact_id, account_key, type, evidence, severity, event_date FROM signal_events
        WHERE status IN ('new', 'acknowledged', 'actioned') AND type <> 'product_usage' AND event_date IS NOT NULL AND event_date >= ?1
          AND source_url IS NOT NULL AND expires_at IS NOT NULL AND expires_at > ?2
        ORDER BY event_date DESC LIMIT 20000`,
    )
    .bind(since, stamp)
    .all<SignalRow>();
  const byContact = new Map<string, SignalRow[]>();
  const byAccount = new Map<string, SignalRow[]>();
  for (const s of signals) {
    if (s.contact_id) byContact.set(s.contact_id, [...(byContact.get(s.contact_id) ?? []), s]);
    else if (s.account_key) byAccount.set(s.account_key, [...(byAccount.get(s.account_key) ?? []), s]);
  }
  const writes: D1PreparedStatement[] = [];
  for (const c of contacts) {
    if (args.signal?.aborted) break;
    const mine = [...(byContact.get(c.id) ?? []), ...(c.account_key ? (byAccount.get(c.account_key) ?? []) : [])];
    let best: IntentInput["signal"] = null;
    let bestValue = -1;
    for (const s of mine) {
      const value = s.severity * signalFreshness(s.event_date, now);
      if (value > bestValue) {
        bestValue = value;
        best = { severity: s.severity, eventDate: s.event_date, givesAngle: angleKind(s.type, s.evidence) !== null };
      }
    }
    const rank = classifyTitle(c.job_title, args.brain.personas, { never: args.brain.never }).rank;
    const scored = intentScore({ fitScore: c.fit_status === "scored" ? c.fit_score : null, prescore: c.prescore, titleRank: rank, signal: best, now });
    writes.push(
      db.prepare("UPDATE contacts SET attributes = json_set(attributes, '$.intent', json(?2)) WHERE id = ?1").bind(c.id, JSON.stringify({ ...scored, at: stamp })),
    );
  }
  for (let i = 0; i < writes.length; i += 50) await db.batch(writes.slice(i, i + 50));
  return writes.length;
}
