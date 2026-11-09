// GTM-agents: composing a cold first touch: variables, the template, and the deterministic gate.
//
// No model writes a cold first touch. The copy is the operator's template with variables
// substituted, and each variable comes from the deployment's own records:
//   - first_name, last_name, title: the contact. A first name that does not read as a name is left
//     empty, so the draft is held rather than greet a guess;
//   - account_name: the account, only when it is a usable company name;
//   - segment_line, team_size_line, persona_line: the operator's copy lines (copy_lines) for the
//     contact's segment, team size and persona. An empty line variable removes its whole line;
//   - persona_hint: the persona playbook's value frame for the contact's persona;
//   - booking_url, sender_name: the config;
//   - attributes.<key>: the contact's attributes, over the account's, when short single-line text
//     with no link; a template that uses them is reviewed by a person for every draft;
//   - angle_opener, angle_age, angle_headline: the contact's angle (signals/angles.ts), built only
//     from a real, unexpired, dated signal: a fixed opener with the account's name and the event's
//     dated age. The caller loads the angles (loadAngles) into ComposeContext.angles; a contact with
//     no angle has no value for them, so a template that uses them is held for that contact. The
//     headline is set only for whitelisted sources, and a template that uses it is reviewed per draft.
// proven_insight, original_subject and company_context have no source in the cold batch yet, so a
// template that uses them is held for every contact.
//
// Skip rather than guess: renderTemplate reports every variable with no value, and the draft is held
// (MISSING_VARIABLE) instead of falling back to "there" or "your company". A contact no template
// may target is held too (NO_TEMPLATE).
import type { GtmConfig } from "../config/schema.ts";
import { renderTemplate, type TemplateValues } from "../templates/render.ts";
import type { ServedTemplate } from "../templates/store.ts";
import { checkOutboundQuality, heldResult, isUsableAccountName, usableFirstName, withFinding, type LinkPolicy, type QualityResult } from "../quality/gate.ts";
import { eligibleTemplates, type Rotation, type TargetFacts } from "./allocate.ts";
import type { SelectionRow } from "./select.ts";
import type { Angle } from "../signals/angles.ts";

export interface CopyLines {
  segment: ReadonlyMap<string, string>;
  team_size: ReadonlyMap<string, string>;
  persona: ReadonlyMap<string, string>;
}

export interface ComposeContext {
  config: Pick<GtmConfig, "agent" | "company" | "sending">;
  copyLines: CopyLines;
  /** Persona id to the playbook's value frame. */
  playbooks: ReadonlyMap<string, string>;
  links: LinkPolicy;
  /** Approved claims beyond the template and copy lines: the brain's facts and message pillars. */
  approvedClaims: readonly string[];
  /** Contact id to its angle (signals/angles.ts loadAngles). Absent: no contact has an angle. */
  angles?: ReadonlyMap<string, Angle>;
}

export type ComposeOutcome =
  | { status: "composed"; template: ServedTemplate; subject: string; body: string; perDraftReview: boolean; result: QualityResult }
  | { status: "held"; template: ServedTemplate | null; result: QualityResult };

export const lineKey = (value: string | null | undefined): string | null => {
  const v = value?.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  return v ? v : null;
};

function parseJsonObject(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const clean = (value: string | null | undefined, max: number): string | undefined => {
  const v = value?.normalize("NFKC").replace(/\s+/g, " ").trim();
  return v && v.length <= max ? v : undefined;
};

export function targetFacts(row: Pick<SelectionRow, "segment" | "team_size" | "persona">): TargetFacts {
  return { segment: row.segment, teamSize: row.team_size, persona: row.persona };
}

/** The values a template may use for this contact. Missing values stay undefined. */
export function contactValues(row: SelectionRow, ctx: ComposeContext): TemplateValues {
  const lookup = (map: ReadonlyMap<string, string>, key: string | null | undefined) => {
    const k = lineKey(key);
    return k ? map.get(k) : undefined;
  };
  const angle = ctx.angles?.get(row.id);
  return {
    first_name: usableFirstName(row.first_name) ?? undefined,
    last_name: clean(row.last_name, 60),
    title: clean(row.job_title, 120),
    account_name: isUsableAccountName(row.account_name, row.account_key) ? clean(row.account_name, 80) : undefined,
    segment_line: lookup(ctx.copyLines.segment, row.segment),
    team_size_line: lookup(ctx.copyLines.team_size, row.team_size),
    persona_line: lookup(ctx.copyLines.persona, row.persona),
    persona_hint: lookup(ctx.playbooks, row.persona),
    angle_opener: angle?.opener,
    angle_age: angle?.age,
    angle_headline: angle?.headline,
    booking_url: ctx.config.sending.bookingUrl,
    sender_name: ctx.config.agent.name,
    attributes: copyableAttributes({ ...parseJsonObject(row.account_attributes), ...parseJsonObject(row.attributes) }),
  };
}

/**
 * The approved text a draft's figures and claims may come from: operator-written text (the template,
 * copy lines, playbooks, the config and the brain's facts and pillars) and the contact's own name,
 * title and company name, which may carry digits that are the name, not a claim. Attribute values are
 * never a source: providers write them, so a figure or offer they carry is held.
 */
export function claimSources(template: ServedTemplate, values: TemplateValues, ctx: ComposeContext): string[] {
  // The opener and age are fixed text and a date; the headline is provider text and never a source.
  const own = [values.first_name, values.last_name, values.title, values.account_name, values.angle_opener, values.angle_age].map((v) => (typeof v === "string" ? v : ""));
  const lines = [...ctx.copyLines.segment.values(), ...ctx.copyLines.team_size.values(), ...ctx.copyLines.persona.values(), ...ctx.playbooks.values()];
  return [template.subject, template.body, ...own, ...lines, ctx.config.company.name, ctx.config.agent.name, ...ctx.approvedClaims].filter((s) => s.length > 0);
}

/** Attribute values fit for copy: short single-line text or numbers, with no link or markup. Others are left out. */
export function copyableAttributes(record: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    const text = typeof value === "string" ? value.normalize("NFKC").trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
    if (!text || text.length > 120 || /[\r\n<>{}]|:\/\/|www\.|@/.test(text)) continue;
    out[key] = text;
  }
  return out;
}

