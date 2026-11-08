// GTM-agents: a chat turn cannot spend past its ceiling. The turn ceiling (chat:turn_max_cents) is
// checked before every model call, not only before tools; an unreadable ceiling stops the turn; and
// a model with no price is never called, because its cost could not be recorded.
import { runHubTurn, sessionKeyFor, type HubAgentDeps } from "@gtm-agents/core/agents";
import { memoryKv, scriptedModel, toolStep } from "@gtm-agents/core/agents/testing";
import { defineConfig, type GtmConfigInput } from "@gtm-agents/core/config";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { uid } from "./helpers.ts";

const base: GtmConfigInput = {
  company: { name: "Acme", domain: "acme.example", url: "https://acme.example", product: { name: "Acme Quarantine", description: "Quarantines flaky tests." } },
  agent: { name: "Avery" },
  sending: {
    from: { email: "avery@outreach.acme.example" },
    replyTo: "avery@acme.example",
    supportAddress: "support@acme.example",
    postalAddress: "Acme Inc., 100 Example Street, Springfield, EX 00000",
    domain: "outreach.acme.example",
  },
  models: { roles: { strategist: "test-strategist" }, pricing: { "test-strategist": { inputCentsPerMTok: 400, outputCentsPerMTok: 2000 } } },
};

function run(model: HubAgentDeps["model"], options: { flags?: Record<string, string>; failingFlags?: boolean; config?: GtmConfigInput } = {}) {
  const kv = memoryKv(options.flags ?? {});
  if (options.failingFlags) kv.failing = true;
  const chatId = uid("chat");
  const deps: HubAgentDeps = { db: env.DB, kv: memoryKv(), flags: { get: (k) => kv.get(k) }, config: defineConfig(options.config ?? base), model, brain: () => Promise.resolve(null) };
  return runHubTurn(deps, { sessionKey: sessionKeyFor(chatId), chatId, text: "Keep researching" });
}

const forever = () => toolStep({ name: "contacts_search", input: { query: "acme" } });

describe("the chat turn ceiling", () => {
  it("stops the loop before the model call that would follow the ceiling", async () => {
    // Each scripted call costs 0.8 cents: after two calls the turn has spent 1.6 cents, which counts as 2,
    // so a 2 cent ceiling stops the loop before a third call.
    const model = scriptedModel(Array.from({ length: 10 }, forever));
    const turn = await run(model, { flags: { "chat:turn_max_cents": "2" } });
    expect(turn.stop).toBe("turn_ceiling");
    expect(model.requests).toHaveLength(2);
    const spent = await env.DB.prepare("SELECT COALESCE(SUM(cost_micro_cents), 0) AS total FROM cost_events WHERE turn_id = ?1").bind(turn.turnId).first<{ total: number }>();
    // A single call can take spend past a cap, but no call starts once it is reached.
    expect(Number(spent?.total)).toBeLessThan(3 * 10_000);
  });

  it("allows no model call at all when the ceiling is zero", async () => {
    const model = scriptedModel([forever()]);
    const turn = await run(model, { flags: { "chat:turn_max_cents": "0" } });
    expect(turn.stop).toBe("turn_ceiling");
    expect(model.requests).toHaveLength(0);
  });

  it("fails closed when the ceiling cannot be read", async () => {
    const model = scriptedModel([forever()]);
    const turn = await run(model, { failingFlags: true });
    expect(turn.stop).not.toBe("end");
    expect(model.requests).toHaveLength(0);
  });

  it("never calls a model that has no price", async () => {
    const model = scriptedModel([forever()]);
    const turn = await run(model, { config: { ...base, models: { roles: { strategist: "unpriced" } } } });
    expect(turn.stop).toBe("unpriced");
    expect(model.requests).toHaveLength(0);
  });
});
