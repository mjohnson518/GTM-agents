// GTM-agents: the adapter manifest schema. Every adapter ships a manifest.json that core and
// `gtm doctor` validate against this schema. See docs/INTERFACES.md.
import { z } from "zod";
import { TAINT_LEVELS } from "./types.ts";

export const PORT_NAMES = [
  "DiscoverySource",
  "SignalSource",
  "PeopleProvider",
  "CompanyProvider",
  "ContactFinder",
  "EmailVerifier",
  "EmailProvider",
  "InboxProvider",
  "OperatorChannel",
  "CalendarProvider",
  "BillingProvider",
  "ModelGateway",
  "CrmSink",
  "CodeHost",
  "CodingSandbox",
] as const;

/** The lowest session taint at which a tool is refused. `never` is for read-only tools. */
export const GATE_LEVELS = ["never", "metadata", "structured", "full"] as const;
export type GateLevel = (typeof GATE_LEVELS)[number];

const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;

export const manifestToolSchema = z.strictObject({
  taint: z.enum(TAINT_LEVELS),
  /** Omitted means "metadata": refused as soon as anything untrusted has been read. */
  gate: z.enum(GATE_LEVELS).default("metadata"),
  egress: z.enum(["url", "query"]).optional(),
  humanOnly: z.boolean().default(false),
  rateCategory: z.string().regex(TOOL_NAME).optional(),
});

export const manifestSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "adapter names are kebab-case"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "use a semantic version such as 1.0.0"),
  ports: z.array(z.enum(PORT_NAMES)).min(1),
  capabilities: z.array(z.string().min(1)).default([]),
  requiredSecrets: z.array(z.string().regex(SECRET_NAME)).default([]),
  optionalSecrets: z.array(z.string().regex(SECRET_NAME)).default([]),
  flags: z.array(z.string().min(1)).default([]),
  tools: z.record(z.string().regex(TOOL_NAME), manifestToolSchema).default({}),
  costs: z
    .record(
      z.string().min(1),
      z.strictObject({
        usd: z.number().nonnegative().optional(),
        credits: z.number().nonnegative().optional(),
        per: z.string().min(1),
      }),
    )
    .default({}),
  limits: z
    .strictObject({
      batchSize: z.number().int().positive().optional(),
      perSecond: z.number().positive().optional(),
    })
    .default({}),
  webhook: z
    .strictObject({
      path: z.string().regex(/^\/api\/webhooks\/[a-z0-9/:_-]+$/, "webhook paths live under /api/webhooks/"),
      signature: z.string().min(1),
    })
    .optional(),
  contract: z.string().min(1),
});

export type AdapterManifest = z.output<typeof manifestSchema>;
export type ManifestTool = z.output<typeof manifestToolSchema>;
