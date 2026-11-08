// GTM-agents: public entry point for templates: parsing, structural validation and rendering.
// Safe to import from Node (the CLI) and from the Worker.
export { SEQUENCE_KINDS, SUBJECT_MAX, TEMPLATE_ANGLES, TEMPLATE_KINDS, WORD_BOUNDS, templateFrontmatterSchema } from "./schema.ts";
export type { TemplateFrontmatter, TemplateKind } from "./schema.ts";
export { parseTemplate } from "./parse.ts";
export type { ParsedTemplate } from "./parse.ts";
export { validateTemplateFile, validateTemplates } from "./validate.ts";
export type { TemplateValidation, TemplateValidationOptions } from "./validate.ts";
export { renderTemplate } from "./render.ts";
export type { RenderResult, TemplateValues } from "./render.ts";
export { INLINE_VARIABLES, LINE_VARIABLES, countWords, isAllowedVariable, variablesIn } from "./variables.ts";
