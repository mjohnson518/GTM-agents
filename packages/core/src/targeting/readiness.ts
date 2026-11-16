// GTM-agents: the readiness of the brain discovery and fit scoring need, for the Product and ICP page
// (docs/TARGETING.md).
//
// Discovery needs approved personas (with none, found people are never enriched, qualified or
// promoted), approved keyword-portfolio queries (with none, search looks for nothing) and an approved
// ICP (its never items are the hard stops); fit scoring reads the ICP, and the product when it is
// approved. This reads, never writes: what each of those components serves, whether the sourcing
// brain loads whole, and whether the flags that use them are on. Every read fails closed: a brain that
// cannot be read reports nothing served and a degraded sourcing brain, and a flag that cannot be read
// reports off. It never throws.
import { isFlagOn } from "../jobs/loop.ts";
import type { FlagReader } from "../jobs/registry.ts";
import { parseBrainFile } from "../brain/parse.ts";
import { fileMeta, itemsOf, readServedBrain, type BrainKv } from "../learning/brain-edit.ts";
import { loadSourcingBrain } from "../sourcing/brain.ts";

export const READINESS_COMPONENTS = ["product", "icp", "personas", "keyword-portfolio"] as const;
export type ReadinessComponent = (typeof READINESS_COMPONENTS)[number];

export interface ComponentReadiness {
  /** True when the file is served: approved, and its bytes match the brain's lock. */
  served: boolean;
  /** True when the lock lists the component but its served bytes do not match. */
  unverified: boolean;
  version: number | null;
  updated: string | null;
  items: number;
}

export interface TargetingReadiness {
  components: Record<ReadinessComponent, ComponentReadiness>;
  /** What the discovery cycle reads (sourcing/brain.ts). Degraded means it does nothing. */
  sourcing: { degraded: boolean; personas: number; queries: number };
  flags: { discovery: boolean; fitScoring: boolean; research: boolean };
}

const NOTHING: ComponentReadiness = { served: false, unverified: false, version: null, updated: null, items: 0 };

async function flagOn(flags: FlagReader, key: string): Promise<boolean> {
  try {
    return isFlagOn(await flags.get(key));
  } catch {
    return false;
  }
}

/** Read what is served and which flags are on. Never throws. */
export async function targetingReadiness(kv: BrainKv, flags: FlagReader): Promise<TargetingReadiness> {
  const components = Object.fromEntries(READINESS_COMPONENTS.map((c) => [c, { ...NOTHING }])) as Record<ReadinessComponent, ComponentReadiness>;
  let readable = true;
  try {
    const brain = await readServedBrain(kv);
    for (const c of READINESS_COMPONENTS) {
      const content = brain.files.get(`${c}.md`);
      if (!content) {
        components[c] = { ...NOTHING, unverified: brain.lock?.files[`${c}.md`] !== undefined };
        continue;
      }
      const fm = parseBrainFile(`${c}.md`, content).frontmatter as { updated?: unknown } | undefined;
      components[c] = { served: true, unverified: false, version: fileMeta(content, c).version, updated: typeof fm?.updated === "string" ? fm.updated : null, items: itemsOf(content, c).length };
    }
  } catch {
    readable = false;
    for (const c of READINESS_COMPONENTS) components[c] = { ...NOTHING, unverified: true };
  }
  const sourcingBrain = readable ? await loadSourcingBrain(kv) : null;
  const sourcing = sourcingBrain && !sourcingBrain.degraded ? { degraded: false, personas: sourcingBrain.personas.length, queries: sourcingBrain.queries.length } : { degraded: true, personas: 0, queries: 0 };
  const [discovery, fitScoring, research] = await Promise.all([flagOn(flags, "discovery:enabled"), flagOn(flags, "fit:scoring_enabled"), flagOn(flags, "enrichment:research_enabled")]);
  return { components, sourcing, flags: { discovery, fitScoring, research } };
}
