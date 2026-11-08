// GTM-agents: writes the brain's JSON Schemas to packages/core/brain/schema/ from the Zod
// definitions in packages/core/src/brain/schema.ts. Run after changing a brain schema:
//
//   node scripts/generate-brain-schema.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { brainJsonSchemas } from "../packages/core/src/brain/json-schema.ts";

const dir = resolve(import.meta.dirname, "../packages/core/brain/schema");
mkdirSync(dir, { recursive: true });
const schemas = brainJsonSchemas();
for (const [file, schema] of Object.entries(schemas)) {
  writeFileSync(resolve(dir, file), `${JSON.stringify(schema, null, 2)}\n`);
}
console.log(`generate-brain-schema: wrote ${Object.keys(schemas).length} schema(s) to packages/core/brain/schema/`);
