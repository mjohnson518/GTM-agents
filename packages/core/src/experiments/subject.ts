// GTM-agents: subject tests: one template's body with competing subject lines.
//
// A subject test belongs to one template, so subject and template are factorial cells: the
// template's allocation decides who gets the template, and the test decides which subject line
// they see. At most one test runs per template. In each batch:
//   - a unit (account, as in assignment.ts) pinned to a variant keeps it;
//   - new units are split evenly among the variants until every variant has
//     SUBJECT_EVEN_SPLIT_SENDS matured sends, then by Thompson sampling with floors (each variant
//     at least ARM_FLOOR, scaled so the floors total at most MAX_FLOOR_TOTAL); shares become counts
//     by systematic sampling with a random offset, then a shuffle;
//   - the draft is composed and gated exactly as any other, with the variant's subject line in
//     place of the template's, and the variant is recorded against the draft
//     (subject_assignments), which is how its outcomes are found on the ledger.
// A winner is proposed only through the copy-change gate (cycle.ts) and applied only by a person:
// the test is then concluded with its winner, and the template goes out with the winning subject.
// A test whose sends reach ZERO_REPLY_TRIPWIRE_SENDS with no reply at all pages the operator: that
// is a broken measurement, not a result.
import { z } from "zod";
import { probabilityBest, posterior, shuffled, systematicCounts, type Uniform } from "../metrics/index.ts";
import { SUBJECT_MAX } from "../templates/schema.ts";
import { isAllowedVariable, variablesIn } from "../templates/variables.ts";
import { applyFloors, guardrailFloors } from "./thompson.ts";

export const SUBJECT_EVEN_SPLIT_SENDS = 50;
export const ZERO_REPLY_TRIPWIRE_SENDS = 100;
export const MAX_VARIANTS = 5;

export interface SubjectVariant {
  id: string;
  text: string;
}

export interface SubjectTest {
  id: string;
  name: string;
  templateId: string;
  status: "running" | "paused" | "concluded";
  winnerVariantId: string | null;
  variants: SubjectVariant[];
}

export const subjectTestInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    template: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    variants: z.array(z.string().trim().min(1).max(SUBJECT_MAX)).min(2).max(MAX_VARIANTS),
  })
  .strict();
export type SubjectTestInput = z.infer<typeof subjectTestInputSchema>;

/** Why a subject line cannot be a variant, or null. Variables must be ones a template may use. Pure. */
export function variantProblem(text: string): string | null {
  if (/[\r\n]/.test(text)) return "a subject line is one line";
  const bad = variablesIn(text).filter((v) => !isAllowedVariable(v) || v.endsWith("_line"));
  return bad.length > 0 ? `unknown or line variables: ${bad.map((v) => `{{${v}}}`).join(", ")}` : null;
}

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);

/** Create a running subject test. Refused when the template already has one running. */
export async function createSubjectTest(db: D1Database, input: SubjectTestInput, now: Date): Promise<SubjectTest | { error: string }> {
  for (const v of input.variants) {
    const problem = variantProblem(v);
    if (problem) return { error: `"${v.slice(0, 60)}": ${problem}` };
  }
  if (new Set(input.variants.map((v) => v.toLowerCase())).size !== input.variants.length) return { error: "two variants are the same subject line" };
  const running = await db.prepare("SELECT id FROM subject_tests WHERE template_id = ?1 AND status = 'running' LIMIT 1").bind(input.template).first<{ id: string }>();
  if (running) return { error: `template ${input.template} already has subject test ${running.id} running` };
  // A subject test on an experiment's template would change the copy the experiment is judged on.
  const experiment = await db
    .prepare("SELECT id FROM experiments WHERE status = 'running' AND (control_template_id = ?1 OR treatment_template_id = ?1) LIMIT 1")
    .bind(input.template)
    .first<{ id: string }>();
  if (experiment) return { error: `template ${input.template} is in running experiment ${experiment.id}` };
  const id = newId();
  const at = now.toISOString();
  await db.batch([
    db.prepare("INSERT INTO subject_tests (id, name, template_id, status, created_at) VALUES (?1, ?2, ?3, 'running', ?4)").bind(id, input.name, input.template, at),
    ...input.variants.map((text, i) => db.prepare("INSERT INTO subject_variants (id, test_id, subject_text, created_at) VALUES (?1, ?2, ?3, ?4)").bind(`${id}v${i + 1}`, id, text, at)),
  ]);
  return { id, name: input.name, templateId: input.template, status: "running", winnerVariantId: null, variants: input.variants.map((text, i) => ({ id: `${id}v${i + 1}`, text })) };
}

/** Running tests, and concluded ones with an approved winner, for these templates. Throws on a database error. */
export async function activeSubjectTests(db: D1Database): Promise<SubjectTest[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.name, t.template_id, t.status, t.winner_variant_id, v.id AS variant_id, v.subject_text
         FROM subject_tests t JOIN subject_variants v ON v.test_id = t.id
        WHERE t.template_id IS NOT NULL AND (t.status = 'running' OR (t.status = 'concluded' AND t.winner_variant_id IS NOT NULL))
        ORDER BY t.created_at ASC, t.id ASC, v.id ASC LIMIT 500`,
    )
    .all<{ id: string; name: string; template_id: string; status: SubjectTest["status"]; winner_variant_id: string | null; variant_id: string; subject_text: string }>();
  const tests = new Map<string, SubjectTest>();
  for (const r of results) {
    const t = tests.get(r.id) ?? { id: r.id, name: r.name, templateId: r.template_id, status: r.status, winnerVariantId: r.winner_variant_id, variants: [] };
    t.variants.push({ id: r.variant_id, text: r.subject_text });
    tests.set(r.id, t);
  }
  return [...tests.values()];
}

/** Stop a running test without a winner. */
export async function stopSubjectTest(db: D1Database, id: string, now: Date): Promise<boolean> {
  const r = await db.prepare("UPDATE subject_tests SET status = 'concluded', concluded_at = ?2 WHERE id = ?1 AND status = 'running'").bind(id, now.toISOString()).run();
  return (r.meta.changes ?? 0) > 0;
}

/**
 * Shares for a test's variants: even until every variant has SUBJECT_EVEN_SPLIT_SENDS matured
 * sends, then P(best) with floors. Pure given the generator.
 */
export function variantShares(variants: readonly SubjectVariant[], matured: ReadonlyMap<string, { sends: number; positives: number }>, rng: Uniform): { shares: number[]; phase: "even" | "thompson" } {
  const even = variants.map(() => 1 / Math.max(1, variants.length));
  if (variants.length < 2 || !variants.every((v) => (matured.get(v.id)?.sends ?? 0) >= SUBJECT_EVEN_SPLIT_SENDS)) return { shares: even, phase: "even" };
  const posteriors = variants.map((v) => posterior({ sends: matured.get(v.id)?.sends ?? 0, successes: matured.get(v.id)?.positives ?? 0 }));
  return { shares: applyFloors(probabilityBest(posteriors, rng), guardrailFloors(variants.map(() => ({ control: false })))), phase: "thompson" };
}

/** Deal variant ids to `n` new units: systematic counts, then a shuffle. Pure given the generator. */
export function dealVariants(variants: readonly SubjectVariant[], shares: readonly number[], n: number, rng: Uniform): string[] {
  const counts = systematicCounts(shares, n, rng);
  const labels: string[] = [];
  counts.forEach((c, i) => {
    for (let k = 0; k < c; k++) labels.push(variants[i]?.id ?? "");
  });
  return shuffled(labels, rng);
}
