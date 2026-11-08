// GTM-agents: synthetic fixtures for the core tests. Acme, its people and its addresses are invented.
import type { GtmConfigInput } from "../src/config/schema.ts";

export const acmeConfig: GtmConfigInput = {
  company: {
    name: "Acme",
    domain: "acme.example",
    url: "https://acme.example",
    product: { name: "Acme Quarantine", description: "Detects flaky tests in CI and quarantines them automatically." },
  },
  agent: { name: "Avery" },
  sending: {
    from: { email: "avery@outreach.acme.example", name: "Avery at Acme" },
    replyTo: "avery@acme.example",
    supportAddress: "support@acme.example",
    postalAddress: "Acme Inc., 100 Example Street, Springfield, EX 00000",
    domain: "outreach.acme.example",
    bookingUrl: "https://acme.example/book",
  },
};

export function brainFile(component: string, body: string, opts: { status?: string; version?: number } = {}): string {
  return ["---", `component: ${component}`, `status: ${opts.status ?? "approved"}`, `version: ${opts.version ?? 1}`, "updated: 2026-11-01", "---", "", body, ""].join("\n");
}

export const personasBody = [
  "# Personas",
  "",
  "Notes for humans are ignored.",
  "",
  "## economic-buyer",
  "- role: economic_buyer",
  "- seat: decision_maker",
  "- titles: VP Engineering, Head of Engineering, CTO",
  "- seniority: c_level, vp, head",
  "- text: Owns the engineering tooling budget and approves contracts above the team limit.",
  "",
  "## platform-champion",
  "- role: champion",
  "- seat: influencer",
  "- titles: Staff Engineer, Platform Lead",
  "- text: Feels the pain of flaky pipelines every day and can run a trial alone.",
].join("\n");

export const factsBody = [
  "## median-setup",
  "- text: Most teams finish setup in under an hour.",
  "- value: under an hour",
  "",
  "## soc2",
  "- text: Acme holds a current SOC 2 Type II report.",
].join("\n");

export const pillarsBody = [
  "## less-rerunning",
  "- text: Engineers stop rerunning builds that failed for reasons unrelated to their change.",
  "- proof: median-setup",
  "- personas: platform-champion",
].join("\n");

export const commercialBody = [
  "## team",
  "- plan: Team",
  "- price: 400",
  "- currency: USD",
  "- interval: month",
  "- text: Up to 50 engineers, unlimited repositories.",
].join("\n");