const USES_ATTRIBUTES = /\{\{\s*attributes\./;
const USES_HEADLINE = /\{\{\s*angle_headline\s*\}\}/;

/** Compose one contact's first touch with the template the rotation picks, then gate it. */
export function composeColdDraft(row: SelectionRow, templates: readonly ServedTemplate[], rotation: Rotation, ctx: ComposeContext): ComposeOutcome {
  const template = rotation.pick(eligibleTemplates(templates, targetFacts(row)));
  if (!template) return { status: "held", template: null, result: heldResult("NO_TEMPLATE", "no approved template may be offered to this contact") };
  const values = contactValues(row, ctx);
  const rendered = renderTemplate(template, values);
  if (!rendered.ok) {
    return { status: "held", template, result: heldResult("MISSING_VARIABLE", `no value for ${rendered.missing.map((m) => `{{${m}}}`).join(", ")}; nothing is filled in by guessing`) };
  }
  let result = checkOutboundQuality({
    kind: "cold_intro",
    subject: rendered.subject,
    body: rendered.body,
    recipient: row.email,
    contact: { email: row.email, firstName: row.first_name, accountName: row.account_name, accountKey: row.account_key },
    links: ctx.links,
    claimSources: claimSources(template, values, ctx),
  });
  // Site text and provider-written attributes differ in every draft, so a sampled review cannot cover them.
  const perDraftReview = rendered.perDraftReview || USES_ATTRIBUTES.test(`${template.subject}\n${template.body}`) || USES_HEADLINE.test(`${template.subject}\n${template.body}`);
  if (perDraftReview) result = withFinding(result, "PER_DRAFT_REVIEW", "the template uses per-contact text from outside (site text, attributes or a quoted headline), so a person reviews each draft");
  return { status: "composed", template, subject: rendered.subject, body: rendered.body, perDraftReview, result };
}

/** Load the operator's active copy lines and persona playbooks. Bookkeeping reads: errors give none. */
export async function loadCopy(db: D1Database): Promise<{ copyLines: CopyLines; playbooks: Map<string, string> }> {
  const copyLines = { segment: new Map<string, string>(), team_size: new Map<string, string>(), persona: new Map<string, string>() };
  const playbooks = new Map<string, string>();
  try {
    const { results } = await db.prepare("SELECT kind, key, text FROM copy_lines WHERE is_active = 1 LIMIT 500").all<{ kind: keyof CopyLines; key: string; text: string }>();
    for (const r of results) {
      const key = lineKey(r.key);
      const text = clean(r.text, 300);
      if (key && text && Object.hasOwn(copyLines, r.kind)) copyLines[r.kind].set(key, text);
    }
  } catch {
    // No copy lines: line variables are empty and their lines are removed.
  }
  try {
    const { results } = await db.prepare("SELECT persona, value_frame FROM persona_playbooks WHERE value_frame IS NOT NULL LIMIT 200").all<{ persona: string; value_frame: string }>();
    for (const r of results) {
      const key = lineKey(r.persona);
      const text = clean(r.value_frame, 300);
      if (key && text) playbooks.set(key, text);
    }
  } catch {
    // No playbooks: a template that uses {{persona_hint}} is held.
  }
  return { copyLines, playbooks };
}
