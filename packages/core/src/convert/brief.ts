// GTM-agents: the static briefs: a one-page prep brief on a contact, and a deal handoff brief.
//
// Both are built from the database alone, deterministically, with no model call: who the person is,
// the account and its fit, recent signals (type and date only), the last touches, how they replied
// (intents only), the deal, earlier meetings, the operator's own notes, and what recorded calls
// produced (notes/read.ts: the prospect's words, checked against the transcript, under their own
// heading so they never pose as the operator's notes). They go to the operator
// and nowhere else.
//
// What never goes in: inbound mail text or subjects, signal headlines or source pages (text from
// outside), calendar titles (never fetched), and other people at the account by name or address
// (they are counted). Call quotes are the one outside text shown, each found word for word in a
// transcript and labelled as the prospect's. Every value read from a record is passed through label(), which keeps plain
// characters and caps the length. Erasure deletes stored briefs about a person (data/erasure.ts).
import { CALL_NOTES_HEADING, CALL_NOTES_SQL, callNotesFromRows, type CallNotes } from "../notes/read.ts";
import { fitMessage, label, plural } from "../reports/format.ts";

export interface ContactBrief {
  contact: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string;
    job_title: string | null;
    warmth: string;
    account_key: string | null;
    last_contacted_at: string | null;
    total_touches: number;
    timezone: string | null;
  };
  account: { name: string | null; segment: string | null; tier: number | null; fit_score: number | null; prescore: number | null; team_size: string | null } | null;
  personFit: string | null;
  persona: string | null;
  firstTouchAt: string | null;
  signals: Array<{ type: string; at: string }>;
  touches: Array<{ channel: string; direction: string; subject: string | null; outcome: string | null; created_at: string }>;
  replies: Array<{ received_at: string; intent: string | null; classification: string | null }>;
  deal: { id: string; stage: string; value_cents: number | null; currency: string | null } | null;
  meetings: Array<{ starts_at: string; status: string; outcome: string | null }>;
  notes: Array<{ occurred_at: string | null; summary: string }>;
  /** What processed call recordings produced: the prospect's words, checked against the transcript. */
  calls: CallNotes[];
  /** The account's research facts (account_facts, found), each with its source; shown only with convert:brief_research_enabled. */
  research: ResearchFacts | null;
  colleagues: { total: number; warm: number };
}

/** A person's name as shown, or their address when no name is known. */
export function displayName(contact: Pick<ContactBrief["contact"], "first_name" | "last_name" | "email">): string {
  const name = [contact.first_name, contact.last_name].filter((p): p is string => typeof p === "string" && p.trim() !== "").join(" ");
  return name ? label(name, 60) : contact.email;
}

/** "2026-11-10 15:00 UTC". */
export function when(iso: string | null | undefined): string {
  if (!iso) return "(unknown time)";
  const at = Date.parse(iso);
  return Number.isFinite(at) ? `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC` : "(unknown time)";
}

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "never");

