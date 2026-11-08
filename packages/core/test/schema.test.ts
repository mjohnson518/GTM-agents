// GTM-agents: the published brain JSON Schemas match the Zod definitions, and the baseline
// migration leaves the database in the expected shape.
/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { brainJsonSchemas } from "../src/brain/json-schema.ts";

const committed = import.meta.glob<{ default: unknown }>("../brain/schema/*.json", { eager: true });

describe("brain JSON Schemas", () => {
  it("are up to date with the Zod definitions (run `node scripts/generate-brain-schema.ts` after a schema change)", () => {
    const expected = brainJsonSchemas();
    const actual = Object.fromEntries(Object.entries(committed).map(([path, mod]) => [path.split("/").pop() as string, mod.default]));
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const [file, schema] of Object.entries(expected)) expect(actual[file], file).toEqual(schema);
  });
});

describe("baseline migration", () => {
  it("creates schema_meta and records the baseline", async () => {
    const row = await env.DB.prepare("SELECT value FROM schema_meta WHERE key = 'baseline'").first<{ value: string }>();
    expect(row?.value).toBe("1");
  });
});
