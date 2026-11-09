// GTM-agents: the deployment's configuration. Everything about the company being sold lives here,
// in brain/ and in templates/. Secrets do not: set them with `wrangler secret put`.
//
// This example describes Acme, a fictional developer-tools company. Replace every value.
import { defineConfig } from "@gtm-agents/core/config";

export default defineConfig({
  company: {
    name: "Acme",
    domain: "acme.example",
    url: "https://acme.example",
    product: {
      name: "Acme Quarantine",
      description: "Detects flaky tests in CI and quarantines them automatically, so engineers stop rerunning builds.",
    },
  },

  // The name the agent signs with.
  agent: { name: "Avery" },

  sending: {
    // Cold mail goes from an isolated subdomain, so the primary domain's reputation stays protected.
    from: { email: "avery@outreach.acme.example", name: "Avery at Acme" },
    domain: "outreach.acme.example",
    // Replies land in the real mailbox.
    replyTo: "avery@acme.example",
    supportAddress: "support@acme.example",
    // Appended to every cold email with the unsubscribe line.
    postalAddress: "Acme Inc., 100 Example Street, Springfield, EX 00000",
    windowDays: ["MON", "TUE", "WED", "THU"],
    windowHours: { start: 8, end: 15 },
    bookingUrl: "https://acme.example/book",
  },

  // Adapters to enable, by name, with non-secret options. See packages/adapters.
  adapters: {
    "operator-telegram": { options: {} },
    "llm-gateway": { options: {} },
    "data-exa": { options: {} },
    "data-hunter": { options: {} },
    "email-resend": { options: {} },
    "inbox-gmail": { options: {} },
    "email-cloudflare": { options: {} },
    "calendar-google": { options: {} },
    "data-jobboards": { options: {} },
    "billing-stripe": { options: {} },
  },

  // Model id per role. Core asks for roles; only this file names models.
  models: {
    roles: {
      strategist: "claude-opus-5-5",
      worker: "claude-sonnet-5-5",
      writer: "claude-sonnet-5-5",
      judge: "claude-sonnet-5-5",
      triage: "claude-haiku-5-5",
      classifier: "claude-haiku-5-5",
    },
    // US cents per million tokens. A model without a price is never called, because its cost could
    // not be recorded. Replace these with your provider's current prices.
    pricing: {
      "claude-opus-5-5": { inputCentsPerMTok: 400, outputCentsPerMTok: 2000 },
      "claude-sonnet-5-5": { inputCentsPerMTok: 200, outputCentsPerMTok: 1000 },
      "claude-haiku-5-5": { inputCentsPerMTok: 10, outputCentsPerMTok: 50 },
    },
  },

  // Starting autonomy levels. Every class starts at 1 (draft and ask) unless set here, and only a
  // person raises a level after that.
  autonomy: { defaults: {} },

  // Chat and user ids allowed to command the agent through the operator channel. Empty denies all.
  operator: { allowedChatIds: [], allowedUserIds: [] },
});