/** Load everything a brief shows about a contact, or null when the contact does not exist. Throws on a database error. */
export async function loadContactBrief(db: D1Database, contactId: string): Promise<ContactBrief | null> {
  const contact = await db
    .prepare("SELECT id, first_name, last_name, email, job_title, warmth, account_key, last_contacted_at, total_touches, timezone FROM contacts WHERE id = ?1")
    .bind(contactId)
    .first<ContactBrief["contact"]>();
  if (!contact) return null;
  const key = contact.account_key;
  const [account, fit, persona, first, signals, touches, replies, deal, meetings, notes, colleagues, calls, facts] = await db.batch([
    db
      .prepare(
        `SELECT a.name, COALESCE(af.segment, a.segment) AS segment, a.tier, af.fit_score, af.prescore, af.team_size
           FROM (SELECT ?1 AS k) q LEFT JOIN accounts a ON a.account_key = q.k LEFT JOIN account_fit af ON af.account_key = q.k
          WHERE a.account_key IS NOT NULL OR af.account_key IS NOT NULL`,
      )
      .bind(key ?? ""),
    db.prepare("SELECT decision FROM contact_fit WHERE contact_id = ?1").bind(contactId),
    db.prepare("SELECT persona FROM account_contacts WHERE contact_id = ?1 AND persona IS NOT NULL LIMIT 1").bind(contactId),
    db.prepare("SELECT MIN(sent_at) AS at FROM outreach_sends WHERE contact_id = ?1 AND send_path IN ('cold', 'sequence')").bind(contactId),
    db
      .prepare(
        `SELECT type, COALESCE(event_date, detected_at) AS at FROM signal_events
          WHERE (contact_id = ?1 OR (?2 <> '' AND account_key = ?2)) AND status <> 'dismissed'
          ORDER BY detected_at DESC LIMIT 5`,
      )
      .bind(contactId, key ?? ""),
    db.prepare("SELECT channel, direction, subject, outcome, created_at FROM outreach_log WHERE contact_id = ?1 ORDER BY created_at DESC LIMIT 6").bind(contactId),
    db.prepare("SELECT received_at, intent, classification FROM inbound_emails WHERE contact_id = ?1 ORDER BY received_at DESC LIMIT 5").bind(contactId),
    db
      .prepare(
        `SELECT id, stage, value_cents, currency FROM deals
          WHERE contact_id = ?1 OR (?2 <> '' AND account_key = ?2)
          ORDER BY (stage IN ('closed_won', 'closed_lost')), (contact_id = ?1) DESC, updated_at DESC LIMIT 1`,
      )
      .bind(contactId, key ?? ""),
    db.prepare("SELECT starts_at, status, outcome FROM calendar_meetings WHERE contact_id = ?1 ORDER BY starts_at DESC LIMIT 5").bind(contactId),
    // Only your own notes (the notes command writes calendar: rows). Call recordings are read below.
    db
      .prepare("SELECT occurred_at, summary FROM meetings WHERE contact_id = ?1 AND summary IS NOT NULL AND external_id LIKE 'calendar:%' ORDER BY COALESCE(occurred_at, created_at) DESC LIMIT 2")
      .bind(contactId),
    db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN warmth IN ('warming', 'engaged', 'hot', 'customer') THEN 1 ELSE 0 END) AS warm
           FROM contacts WHERE ?2 <> '' AND account_key = ?2 AND id <> ?1`,
      )
      .bind(contactId, key ?? ""),
    db.prepare(CALL_NOTES_SQL).bind(contactId),
    db.prepare(`SELECT ${RESEARCH_COLUMNS.join(", ")}, attributes, fetched_at, updated_at FROM account_facts WHERE account_key = ?1 AND status = 'found'`).bind(key ?? ""),
  ]);
  const one = <T>(r: D1Result<unknown> | undefined) => (r?.results?.[0] as T | undefined) ?? null;
  const all = <T>(r: D1Result<unknown> | undefined) => (r?.results ?? []) as T[];
  const counts = one<{ total: number | null; warm: number | null }>(colleagues);
  return {
    contact,
    account: one<NonNullable<ContactBrief["account"]>>(account),
    personFit: one<{ decision: string }>(fit)?.decision ?? null,
    persona: one<{ persona: string }>(persona)?.persona ?? null,
    firstTouchAt: one<{ at: string | null }>(first)?.at ?? null,
    signals: all<{ type: string; at: string }>(signals),
    touches: all<ContactBrief["touches"][number]>(touches),
    replies: all<ContactBrief["replies"][number]>(replies),
    deal: one<NonNullable<ContactBrief["deal"]>>(deal),
    meetings: all<ContactBrief["meetings"][number]>(meetings),
    notes: all<ContactBrief["notes"][number]>(notes),
    calls: callNotesFromRows(all<unknown>(calls)),
    research: researchFrom(one<Record<string, unknown>>(facts)),
    colleagues: { total: Number(counts?.total ?? 0), warm: Number(counts?.warm ?? 0) },
  };
}

const money = (cents: number | null, currency: string | null) => (cents === null ? "no value set" : `${(cents / 100).toFixed(0)} ${label(currency ?? "", 3) === "(blank)" ? "" : label(currency ?? "", 3)}`.trim());

/** The lines about the person, the account and the history: shared by both briefs. */
function contactLines(b: ContactBrief): string[] {
  const c = b.contact;
  const lines: string[] = [];
  lines.push(`Who: ${displayName(c)}${c.job_title ? `, ${label(c.job_title, 60)}` : ""} <${c.email}>${c.timezone ? ` (time zone ${label(c.timezone, 40)})` : ""}`);
  const a = b.account;
  if (c.account_key) {
    const parts = [a?.name ? label(a.name, 60) : label(c.account_key, 60)];
    if (a?.segment) parts.push(`segment ${label(a.segment, 40)}`);
    if (a?.team_size) parts.push(`team ${label(a.team_size, 20)}`);
    if (a?.tier !== null && a?.tier !== undefined) parts.push(`tier ${a.tier}`);
    lines.push(`Account: ${parts.join(", ")} (${label(c.account_key, 60)})`);
    const fit = [a?.fit_score !== null && a?.fit_score !== undefined ? `fit score ${Math.round(a.fit_score)}` : "not fit-scored", a?.prescore ? `prescore ${a.prescore}` : null].filter(Boolean).join(", ");
    lines.push(`Fit: ${fit}; person fit ${b.personFit ? label(b.personFit, 10) : "not decided"}${b.persona ? `; persona ${label(b.persona, 40)}` : ""}`);
    lines.push(`Others at the account: ${b.colleagues.total} in your contacts${b.colleagues.total > 0 ? `, ${b.colleagues.warm} of them warm` : ""}`);
  } else {
    lines.push(`Account: none (a personal address); person fit ${b.personFit ? label(b.personFit, 10) : "not decided"}`);
  }
  lines.push(`Relationship: warmth ${label(c.warmth, 12)}; first written to ${day(b.firstTouchAt)}; last ${day(c.last_contacted_at)}; ${plural(Number(c.total_touches ?? 0), "touch", "touches")}`);
  lines.push(
    b.signals.length > 0
      ? `Signals: ${b.signals.map((s) => `${label(s.type, 20)} (${day(s.at)})`).join(", ")}`
      : "Signals: none recorded",
  );
  if (b.touches.length > 0) {
    lines.push("Last touches:");
    for (const t of b.touches) {
      const subject = t.direction === "outbound" && t.subject ? ` "${label(t.subject, 60)}"` : "";
      lines.push(`  ${day(t.created_at)} ${label(t.channel, 10)} ${label(t.direction, 10)}${subject}${t.outcome ? ` (${label(t.outcome, 15)})` : ""}`);
    }
  } else {
    lines.push("Last touches: none recorded");
  }
  lines.push(
    b.replies.length > 0
      ? `Replies: ${b.replies.map((r) => `${day(r.received_at)} ${label(r.intent ?? (r.classification ? `${r.classification}, not triaged` : "not triaged"), 30)}`).join("; ")}`
      : "Replies: none",
  );
  lines.push(b.deal ? `Deal: ${label(b.deal.stage, 20)}, ${money(b.deal.value_cents, b.deal.currency)}` : "Deal: none");
  if (b.meetings.length > 0) lines.push(`Meetings: ${b.meetings.map((m) => `${day(m.starts_at)} ${label(m.outcome ?? m.status, 15)}`).join("; ")}`);
  for (const note of b.notes) lines.push(`Your notes (${day(note.occurred_at)}): ${label(note.summary.replace(/\s+/g, " "), 300)}`);
  for (const call of b.calls) {
    lines.push(`${CALL_NOTES_HEADING}, ${day(call.occurred_at)}:`);
    for (const q of call.pain_points) lines.push(`  Pain: "${label(q, 200)}"`);
    for (const q of call.objections) lines.push(`  Objection: "${label(q, 200)}"`);
    for (const s of call.next_steps) lines.push(`  Next step (${s.owner === "us" ? "ours" : "theirs"}): "${label(s.quote, 200)}"`);
  }
  return lines;
}

export interface BriefMeeting {
  code: string;
  starts_at: string;
  ends_at: string;
  attribution: string | null;
}

const ATTRIBUTION_TEXT: Record<string, string> = {
  accepted_contact: "they accepted the invite",
  organized_contact: "you invited them",
  domain_contacted: "the only person at their company written to in 60 days (a guess: check it)",
  operator_link: "you linked it",
};

/** Research facts older than this are not shown in a brief. */
export const BRIEF_RESEARCH_MAX_DAYS = 90;

const RESEARCH_COLUMNS = ["headcount_band", "employees_count", "hq_country", "founded_year", "sector", "industry", "company_type", "funding_stage", "raised_usd", "technologies"] as const;
const RESEARCH_LABELS: Readonly<Record<(typeof RESEARCH_COLUMNS)[number], string>> = {
  headcount_band: "Headcount",
  employees_count: "Employees",
  hq_country: "HQ",
  founded_year: "Founded",
  sector: "Sector",
  industry: "Industry",
  company_type: "Type",
  funding_stage: "Funding stage",
  raised_usd: "Raised (USD)",
  technologies: "Technologies",
};

export interface ResearchFacts {
  /** When the facts were fetched. */
  at: string;
  fields: Array<{ label: string; value: string; source: string }>;
}

/** The research row as brief lines: only fields with a value and an http(s) source. Pure. */
function researchFrom(row: Record<string, unknown> | null): ResearchFacts | null {
  if (!row) return null;
  const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
  const evidence = ((): Record<string, { url?: unknown }> => {
    try {
      return (JSON.parse(str(row.attributes) || "{}") as { evidence?: Record<string, { url?: unknown }> }).evidence ?? {};
    } catch {
      return {};
    }
  })();
  const hostOf = (url: unknown): string | null => {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) return null;
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  };
  const fields: ResearchFacts["fields"] = [];
  for (const column of RESEARCH_COLUMNS) {
    let value = str(row[column]);
    if (column === "technologies" && value) {
      try {
        const list = JSON.parse(value) as unknown;
        value = Array.isArray(list) ? list.filter((t): t is string => typeof t === "string").slice(0, 8).join(", ") : "";
      } catch {
        value = "";
      }
    }
    const host = hostOf(evidence[column]?.url);
    if (value && host) fields.push({ label: RESEARCH_LABELS[column], value, source: host });
  }
  const at = str(row.fetched_at) || str(row.updated_at);
  return fields.length > 0 && at ? { at, fields } : null;
}

/** The research lines, when shown and fresh. Pure. */
function researchLines(r: ResearchFacts | null, now: Date): string[] {
  if (!r) return [];
  const at = Date.parse(r.at);
  if (!Number.isFinite(at) || now.getTime() - at > BRIEF_RESEARCH_MAX_DAYS * 86_400_000) return [];
  return [`Public context (unverified, from account research ${day(r.at)}):`, ...r.fields.map((f) => `  ${f.label}: ${label(f.value, 80)} (source ${label(f.source, 60)})`)];
}

/** The one-page prep brief. Pure. With `research`, the account's fresh research facts are shown, marked unverified. */
export function renderPrepBrief(b: ContactBrief, meeting: BriefMeeting | null, now: Date, options: { research?: boolean } = {}): string {
  const lines = [`Prep brief: ${displayName(b.contact)}`];
  if (meeting) {
    const hours = Math.round((Date.parse(meeting.starts_at) - now.getTime()) / 3_600_000);
    const relative = hours > 0 ? ` (in ${hours < 48 ? plural(hours, "hour", "hours") : plural(Math.round(hours / 24), "day", "days")})` : hours < 0 ? " (already started)" : "";
    lines.push(`Meeting ${meeting.code}: ${when(meeting.starts_at)} to ${when(meeting.ends_at).slice(11)}${relative}; matched because ${ATTRIBUTION_TEXT[meeting.attribution ?? ""] ?? "it was linked"}`);
  }
  lines.push(...contactLines(b));
  if (options.research) lines.push(...researchLines(b.research, now));
  return fitMessage(lines);
}

export interface HandoffDeal {
  id: string;
  name: string;
  stage: string;
  value_cents: number | null;
  currency: string | null;
  created_at: string;
  contact_id: string | null;
}

/** The deal handoff brief. Pure. */
export function renderHandoffBrief(deal: HandoffDeal, history: Array<{ from_stage: string; to_stage: string; created_at: string }>, contact: ContactBrief | null): string {
  const lines = [
    `Deal handoff: ${label(deal.name, 60)} reached ${label(deal.stage, 20)}`,
    `Value: ${money(deal.value_cents, deal.currency)}; open since ${day(deal.created_at)}`,
    history.length > 0 ? `Stages: ${history.map((h) => `${label(h.to_stage, 20)} ${day(h.created_at)}`).join(", ")}` : "Stages: no history recorded",
  ];
  if (contact) {
    const held = contact.meetings.filter((m) => m.outcome === "held").length;
    const missed = contact.meetings.filter((m) => m.outcome === "no_show").length;
    lines.push(`Meetings with the contact: ${plural(held, "held", "held")}, ${plural(missed, "no-show", "no-shows")}`);
    lines.push(...contactLines(contact));
  } else {
    lines.push("Contact: none linked to this deal");
  }
  lines.push("", "Pricing, offers and discounts stay with you: nothing here is sent.");
  return fitMessage(lines);
}
