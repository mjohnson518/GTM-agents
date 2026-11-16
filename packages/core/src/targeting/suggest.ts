// GTM-agents: suggested search queries and personas: the fixed rubric, the model's output schema,
// and the filters every suggestion passes before anyone sees it (docs/TARGETING.md).
//
// A suggestion reads only approved, locked brain text: the product and the ICP, plus the served
// personas and queries so it does not repeat them. No web page and nothing a person has not approved
// reaches the model. Its answer is still model output, so every item is checked here:
//   - an item that is not a valid keyword-portfolio or personas item is dropped;
//   - a link, an em or en dash, a price, or text that reads like an instruction is dropped;
//   - a query that repeats a served one, or whose query or segment names a never-list company or
//     domain (by its domain, or by the domain's name as a word: initech.example catches "Initech"),
//     is dropped;
//   - a persona whose description names a never-list company or domain is dropped; a persona title
//     already in a served persona, or on the never list, is removed, and a persona left with no title
//     is dropped.
// Each drop is recorded with its reason. Nothing here is served: the operator picks suggestions, and
// only a brain proposal a person approves adds them, after everything already served.
import { z } from "zod";
import { COMPONENT_SCHEMAS } from "../brain/schema.ts";
import { PRICE_PATTERN } from "../brain/validate.ts";
import { accountKey } from "../data/keys.ts";
import { hasLink } from "../learning/text.ts";
import type { BrainItemInput } from "../learning/brain-edit.ts";
import { detectInjection } from "../security/redact.ts";
import { matchNeverList, type NeverList } from "../sourcing/identity.ts";
import { cleanProviderText } from "../sourcing/text.ts";

export type SuggestComponent = "keyword-portfolio" | "personas";
export const SUGGEST_COMPONENTS: readonly SuggestComponent[] = ["keyword-portfolio", "personas"];

export const SUGGEST_QUERIES_MAX = 8;
export const SUGGEST_PERSONAS_MAX = 4;

const INTENTS = ["problem", "solution", "competitor", "trigger", "role"] as const;
const ROLES = ["economic_buyer", "champion", "user", "influencer", "blocker"] as const;
const SEATS = ["decision_maker", "influencer", "user", "other"] as const;
const SENIORITY = ["c_level", "vp", "head", "director", "manager", "lead", "senior", "individual"] as const;

export const SUGGEST_RUBRIC = [
  "You suggest search queries and buyer personas for a go-to-market system. The operator approved the product description and the ideal customer profile (ICP) below; read them as the operator's own words.",
  "Search queries find companies and people that match the ICP. Each query is one plain sentence describing who to look for or what they are going through, at most 300 characters, with an intent: problem (the pain the product removes), solution (looking for this kind of product), competitor (using or leaving an alternative, named only as a category), trigger (a dated change that makes now the time), or role (hiring or having a role the product serves).",
  "Personas are the people at a fitting company who buy, champion or use the product. Give each a role (economic_buyer, champion, user, influencer or blocker), a seat (decision_maker, influencer, user or other), two to six job titles as they appear on profiles, the seniority levels they hold (c_level, vp, head, director, manager, lead, senior or individual), titles to exclude when a near match is wrong, and one or two sentences on what they care about.",
  "Do not repeat a query or a title the brain already serves. Never name a company, a domain or a person. Never suggest anyone the ICP's never items exclude. No links, no prices, no em dashes or en dashes, no superlatives.",
  `Suggest at most ${SUGGEST_QUERIES_MAX} queries and ${SUGGEST_PERSONAS_MAX} personas. Fewer good ones are better than many weak ones. Reply with JSON only, matching the schema.`,
].join("\n");

export const SUGGEST_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["queries", "personas"],
  properties: {
    queries: {
      type: "array",
      maxItems: SUGGEST_QUERIES_MAX,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["query", "intent"],
        properties: { query: { type: "string", maxLength: 300 }, intent: { type: "string", enum: INTENTS }, segment: { type: "string", maxLength: 80 } },
      },
    },
    personas: {
      type: "array",
      maxItems: SUGGEST_PERSONAS_MAX,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "seat", "titles", "seniority", "exclude_titles", "text"],
        properties: {
          role: { type: "string", enum: ROLES },
          seat: { type: "string", enum: SEATS },
          titles: { type: "array", maxItems: 6, items: { type: "string", maxLength: 80 } },
          seniority: { type: "array", items: { type: "string", enum: SENIORITY } },
          exclude_titles: { type: "array", maxItems: 6, items: { type: "string", maxLength: 80 } },
          text: { type: "string", maxLength: 300 },
        },
      },
    },
  },
} as const;

