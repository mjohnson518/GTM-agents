// GTM-agents: tests for composing cold first touches: serving templates, weighted rotation, targeting,
// variables, and holding rather than guessing. Every person and account is invented.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { defineConfig } from "../src/config/index.ts";
import { loadTemplates, serveTemplateFiles, templateFileKey, type ServedTemplate } from "../src/templates/index.ts";
import { batchTemplates, composeColdDraft, contactValues, createRotation, eligibleTemplates, type ComposeContext, type SelectionRow } from "../src/outreach/index.ts";
import { templateFile, uploadTemplates } from "../src/outreach/testing.ts";
import { acmeConfig } from "./fixtures.ts";

const config = defineConfig(acmeConfig);

const ctx = (patch: Partial<ComposeContext> = {}): ComposeContext => ({
  config,
  copyLines: { segment: new Map(), team_size: new Map(), persona: new Map([["platform-champion", "You probably see this first in the CI dashboard."]]) },
  playbooks: new Map(),
  links: { domains: ["acme.example"], exactUrls: ["https://acme.example/book"] },
  approvedClaims: [],
  ...patch,
});

const contact = (patch: Partial<SelectionRow> = {}): SelectionRow => ({
  id: "ct_1",
  email: "jane@globex.example",
  first_name: "Jane",
  last_name: "Doe",
  job_title: "Staff Engineer",
  account_key: "globex.example",
  account_name: "Globex",
  attributes: "{}",
  account_attributes: "{}",
  segment: "saas",
  team_size: "50-200",
  persona: "platform-champion",
  email_confidence: "high",
  verification_status: "deliverable",
  ...patch,
});

async function served(...files: ReturnType<typeof templateFile>[]): Promise<ServedTemplate[]> {
  return (await serveTemplateFiles(files, { companyDomain: "acme.example" })).templates;
}

describe("serving templates", () => {
  it("serves only locked, approved, valid templates from KV", async () => {
    const good = templateFile("cold-intro");
    const draft = templateFile("cold-draft", { status: "draft" });
    const badLink = templateFile("cold-link", { body: "Hi {{first_name}},\n\nSee https://elsewhere.example/x for the details on flaky builds at {{account_name}} and more words here to fill.\n\nDoes your team track it?\n\n{{sender_name}}" });
    await uploadTemplates(env.KV, [good, draft, badLink]);
    let load = await loadTemplates(env.KV, { companyDomain: "acme.example" });
    expect(load.templates.map((t) => t.id)).toEqual(["cold-intro"]);
    expect(load.skipped.map((s) => s.file).sort()).toEqual(["cold-draft.md", "cold-link.md"]);

    // Edited after locking: out of use until it is locked again.
    await env.KV.put(templateFileKey("cold-intro"), good.content.replace("waits", "waits a while"));
    load = await loadTemplates(env.KV, { companyDomain: "acme.example" });
    expect(load.templates).toHaveLength(0);
    expect(load.skipped.find((s) => s.file === "cold-intro.md")?.reason).toMatch(/changed after it was locked/);
  });

  it("serves nothing without a lock or a KV binding", async () => {
    expect((await loadTemplates(undefined)).error).toMatch(/no KV binding/);
    await env.KV.delete("templates:lock");
    expect((await loadTemplates(env.KV)).error).toMatch(/no template lock/);
  });
});

describe("allocation", () => {
  it("splits a batch by volume_weight, deterministically", async () => {
    const templates = batchTemplates(await served(templateFile("cold-a", { weight: 1 }), templateFile("cold-b", { weight: 0.5 }), templateFile("cold-off", { weight: 0 })));
    expect(templates.map((t) => t.id)).toEqual(["cold-a", "cold-b"]);
    const rotation = createRotation();
    const picks = Array.from({ length: 9 }, () => rotation.pick(templates)?.id);
    expect(picks.filter((p) => p === "cold-a")).toHaveLength(6);
    expect(picks.filter((p) => p === "cold-b")).toHaveLength(3);
  });

  it("offers a targeted template only to contacts who match every list it declares", async () => {
    const templates = await served(templateFile("cold-general"), templateFile("cold-champions", { personas: "platform-champion", segments: "saas" }));
    expect(eligibleTemplates(templates, { segment: "SaaS", teamSize: null, persona: "platform-champion" }).map((t) => t.id)).toEqual(["cold-general", "cold-champions"]);
    expect(eligibleTemplates(templates, { segment: "fintech", teamSize: null, persona: "platform-champion" }).map((t) => t.id)).toEqual(["cold-general"]);
    expect(eligibleTemplates(templates, { segment: null, teamSize: null, persona: null }).map((t) => t.id)).toEqual(["cold-general"]);
  });
});

