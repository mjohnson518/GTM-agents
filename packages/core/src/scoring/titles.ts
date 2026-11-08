// GTM-agents: the one title classifier.
//
// Every place that asks "who is this person to us?" calls classifyTitle: person fit, the routing
// persona, the seat at the table and the seniority rank all come from one function, so they can
// never disagree. Everything company-specific comes from the brain: the personas component's title
// keywords, seniority levels and exclusions, and the icp component's `never` titles.
//
// The decision:
//   - drop: the title is on the never list, or it matches no persona and its seniority is not one
//     any persona lists;
//   - keep: the title contains one of a persona's title phrases (after normalization) and none of
//     that persona's exclusions;
//   - maybe: no phrase matches, but the seniority is one a persona lists; or the title is missing.
// A maybe is a no until a person or a cached review settles it: only keep is ever promoted.
import { normalizePhrase, matchNeverList, type NeverList } from "../sourcing/identity.ts";
import type { PersonaRole, PersonaRule, PersonaSeat, Seniority } from "../sourcing/brain.ts";

export type PersonFitDecision = "keep" | "maybe" | "drop";

export interface TitleClass {
  decision: PersonFitDecision;
  /** The matched persona id, when the title matched one. */
  persona: string | null;
  role: PersonaRole | null;
  seat: PersonaSeat;
  seniority: Seniority;
  /** 7 for c_level down to 0 for individual. */
  rank: number;
  reason: string;
}

/** Seniority ranks, highest first. */
export const SENIORITY_RANK: Readonly<Record<Seniority, number>> = Object.freeze({
  c_level: 7,
  vp: 6,
  head: 5,
  director: 4,
  manager: 3,
  lead: 2,
  senior: 1,
  individual: 0,
});

const SEAT_PRIORITY: Readonly<Record<PersonaSeat, number>> = Object.freeze({ decision_maker: 3, influencer: 2, user: 1, other: 0 });

// Spellings folded together before matching, so "Vice President, Engineering" matches the persona
// title "VP Engineering" and "Sr. Engineering Mgr" matches "Senior Engineering Manager".
const SYNONYMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/ (?:senior|executive|associate) vice president /g, " vp "],
  [/ vice president /g, " vp "],
  [/ (?:svp|evp|avp) /g, " vp "],
  [/ sr /g, " senior "],
  [/ jr /g, " junior "],
  [/ mgr /g, " manager "],
  [/ dir /g, " director "],
  [/ eng /g, " engineering "],
  [/ engr /g, " engineer "],
  [/ dev ?rel /g, " developer relations "],
  [/ q ?a /g, " qa "],
];
const STOPWORDS = / (?:of|the|and|for|at|in|to) /g;

/** A title reduced to comparable words: lowercase, punctuation removed, synonyms folded, stopwords dropped. */
export function titleKey(title: string): string {
  let text = normalizePhrase(title);
  for (const [pattern, replacement] of SYNONYMS) text = text.replace(pattern, replacement);
  // Stopwords are removed twice so adjacent ones ("head of the") both go.
  text = text.replace(STOPWORDS, " ").replace(STOPWORDS, " ");
  return text.replace(/\s+/g, " ").trim();
}

const SENIORITY_PATTERNS: ReadonlyArray<readonly [Seniority, RegExp]> = [
  // Checked in order: "vice president" before "president", "head of" before plain words.
  ["vp", /\b(?:vp|vice president|svp|evp|avp)\b/],
  ["c_level", /\b(?:chief [a-z]+ officer|chief|c[a-z]o|founder|co ?founder|president)\b/],
  ["head", /\bhead\b/],
  ["director", /\bdirector\b/],
  ["manager", /\b(?:manager|mgr)\b/],
  ["lead", /\b(?:lead|leader)\b/],
  ["senior", /\b(?:senior|sr|staff|principal|distinguished)\b/],
];

/** The seniority a title states. "individual" when it states none. */
export function seniorityOf(title: string): Seniority {
  const text = normalizePhrase(title);
  for (const [level, pattern] of SENIORITY_PATTERNS) {
    if (level === "c_level" && /\bchief of staff\b/.test(text)) continue;
    if (pattern.test(text)) return level;
  }
  return "individual";
}

function containsPhrase(haystack: string, phrase: string): boolean {
  const needle = titleKey(phrase);
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
}

export interface ClassifyOptions {
  never?: NeverList;
  /** Cached reviews of titles the rules leave undecided, keyed by titleKey. */
  reviews?: ReadonlyMap<string, "keep" | "drop">;
}

/** Classify a job title against the brain's personas. Pure. */
export function classifyTitle(title: string | null | undefined, personas: readonly PersonaRule[], options: ClassifyOptions = {}): TitleClass {
  const raw = typeof title === "string" ? title.trim() : "";
  if (raw.length === 0) {
    return { decision: "maybe", persona: null, role: null, seat: "other", seniority: "individual", rank: 0, reason: "no title" };
  }
  const seniority = seniorityOf(raw);
  const rank = SENIORITY_RANK[seniority];
  const base = { seniority, rank };
  if (options.never && matchNeverList(options.never, { title: raw })) {
    return { ...base, decision: "drop", persona: null, role: null, seat: "other", reason: "the title is on the never list" };
  }
  const key = titleKey(raw);
  let best: { persona: PersonaRule; length: number } | null = null;
  for (const persona of personas) {
    if (persona.excludeTitles.some((phrase) => containsPhrase(key, phrase))) continue;
    for (const phrase of persona.titles) {
      if (!containsPhrase(key, phrase)) continue;
      const length = titleKey(phrase).length;
      const better =
        best === null ||
        length > best.length ||
        (length === best.length && SEAT_PRIORITY[persona.seat] > SEAT_PRIORITY[best.persona.seat]);
      if (better) best = { persona, length };
    }
  }
  if (best) {
    return { ...base, decision: "keep", persona: best.persona.id, role: best.persona.role, seat: best.persona.seat, reason: `matches persona ${best.persona.id}` };
  }
  const review = personas.length > 0 ? options.reviews?.get(key) : undefined;
  if (review) {
    return { ...base, decision: review, persona: null, role: null, seat: "other", reason: `settled by a cached title review (${review})` };
  }
  const listed = personas.some((p) => p.seniority.includes(seniority));
  return listed
    ? { ...base, decision: "maybe", persona: null, role: null, seat: "other", reason: `no persona title matches; ${seniority} is a persona seniority` }
    : { ...base, decision: "drop", persona: null, role: null, seat: "other", reason: "no persona title or seniority matches" };
}

/**
 * Order people for "the most senior relevant person at the account": keep before maybe before
 * drop, then seat (decision maker first), then seniority rank.
 */
export function compareTitleClasses(a: TitleClass, b: TitleClass): number {
  const decision = { keep: 2, maybe: 1, drop: 0 } as const;
  return decision[b.decision] - decision[a.decision] || SEAT_PRIORITY[b.seat] - SEAT_PRIORITY[a.seat] || b.rank - a.rank;
}
