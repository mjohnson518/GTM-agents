// GTM-agents: an invalid configuration for `gtm doctor` tests: cold mail from the primary domain.
import { defineConfig } from "@gtm-agents/core/config";

export default defineConfig({
  company: { name: "Acme", domain: "acme.example", url: "https://acme.example", product: { name: "Acme Quarantine", description: "Example product." } },
  agent: { name: "Avery" },
  sending: {
    from: { email: "avery@acme.example" },
    domain: "acme.example",
    replyTo: "avery@acme.example",
    supportAddress: "support@acme.example",
    postalAddress: "Acme Inc., 100 Example Street, Springfield, EX 00000",
  },
});
