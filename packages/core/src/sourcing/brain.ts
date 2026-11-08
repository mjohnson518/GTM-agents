// GTM-agents: the typed brain items that sourcing code reads.
//
// Prompts read the brain as a text slice (brain/load.ts). Deterministic sourcing code needs the
// items themselves: the keyword-portfolio queries to search with, the personas whose titles decide
// person fit, and the icp `never` items that are hard stops. This loader serves them under the same
// rules as the slice loader: a component counts only when its bytes match the lock, its
// frontmatter says approved and names the right component, and it parses cleanly. Anything else is
// left out.
//
// It never throws. On any error, and whenever the lock names one of these components but it cannot
// be served (an edited file not yet re-locked, a draft, a validation error), it returns an empty
// brain marked `degraded`. Serving the rest would silently drop hard stops (an icp never list that
// failed to load is an empty never list), so the discovery cycle does nothing on a degraded brain.
import { brainVersion, parseLock, sha256Hex } from "../brain/lock.ts";
import { BRAIN_LOCK_KEY, brainFileKey, type KVReader } from "../brain/load.ts";
import { parseBrainFile } from "../brain/parse.ts";
import { contentRuleIssues } from "../brain/validate.ts";
import type { ComponentId } from "../brain/components.ts";
import { EMPTY_NEVER_LIST, type NeverList } from "./identity.ts";

export const SENIORITY_LEVELS = ["c_level", "vp", "head", "director", "manager", "lead", "senior", "individual"] as const;
export type Seniority = (typeof SENIORITY_LEVELS)[number];

export type PersonaSeat = "decision_maker" | "influencer" | "user" | "other";
export type PersonaRole = "economic_buyer" | "champion" | "user" | "influencer" | "blocker";

export interface PersonaRule {
  id: string;
  role: PersonaRole;
  seat: PersonaSeat;
  titles: readonly string[];
  seniority: readonly Seniority[];
  excludeTitles: readonly string[];
}

export interface SourcingQuery {
  /** The keyword-portfolio item id. */
  id: string;
  query: string;
  intent: string;
  segment?: string;
}

export interface SourcingBrain {
  /** The lock version, or "unlocked". */
  version: string;
  personas: readonly PersonaRule[];
  never: NeverList;
  queries: readonly SourcingQuery[];
  /** True when the brain could not be read whole; consumers then do nothing. */
  degraded?: boolean;
}

export const EMPTY_SOURCING_BRAIN: SourcingBrain = Object.freeze({ version: "unlocked", personas: [], never: EMPTY_NEVER_LIST, queries: [] });

const DEGRADED: SourcingBrain = Object.freeze({ ...EMPTY_SOURCING_BRAIN, degraded: true });

const COMPONENTS = ["icp", "personas", "keyword-portfolio"] as const satisfies readonly ComponentId[];

type Items = Array<{ id: string; value: Record<string, unknown> }>;

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** Load the approved, locked icp, personas and keyword-portfolio items. Never throws. */
export async function loadSourcingBrain(kv: KVReader | undefined | null): Promise<SourcingBrain> {
  if (!kv) return EMPTY_SOURCING_BRAIN;
  try {
    const lock = parseLock(await kv.get(BRAIN_LOCK_KEY));
    if (!lock) return EMPTY_SOURCING_BRAIN;
    const served = new Map<ComponentId, Items>();
    for (const component of COMPONENTS) {
      const expected = lock.files[`${component}.md`];
      if (!expected) continue;
      const content = await kv.get(brainFileKey(component));
      if (content === null || (await sha256Hex(content)) !== expected) return DEGRADED;
      const parsed = parseBrainFile(`${component}.md`, content);
      if (parsed.frontmatter?.status !== "approved") return DEGRADED;
      if ([...parsed.issues, ...contentRuleIssues(parsed)].some((i) => i.severity === "error")) return DEGRADED;
      served.set(
        component,
        parsed.items.flatMap((item) => (item.value ? [{ id: item.id, value: item.value }] : [])),
      );
    }
    const personas: PersonaRule[] = (served.get("personas") ?? []).map(({ id, value }) => ({
      id,
      role: value.role as PersonaRole,
      seat: value.seat as PersonaSeat,
      titles: strings(value.titles),
      seniority: strings(value.seniority).filter((s): s is Seniority => (SENIORITY_LEVELS as readonly string[]).includes(s)),
      excludeTitles: strings(value.exclude_titles),
    }));
    const never = (served.get("icp") ?? []).filter(({ value }) => value.kind === "never");
    const queries: SourcingQuery[] = (served.get("keyword-portfolio") ?? []).flatMap(({ id, value }) =>
      typeof value.query === "string"
        ? [{ id, query: value.query, intent: typeof value.intent === "string" ? value.intent : "", ...(typeof value.segment === "string" ? { segment: value.segment } : {}) }]
        : [],
    );
    return {
      version: brainVersion(lock),
      personas,
      never: {
        domains: never.flatMap(({ value }) => strings(value.domains)),
        accounts: never.flatMap(({ value }) => strings(value.accounts)),
        titles: never.flatMap(({ value }) => strings(value.titles)),
      },
      queries,
    };
  } catch {
    return DEGRADED;
  }
}
