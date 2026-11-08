// GTM-agents: the brain's schemas. One Zod schema per component is the single source of truth:
// validation, the runtime loader and the published JSON Schemas all derive from it.
import { z } from "zod";
import { COMPONENT_IDS, type ComponentId } from "./components.ts";

export const ITEM_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function sentenceCount(value: string): number {
  return (value.match(/[.!?](?=\s+[A-Z0-9"']|\s*$)/g) ?? []).length;
}

function isValidDate(value: string): boolean {
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

const text = z
  .string()
  .min(1)
  .max(300, "keep text to 300 characters")
  .refine((v) => sentenceCount(v) <= 2, "keep text to one or two sentences");
const name = z.string().min(1).max(80, "keep names to 80 characters");
const list = z.array(z.string().min(1).max(80, "keep list values to 80 characters")).min(1).max(30, "keep lists to 30 values");
const ids = z.array(z.string().regex(ITEM_ID, "item ids are kebab-case")).min(1).max(30);
const weight = z.number().min(0, "use a number from 0 to 1").max(1, "use a number from 0 to 1");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD").refine(isValidDate, "not a real date");
const httpsUrl = z.url({ protocol: /^https$/, error: "use an https:// URL" });

export const frontmatterSchema = z.strictObject({
  component: z.enum(COMPONENT_IDS),
  status: z.enum(["draft", "approved"]),
  version: z.number().int().min(1),
  updated: date,
  owner: name.optional(),
});
export type BrainFrontmatter = z.output<typeof frontmatterSchema>;

export const COMPONENT_SCHEMAS = {
  "market-profile": z.strictObject({
    kind: z.enum(["category", "segment", "trend", "buyer_behavior", "timing", "size"]),
    text,
  }),
  personas: z.strictObject({
    role: z.enum(["economic_buyer", "champion", "user", "influencer", "blocker"]),
    seat: z.enum(["decision_maker", "influencer", "user", "other"]),
    titles: list,
    seniority: z.array(z.enum(["c_level", "vp", "head", "director", "manager", "lead", "senior", "individual"])).min(1).optional(),
    exclude_titles: list.optional(),
    text,
  }),
  icp: z.strictObject({
    kind: z.enum(["who", "why_now", "must_have", "never", "trigger", "ignore", "unknown"]),
    text,
    domains: list.optional(),
    accounts: list.optional(),
    titles: list.optional(),
  }),
  "message-pillars": z.strictObject({
    text,
    proof: ids.optional(),
    personas: ids.optional(),
  }),
  objections: z.strictObject({
    objection: text,
    response: text,
    personas: ids.optional(),
  }),
  competitors: z.strictObject({
    name,
    positioning: text,
    differentiators: text,
    when_we_lose: text.optional(),
  }),
  influencers: z.strictObject({
    kind: z.enum(["publication", "newsletter", "podcast", "community", "person", "event"]),
    name,
    text,
  }),
  "keyword-portfolio": z.strictObject({
    query: text,
    intent: z.enum(["problem", "solution", "competitor", "trigger", "role"]),
    segment: name.optional(),
  }),
  voice: z.strictObject({
    kind: z.enum(["do", "dont", "phrase", "avoid", "signoff"]),
    text,
  }),
  signals: z.strictObject({
    type: z.enum(["job_change", "hiring", "funding", "launch", "post", "news", "filing", "product_usage", "custom"]),
    weight,
    max_age_days: z.number().int().min(1).max(365).optional(),
    text,
  }),
  stack: z.strictObject({
    technology: name,
    relation: z.enum(["integrates", "complements", "replaces", "competes", "requires"]),
    text,
  }),
  hiring: z.strictObject({
    titles: list,
    weight,
    text,
  }),
  facts: z.strictObject({
    text,
    value: name.optional(),
    url: httpsUrl.optional(),
    expires: date.optional(),
  }),
  commercial: z.strictObject({
    plan: name,
    price: z.number().nonnegative().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/, "use an ISO 4217 code such as USD").optional(),
    interval: z.enum(["month", "year", "one_time"]).optional(),
    text,
    url: httpsUrl.optional(),
  }),
} satisfies Record<ComponentId, z.ZodObject>;

/** Fields that hold references to items in another component. */
export const REFERENCES: Partial<Record<ComponentId, Record<string, ComponentId>>> = {
  "message-pillars": { proof: "facts", personas: "personas" },
  objections: { personas: "personas" },
};

/** The only fields where a URL may appear. */
export const URL_FIELDS: Partial<Record<ComponentId, readonly string[]>> = {
  facts: ["url"],
  commercial: ["url"],
};

/** The only component where prices may appear. */
export const PRICE_COMPONENT: ComponentId = "commercial";

type FieldKind = "list" | "number" | "string";

function fieldKind(schema: z.ZodType): FieldKind {
  let inner: z.ZodType = schema;
  while (inner instanceof z.ZodOptional) inner = inner.unwrap() as z.ZodType;
  if (inner instanceof z.ZodArray) return "list";
  if (inner instanceof z.ZodNumber) return "number";
  return "string";
}

/** Turn raw `key: value` strings into typed values, guided by the component's schema. */
export function coerceFields(component: ComponentId, raw: Record<string, string>): Record<string, unknown> {
  const shape = COMPONENT_SCHEMAS[component].shape as Record<string, z.ZodType>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = shape[key];
    if (!field) {
      out[key] = value;
      continue;
    }
    const kind = fieldKind(field);
    out[key] = kind === "list" ? value.split(",").map((v) => v.trim()).filter((v) => v !== "") : kind === "number" ? (value.trim() === "" ? Number.NaN : Number(value)) : value;
  }
  return out;
}