const shortText = z.string().max(2000);
const rawQuery = z.object({ query: shortText, intent: z.string().max(40), segment: z.string().max(200).nullish() });
const rawPersona = z.object({
  role: z.string().max(40),
  seat: z.string().max(40),
  titles: z.array(z.string().max(200)).max(40),
  seniority: z.array(z.string().max(40)).max(20).nullish(),
  exclude_titles: z.array(z.string().max(200)).max(40).nullish(),
  text: shortText,
});
const rawOutput = z.object({ queries: z.array(rawQuery).max(40), personas: z.array(rawPersona).max(40) });
export type RawSuggestOutput = z.infer<typeof rawOutput>;

/** The model's answer, or null when it is not the JSON shape asked for. */
export function parseSuggestOutput(text: string): RawSuggestOutput | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = rawOutput.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A suggested brain item, its fields as the brain file holds them (lists comma-separated). */
export interface SuggestedItem {
  id: string;
  fields: Record<string, string>;
}

export interface DroppedSuggestion {
  component: SuggestComponent;
  reason: string;
  /** The start of the dropped text, cleaned. Omitted for an instruction. */
  preview?: string;
}

export interface FilteredSuggestions {
  "keyword-portfolio": SuggestedItem[];
  personas: SuggestedItem[];
  dropped: DroppedSuggestion[];
}

export interface ServedForSuggestions {
  queries: readonly BrainItemInput[];
  personas: readonly BrainItemInput[];
}

const INSTRUCTION = "it reads like an instruction to the model";

/** The first content problem in any of the texts, or null. */
function textProblem(texts: readonly string[]): string | null {
  for (const t of texts) if (detectInjection(t) > 0) return INSTRUCTION;
  for (const t of texts) if (hasLink(t)) return "it holds a link";
  for (const t of texts) if (/[\u2013\u2014]/.test(t)) return "it holds an em or en dash";
  for (const t of texts) if (PRICE_PATTERN.test(t)) return "it states a price";
  return null;
}

/** The fields the operator may edit on a picked suggestion: its main text. Every other field stays as suggested. */
export const SUGGEST_EDITABLE_FIELDS: Readonly<Record<SuggestComponent, readonly string[]>> = { "keyword-portfolio": ["query"], personas: ["titles", "text"] };

/**
 * Why picked items cannot be taken from these suggestions, or null. Each must be one of the
 * suggestions, at most once, with the same fields, and differ only in the editable ones.
 */
