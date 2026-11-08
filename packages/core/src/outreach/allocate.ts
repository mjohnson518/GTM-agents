// GTM-agents: template allocation for the cold batch.
//
// The batch allocates among at most MAX_BATCH_TEMPLATES general (untargeted) and as many targeted
// approved cold_intro templates, highest volume_weight first. A targeted template (segments,
// personas or team_sizes in its frontmatter) is offered only to a contact who matches every list it
// declares; a contact with an unknown segment, persona or team size is never offered a template
// that targets it. General templates are offered to everyone. A volume_weight of 0 is never offered.
//
// Allocation is weighted rotation: among the templates a contact may get, the one furthest below
// its weighted share of the batch so far is chosen, so a batch splits by volume_weight exactly and
// deterministically. Thompson sampling (choosing by measured reply rates) belongs to the
// experiments milestone; until then outreach:allocation_mode is read but every mode runs as this
// rotation.
import type { ServedTemplate } from "../templates/store.ts";

export const MAX_BATCH_TEMPLATES = 8;

/** What targeting matches against, from the contact and their account. */
export interface TargetFacts {
  segment: string | null;
  teamSize: string | null;
  persona: string | null;
}

const norm = (value: string) => value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");

export function isTargeted(template: Pick<ServedTemplate, "meta">): boolean {
  return Boolean(template.meta.segments ?? template.meta.personas ?? template.meta.team_sizes);
}

function listMatches(list: readonly string[] | undefined, value: string | null): boolean {
  if (!list) return true;
  if (!value) return false;
  const v = norm(value);
  return list.some((entry) => norm(entry) === v);
}

/** True when every targeting list the template declares matches the contact. */
export function templateMatches(template: Pick<ServedTemplate, "meta">, facts: TargetFacts): boolean {
  return listMatches(template.meta.segments, facts.segment) && listMatches(template.meta.team_sizes, facts.teamSize) && listMatches(template.meta.personas, facts.persona);
}

/** The approved cold_intro templates one batch allocates among: the best general and targeted ones. */
export function batchTemplates(templates: readonly ServedTemplate[]): ServedTemplate[] {
  const usable = templates
    .filter((t) => t.meta.status === "approved" && t.meta.kind === "cold_intro" && (t.meta.step ?? 1) === 1 && t.meta.volume_weight > 0)
    .sort((a, b) => b.meta.volume_weight - a.meta.volume_weight || (a.id < b.id ? -1 : 1));
  const general = usable.filter((t) => !isTargeted(t)).slice(0, MAX_BATCH_TEMPLATES);
  const targeted = usable.filter((t) => isTargeted(t)).slice(0, MAX_BATCH_TEMPLATES);
  return [...general, ...targeted];
}

/** The templates a contact may get: every general template, plus the targeted ones that match. */
export function eligibleTemplates(templates: readonly ServedTemplate[], facts: TargetFacts): ServedTemplate[] {
  return templates.filter((t) => !isTargeted(t) || templateMatches(t, facts));
}

export interface Rotation {
  /** Choose a template from those a contact may get, or null when there are none. */
  pick(eligible: readonly ServedTemplate[]): ServedTemplate | null;
  /** How many contacts each template was given. */
  readonly counts: ReadonlyMap<string, number>;
}

/** Weighted rotation across one batch. Deterministic: ties go to the earlier template. */
export function createRotation(): Rotation {
  const used = new Map<string, number>();
  return {
    counts: used,
    pick(eligible) {
      if (eligible.length === 0) return null;
      const total = eligible.reduce((sum, t) => sum + t.meta.volume_weight, 0);
      const assigned = eligible.reduce((sum, t) => sum + (used.get(t.id) ?? 0), 0);
      let best: ServedTemplate | null = null;
      let bestGap = Number.NEGATIVE_INFINITY;
      for (const t of eligible) {
        const gap = (t.meta.volume_weight / total) * (assigned + 1) - (used.get(t.id) ?? 0);
        if (gap > bestGap + 1e-9) {
          best = t;
          bestGap = gap;
        }
      }
      if (best) used.set(best.id, (used.get(best.id) ?? 0) + 1);
      return best;
    },
  };
}
