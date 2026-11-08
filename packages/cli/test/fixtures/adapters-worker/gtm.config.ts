// GTM-agents: a deployment that enables one valid, one invalid and one missing adapter, for
// `gtm doctor` tests. It has no wrangler.jsonc on purpose.
import { defineConfig } from "@gtm-agents/core/config";

export default defineConfig({
  company: { name: "Acme", domain: "acme.example", url: "https://acme.example", product: { name: "Acme Quarantine", description: "Example product." } },
  agent: { name: "Avery" },
  sending: {
    from: { email: "avery@outreach.acme.example" },
    domain: "outreach.acme.example",
    replyTo: "avery@acme.example",
    supportAddress: "support@acme.example",
    postalAddress: "Acme Inc., 100 Example Street, Springfield, EX 00000",
  },
  adapters: { "email-example": {}, "broken-example": {}, "missing-example": {} },
});