export function picksProblem(component: SuggestComponent, suggested: readonly SuggestedItem[], picks: readonly BrainItemInput[]): string | null {
  const byId = new Map(suggested.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const editable = SUGGEST_EDITABLE_FIELDS[component];
  for (const pick of picks) {
    const original = byId.get(pick.id);
    if (!original) return `${pick.id} is not one of the suggested ${component} items`;
    if (seen.has(pick.id)) return `${pick.id} is picked twice`;
    seen.add(pick.id);
    const keys = Object.keys(pick.fields).sort().join(",");
    if (keys !== Object.keys(original.fields).sort().join(",")) return `${pick.id} must keep the suggested fields`;
    for (const [key, value] of Object.entries(original.fields)) {
      if (!editable.includes(key) && pick.fields[key] !== value) return `only ${editable.join(" and ")} can be edited on ${pick.id}`;
    }
  }
  return null;
}

/** A query or a title reduced for comparison: lowercase words only. */
export function phraseKey(text: string): string {
  return text.toLowerCase().normalize("NFKC").replace(/[^a-z0-9]+/g, " ").trim();
}

const splitList = (value: string | undefined): string[] => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** True when the text names a never-list company, a never-list domain, or a never-list domain's name as a word. */
export function namesNeverEntry(never: NeverList, text: string): boolean {
  if (!text.trim()) return false;
  if (matchNeverList(never, { accountName: text })) return true;
  const words = ` ${phraseKey(text)} `;
  return never.domains.some((d) => {
    const key = accountKey(d);
    if (key === null) return false;
    if (text.toLowerCase().includes(key)) return true;
    const name = phraseKey(key.split(".")[0] ?? "");
    return name.length >= 4 && words.includes(` ${name} `);
  });
}

function nextId(base: string, taken: Set<string>): string {
  const stem = base.replace(/_/g, "-").replace(/[^a-z0-9-]/g, "") || "item";
  for (let n = 1; ; n++) {
    const id = `${stem}-${n}`;
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

/** Check every suggestion against the brain's rules, what is served, and the never list. */
export function filterSuggestions(output: RawSuggestOutput, served: ServedForSuggestions, never: NeverList): FilteredSuggestions {
  const out: FilteredSuggestions = { "keyword-portfolio": [], personas: [], dropped: [] };
  const taken = new Set([...served.queries, ...served.personas].map((i) => i.id));
  const drop = (component: SuggestComponent, reason: string, text: string) => {
    const preview = reason === INSTRUCTION ? null : cleanProviderText(text, 80);
    out.dropped.push({ component, reason, ...(preview ? { preview } : {}) });
  };

  const servedQueries = new Set(served.queries.map((q) => phraseKey(q.fields.query ?? "")));
  const keptQueries = new Set<string>();
  for (const raw of output.queries) {
    const query = cleanProviderText(raw.query, 2000) ?? "";
    const segment = raw.segment ? (cleanProviderText(raw.segment, 200) ?? "") : "";
    const problem = textProblem([raw.query, raw.segment ?? ""]);
    if (problem) {
      drop("keyword-portfolio", problem, raw.query);
      continue;
    }
    const fields: Record<string, string> = { query, intent: raw.intent.trim().toLowerCase(), ...(segment ? { segment } : {}) };
    if (!COMPONENT_SCHEMAS["keyword-portfolio"].safeParse(fields).success) {
      drop("keyword-portfolio", "it is not a keyword-portfolio item within the brain's limits", raw.query);
      continue;
    }
    if (namesNeverEntry(never, query) || namesNeverEntry(never, segment)) {
      drop("keyword-portfolio", "it names a company or domain on the never list", raw.query);
      continue;
    }
    const key = phraseKey(query);
    if (servedQueries.has(key)) {
      drop("keyword-portfolio", "it repeats a query the brain serves", raw.query);
      continue;
    }
    if (keptQueries.has(key)) {
      drop("keyword-portfolio", "it repeats another suggestion", raw.query);
      continue;
    }
    if (out["keyword-portfolio"].length >= SUGGEST_QUERIES_MAX) {
      drop("keyword-portfolio", `more than ${SUGGEST_QUERIES_MAX} queries were suggested`, raw.query);
      continue;
    }
    keptQueries.add(key);
    out["keyword-portfolio"].push({ id: nextId(fields.intent ?? "query", taken), fields });
  }

  const servedTitles = new Set(served.personas.flatMap((p) => splitList(p.fields.titles)).map(phraseKey));
  for (const raw of output.personas) {
    const titles = [...new Set(raw.titles.map((t) => cleanProviderText(t, 80) ?? "").filter(Boolean))];
    const exclude = [...new Set((raw.exclude_titles ?? []).map((t) => cleanProviderText(t, 80) ?? "").filter(Boolean))];
    const problem = textProblem([raw.text, ...raw.titles, ...(raw.exclude_titles ?? [])]);
    if (problem) {
      drop("personas", problem, raw.text);
      continue;
    }
    if (namesNeverEntry(never, raw.text)) {
      drop("personas", "it names a company or domain on the never list", raw.text);
      continue;
    }
    const onNever = titles.filter((t) => matchNeverList(never, { title: t }) !== null);
    const alreadyServed = titles.filter((t) => servedTitles.has(phraseKey(t)));
    const kept = titles.filter((t) => !onNever.includes(t) && !alreadyServed.includes(t));
    if (kept.length === 0) {
      const reason =
        titles.length > 0 && onNever.length === titles.length
          ? "every title is on the never list"
          : titles.length > 0 && alreadyServed.length === titles.length
            ? "every title is already in a served persona"
            : "no title is left once served and never-list titles are removed";
      drop("personas", reason, raw.text);
      continue;
    }
    const seniority = [...new Set((raw.seniority ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean))];
    const typed = {
      role: raw.role.trim().toLowerCase(),
      seat: raw.seat.trim().toLowerCase(),
      titles: kept,
      ...(seniority.length ? { seniority } : {}),
      ...(exclude.length ? { exclude_titles: exclude } : {}),
      text: cleanProviderText(raw.text, 2000) ?? "",
    };
    if (!COMPONENT_SCHEMAS.personas.safeParse(typed).success) {
      drop("personas", "it is not a personas item within the brain's limits", raw.text);
      continue;
    }
    if (out.personas.length >= SUGGEST_PERSONAS_MAX) {
      drop("personas", `more than ${SUGGEST_PERSONAS_MAX} personas were suggested`, raw.text);
      continue;
    }
    for (const t of kept) servedTitles.add(phraseKey(t));
    const fields: Record<string, string> = {
      role: typed.role,
      seat: typed.seat,
      titles: kept.join(", "),
      ...(seniority.length ? { seniority: seniority.join(", ") } : {}),
      ...(exclude.length ? { exclude_titles: exclude.join(", ") } : {}),
      text: typed.text,
    };
    out.personas.push({ id: nextId(typed.role, taken), fields });
  }
  return out;
}
