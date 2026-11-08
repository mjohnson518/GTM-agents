// GTM-agents: composing a follow-up step: which templates serve each step, the fixture check that
// catches a broken template before any contact sees it, and one contact's draft.
//
// No model writes a follow-up. The copy is the operator's approved template for the step (kind and
// step as in config.sequences.cold), with the same variables as a cold first touch, plus
// {{original_subject}}, the first email's subject. The subject is always "Re: " and the first
// email's subject, whatever the template's subject line says, so the step threads in every client.
//
// Templates for a step: approved, served templates whose kind and step match the configured step,
// with a volume_weight above 0. Among those a contact may be offered (targeting, as in the cold
// batch), templates written for the first email's angle come first, then templates for every angle
// (angle none). Rotation is weighted by volume_weight, as in the cold batch.
//
// A step with no template, or with a template that fails the fixture check, holds every row due for
// that step: rendered for an invented contact through the deterministic gate, a template must pass
// with no finding at all. A finding there is the template's, not a contact's. Variables follow-ups
// have no source for (angle_opener, angle_age, proven_insight, company_context) fail it.
//
// Skip rather than guess: a contact whose values leave a variable empty is held (MISSING_VARIABLE),
// never greeted with a fallback.
import type { GtmConfig } from "../config/schema.ts";
import { eligibleTemplates, type Rotation } from "../outreach/allocate.ts";
import { claimSources, contactValues, targetFacts, type ComposeContext } from "../outreach/compose.ts";
import { checkOutboundQuality, heldResult, withFinding, type QualityResult } from "../quality/gate.ts";
import { renderTemplate, type TemplateValues } from "../templates/render.ts";
import type { TemplateKind } from "../templates/schema.ts";
import type { ServedTemplate } from "../templates/store.ts";
import { variablesIn } from "../templates/variables.ts";
import type { DueRow } from "./rows.ts";
import { followUpSubject, stripReplyPrefix } from "./threading.ts";

export type SequenceStepConfig = GtmConfig["sequences"]["cold"]["steps"][number];

export interface StepPlan {
  step: number;
  kind: TemplateKind;
  /** The templates rows due for this step are drafted from. */
  templates: ServedTemplate[];
  /** Why every row due for this step is held, or null when it can be drafted. */
  problem: string | null;
}

export type StepOutcome =
  | { status: "composed"; template: ServedTemplate; subject: string; body: string; result: QualityResult }
  | { status: "held"; template: ServedTemplate | null; result: QualityResult };

