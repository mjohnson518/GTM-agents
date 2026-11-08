// GTM-agents: tests for the adapter manifest schema.
import { describe, expect, it } from "vitest";
import { manifestSchema } from "../src/ports/manifest-schema.ts";

const example = {
  name: "email-resend",
  version: "1.0.0",
  ports: ["EmailProvider"],
  requiredSecrets: ["RESEND_API_KEY", "RESEND_WEBHOOK_SECRET"],
  optionalSecrets: [],
  flags: ["sending:enabled"],
  tools: {
    email_send_batch: { taint: "none", gate: "structured", humanOnly: false, rateCategory: "esp" },
    email_lookup_delivery: { taint: "metadata", gate: "never" },
  },
  costs: { send: { usd: 0.0004, per: "email" } },
  limits: { batchSize: 100, perSecond: 10 },
  webhook: { path: "/api/webhooks/email", signature: "svix" },
  contract: "./contract.test.ts",
};

describe("adapter manifest schema", () => {
  it("accepts the documented example", () => {
    expect(manifestSchema.safeParse(example).success).toBe(true);
  });

  it("defaults an undeclared gate to metadata, so an unclassified tool fails closed", () => {
    const parsed = manifestSchema.parse({ ...example, tools: { lookup: { taint: "full" } } });
    expect(parsed.tools.lookup).toEqual({ taint: "full", gate: "metadata", humanOnly: false });
  });

  it("rejects an unknown taint level, a tool without a taint, and unknown keys", () => {
    expect(manifestSchema.safeParse({ ...example, tools: { t: { taint: "partial" } } }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...example, tools: { t: { gate: "never" } } }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...example, surprise: true }).success).toBe(false);
  });

  it("keeps webhooks under /api/webhooks/", () => {
    expect(manifestSchema.safeParse({ ...example, webhook: { path: "/hooks/email", signature: "svix" } }).success).toBe(false);
  });
});
