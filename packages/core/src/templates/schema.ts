// GTM-agents: template frontmatter. docs/BRAIN-SCHEMA.md is the reference.
import { z } from "zod";

export const TEMPLATE_KINDS = ["cold_intro", "follow_up", "breakup", "check_in", "proposal", "lifecycle"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const SEQUENCE_KINDS: readonly TemplateKind[] = ["cold_intro", "follow_up", "breakup"];

export const TEMPLATE_ANGLES = ["none", "job_change", "hiring", "funding", "leadership", "launch", "news", "custom"] as const;

/** Word bounds after substitution, by kind. */
export const WORD_BOUNDS: Readonly<Record<TemplateKind, { min: number; max: number }>> = {
  cold_intro: { min: 30, max: 180 },
  follow_up: { min: 12, max: 120 },
  breakup: { min: 12, max: 120 },
  check_in: { min: 12, max: 120 },
  proposal: { min: 12, max: 160 },
  lifecycle: { min: 12, max: 160 },
};

export const SUBJECT_MAX = 90;

const kebab = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "use kebab-case");
const list = z.array(z.string().min(1).max(80)).min(1).max(30);

export const templateFrontmatterSchema = z.strictObject({
  id: kebab,
  kind: z.enum(TEMPLATE_KINDS),
  status: z.enum(["draft", "approved"]),
  step: z.number().int().min(1).max(10).optional(),
  angle: z.enum(TEMPLATE_ANGLES).default("none"),
  subject: z.string().min(1).max(200),
  volume_weight: z.number().min(0).max(1).default(1),
  segments: list.optional(),
  personas: z.array(kebab).min(1).max(30).optional(),
  team_sizes: list.optional(),
  updated: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD")
    .refine((v) => {
      const d = new Date(`${v}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
    }, "not a real date")
    .optional(),
});
export type TemplateFrontmatter = z.output<typeof templateFrontmatterSchema>;

export const LIST_KEYS = new Set(["segments", "personas", "team_sizes"]);
export const NUMBER_KEYS = new Set(["step", "volume_weight"]);
