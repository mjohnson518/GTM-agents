// GTM-agents: JSON Schemas for the brain, generated from the Zod definitions so editors and other
// tools can validate brain files. `node scripts/generate-brain-schema.ts` writes them to
// packages/core/brain/schema/, and a test fails if the committed files fall out of date.
import { z } from "zod";
import { COMPONENT_IDS } from "./components.ts";
import { COMPONENT_SCHEMAS, frontmatterSchema } from "./schema.ts";

/** File name to JSON Schema document, for the frontmatter and each component's items. */
export function brainJsonSchemas(): Record<string, unknown> {
  const out: Record<string, unknown> = {
    "frontmatter.schema.json": {
      title: "GTM-agents brain file frontmatter",
      ...z.toJSONSchema(frontmatterSchema, { unrepresentable: "any" }),
    },
  };
  for (const id of COMPONENT_IDS) {
    out[`${id}.schema.json`] = {
      title: `GTM-agents brain item: ${id}`,
      ...z.toJSONSchema(COMPONENT_SCHEMAS[id], { unrepresentable: "any" }),
    };
  }
  return out;
}
