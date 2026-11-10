// GTM-agents: an example configuration with the optional ship loop turned on. It describes Acme, a
// fictional developer-tools company; replace every value. Only the parts marked "ship" differ from
// the Worker template's gtm.config.ts (apps/worker). Secrets do not go here: set them with
// `wrangler secret put` (docs/SHIP.md lists the ones the build needs).
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
  agent: { name: "Avery" },
  sending: {
    from: { email: "avery@outreach.acme.example", name: "Avery at Acme" },
    domain: "outreach.acme.example",
    replyTo: "avery@acme.example",
    supportAddress: "support@acme.example",
    postalAddress: "Acme Inc., 100 Example Street, Springfield, EX 00000",
    bookingUrl: "https://acme.example/book",
  },

  adapters: {
    "operator-telegram": { options: {} },
    "llm-gateway": { options: {} },
    "email-resend": { options: {} },
    // ship: the repositories the loop may touch. The token can reach only these. Set
    // shipBranchCiIsolated to true only once workflow runs for ship/ branches get no secret and no
    // write token (docs/SHIP.md, CI and the ship branch); until then no branch is pushed.
    "code-github": { options: { repos: ["acme-example/quarantine"], author: { name: "Acme ship loop", email: "ship@acme.example" }, shipBranchCiIsolated: false } },
    // ship: the coding agent's sandbox. "claude-code" is the default profile; "opencode" is the
    // other. Each profile has its own image in wrangler.jsonc.
    "sandbox-cloudflare": { options: { profile: "claude-code", registryHosts: ["registry.npmjs.org"], instance: "standard-2" } },
  },

  models: {
    roles: {
      strategist: "claude-opus-5-5",
      triage: "claude-haiku-5-5",
      // ship: the model the coding agent runs on. Whatever model the agent in the container asks
      // for, the Worker rewrites the request to this one.
      coder: "claude-opus-5-5",
      embedding: "@cf/baai/bge-m3",
    },
    // US cents per million tokens. A model without a price is never called, so price the coder
    // model: the sandbox refuses every model call until it is. Replace these with your provider's
    // current prices.
    pricing: {
      "claude-opus-5-5": { inputCentsPerMTok: 400, outputCentsPerMTok: 2000, cacheReadMultiplier: 0.05 },
      "claude-haiku-5-5": { inputCentsPerMTok: 10, outputCentsPerMTok: 50 },
    },
  },

  // ship: the module switch. With it off, nothing in the ship loop runs, whatever the flags say.
  modules: { ship: { enabled: true } },

  operator: { allowedChatIds: [], allowedUserIds: [] },
});