const USES_ATTRIBUTES = /\{\{\s*attributes\./;
const FIXTURE_DOMAIN = "northwind-example.example";

/** The invented contact every follow-up template is rendered for before any real contact. */
export const FIXTURE_CONTACT = Object.freeze({ email: `jordan@${FIXTURE_DOMAIN}`, firstName: "Jordan", lastName: "Example", title: "Engineering Manager", accountName: "Northwind Example", accountKey: FIXTURE_DOMAIN });
const FIXTURE_SUBJECT = "A short question";

function fixtureValues(template: ServedTemplate, ctx: ComposeContext): TemplateValues {
  const attributes: Record<string, string> = {};
  for (const name of variablesIn(`${template.subject}\n${template.body}`)) if (name.startsWith("attributes.")) attributes[name.slice("attributes.".length)] = "example";
  return {
    first_name: FIXTURE_CONTACT.firstName,
    last_name: FIXTURE_CONTACT.lastName,
    title: FIXTURE_CONTACT.title,
    account_name: FIXTURE_CONTACT.accountName,
    original_subject: FIXTURE_SUBJECT,
    persona_hint: "a calmer release week",
    booking_url: ctx.config.sending.bookingUrl,
    sender_name: ctx.config.agent.name,
    attributes,
  };
}

/** The template's problem when rendered for the invented contact, or null when it passes cleanly. Pure. */
export function fixtureProblem(template: ServedTemplate, ctx: ComposeContext): string | null {
  const values = fixtureValues(template, ctx);
  const rendered = renderTemplate(template, values);
  if (!rendered.ok) return `template ${template.id} uses ${rendered.missing.map((m) => `{{${m}}}`).join(", ")}, which a follow-up has no value for`;
  const result = checkOutboundQuality({
    kind: template.meta.kind,
    subject: followUpSubject(FIXTURE_SUBJECT),
    body: rendered.body,
    recipient: FIXTURE_CONTACT.email,
    contact: { email: FIXTURE_CONTACT.email, firstName: FIXTURE_CONTACT.firstName, accountName: FIXTURE_CONTACT.accountName, accountKey: FIXTURE_CONTACT.accountKey },
    links: ctx.links,
    claimSources: [...claimSources(template, values, ctx), FIXTURE_SUBJECT],
  });
  if (result.findings.length === 0) return null;
  return `template ${template.id} fails the gate for an invented contact: ${result.findings.map((f) => `${f.code} (${f.detail})`).join("; ")}`;
}

/** Each follow-up step's templates and, when it cannot be drafted, why. Pure. */
export function planSteps(served: readonly ServedTemplate[], steps: readonly SequenceStepConfig[], ctx: ComposeContext): Map<number, StepPlan> {
  const plans = new Map<number, StepPlan>();
  for (const s of steps) {
    if (s.step < 2) continue;
    const templates = served
      .filter((t) => t.meta.status === "approved" && t.meta.kind === s.kind && t.meta.step === s.step && t.meta.volume_weight > 0)
      .sort((a, b) => b.meta.volume_weight - a.meta.volume_weight || (a.id < b.id ? -1 : 1));
    let problem: string | null = templates.length === 0 ? `no approved ${s.kind} template for step ${s.step} is served` : null;
    for (const t of templates) {
      if (problem) break;
      problem = fixtureProblem(t, ctx);
    }
    plans.set(s.step, { step: s.step, kind: s.kind, templates, problem });
  }
  return plans;
}

/** The templates a contact may get for a step: targeting first, then the first email's angle, else angle none. */
export function stepCandidates(plan: StepPlan, row: DueRow, angle: string): ServedTemplate[] {
  const eligible = eligibleTemplates(plan.templates, targetFacts(row));
  const same = eligible.filter((t) => t.meta.angle === angle);
  return same.length > 0 ? same : eligible.filter((t) => t.meta.angle === "none");
}

/** Compose one contact's step and gate it. Pure apart from the rotation's count. `pinned` keeps a drafted step's template. */
export function composeStep(row: DueRow, plan: StepPlan, rotation: Rotation, ctx: ComposeContext, first: { subject: string; angle: string }, pinned: string | null = null): StepOutcome {
  // A step already drafted keeps its template while it may still be offered, so a redraft never flips it.
  const candidates = stepCandidates(plan, row, first.angle);
  const template = candidates.find((t) => t.id === pinned) ?? rotation.pick(candidates);
  if (!template) return { status: "held", template: null, result: heldResult("NO_TEMPLATE", `no step ${plan.step} template may be offered to this contact`) };
  const original = stripReplyPrefix(first.subject);
  const values: TemplateValues = { ...contactValues(row, ctx), original_subject: original };
  const rendered = renderTemplate(template, values);
  if (!rendered.ok) {
    return { status: "held", template, result: heldResult("MISSING_VARIABLE", `no value for ${rendered.missing.map((m) => `{{${m}}}`).join(", ")}; nothing is filled in by guessing`) };
  }
  const subject = followUpSubject(first.subject);
  let result = checkOutboundQuality({
    kind: template.meta.kind,
    subject,
    body: rendered.body,
    recipient: row.email,
    contact: { email: row.email, firstName: row.first_name, accountName: row.account_name, accountKey: row.account_key },
    links: ctx.links,
    claimSources: [...claimSources(template, values, ctx), original],
  });
  if (rendered.perDraftReview || USES_ATTRIBUTES.test(`${template.subject}\n${template.body}`)) {
    result = withFinding(result, "PER_DRAFT_REVIEW", "the template uses per-contact text from outside (site text or attributes), so a person reviews each draft");
  }
  return { status: "composed", template, subject, body: rendered.body, result };
}
