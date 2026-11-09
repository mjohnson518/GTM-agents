// GTM-agents: the sections of the learnings document and their size limits.
export const LEARNING_SECTIONS = ["writing_rules", "objection_handling", "template_performance", "process", "general"] as const;
export type LearningSection = (typeof LEARNING_SECTIONS)[number];

export const SECTION_MAX_ENTRIES = 20;
export const SECTION_MAX_BYTES = 4096;

export function isLearningSection(value: unknown): value is LearningSection {
  return typeof value === "string" && (LEARNING_SECTIONS as readonly string[]).includes(value);
}