describe("composeColdDraft", () => {
  it("fills variables from the contact, the account, copy lines and the config", async () => {
    const templates = await served(templateFile("cold-intro"));
    const outcome = composeColdDraft(contact(), templates, createRotation(), ctx());
    expect(outcome.status).toBe("composed");
    if (outcome.status !== "composed") return;
    expect(outcome.subject).toBe("Flaky builds at Globex");
    expect(outcome.body.startsWith("Hi Jane,")).toBe(true);
    expect(outcome.body).toContain("You probably see this first in the CI dashboard.");
    expect(outcome.body.endsWith(config.agent.name)).toBe(true);
    expect(outcome.result.verdict).toBe("pass");
  });

  it("removes an empty copy line instead of leaving a gap", async () => {
    const templates = await served(templateFile("cold-intro"));
    const outcome = composeColdDraft(contact({ persona: null }), templates, createRotation(), ctx());
    expect(outcome.status === "composed" && outcome.body).not.toContain("\n\n\n");
  });

  it("holds when a variable has no value, and never falls back to a guess", async () => {
    const templates = await served(templateFile("cold-intro"));
    for (const patch of [{ first_name: null }, { first_name: "j" }, { account_name: "Inc" }]) {
      const outcome = composeColdDraft(contact(patch), templates, createRotation(), ctx());
      expect(outcome.status).toBe("held");
      expect(outcome.result.findings.map((f) => f.code)).toEqual(["MISSING_VARIABLE"]);
    }
    const values = contactValues(contact({ first_name: null, account_name: "Inc" }), ctx());
    expect(values.first_name).toBeUndefined();
    expect(values.account_name).toBeUndefined();
  });

  it("reads attributes from the contact over the account", async () => {
    const body = "Hi {{first_name}},\n\nHow is the {{attributes.ci_vendor}} migration going for the team at {{account_name}} this quarter, and is flaky-test time part of the reason for it?\n\n{{sender_name}}";
    const templates = await served(templateFile("cold-attr", { body }));
    const outcome = composeColdDraft(contact({ attributes: JSON.stringify({ ci_vendor: "Buildkite" }), account_attributes: JSON.stringify({ ci_vendor: "Jenkins" }) }), templates, createRotation(), ctx());
    expect(outcome.status === "composed" && outcome.body).toContain("Buildkite migration");
    // Provider-written attributes differ per draft, so a person reviews each one.
    expect(outcome.result.findings.map((f) => f.code)).toContain("PER_DRAFT_REVIEW");
  });

  it("never lets a provider-written attribute approve its own claim or carry a link", async () => {
    const body = "Hi {{first_name}},\n\nSaw the note about {{attributes.recent_news}} for the team at {{account_name}}; is flaky-test time part of what you are working through this quarter?\n\n{{sender_name}}";
    const templates = await served(templateFile("cold-news", { body }));
    const offer = composeColdDraft(contact({ attributes: JSON.stringify({ recent_news: "a 50% discount on a free trial" }) }), templates, createRotation(), ctx());
    expect(offer.result.findings.map((f) => f.code)).toContain("UNAPPROVED_CLAIM");
    const linked = composeColdDraft(contact({ attributes: JSON.stringify({ recent_news: "see https://attacker.example" }) }), templates, createRotation(), ctx());
    expect(linked.result.findings.map((f) => f.code)).toEqual(["MISSING_VARIABLE"]);
  });

  it("holds a contact no template may be offered to", async () => {
    const templates = await served(templateFile("cold-champions", { personas: "economic-buyer" }));
    const outcome = composeColdDraft(contact(), templates, createRotation(), ctx());
    expect(outcome.result.findings.map((f) => f.code)).toEqual(["NO_TEMPLATE"]);
  });
});
