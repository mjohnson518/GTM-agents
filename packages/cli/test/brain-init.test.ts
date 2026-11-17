// GTM-agents: tests for `gtm brain init` (docs/BRAIN-SCHEMA.md#starting-from-an-interview). Every
// company, person and address is invented, on *.example domains.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPONENT_SCHEMAS, parseBrainFile, type ComponentId } from "@gtm-agents/core/brain";
import { configSchema } from "@gtm-agents/core/config";
import { describe, expect, it } from "vitest";
import { BRAIN_INIT_QUESTIONS, configFromAnswers } from "../src/commands/brain-init.ts";
import { main } from "../src/index.ts";
import { captureIo } from "./helpers.ts";

const ACME: Record<string, string> = {
  company_name: "Acme",
  company_domain: "acme.example",
  company_url: "https://acme.example",
  product_name: "Acme Quarantine",
  product_description: "Detects flaky tests in CI and quarantines them automatically.",
  agent_name: "Avery",
  sender_email: "avery@outreach.acme.example",
  sender_name: "Avery at Acme",
  reply_to: "avery@acme.example",
  support_address: "support@acme.example",
  postal_address: "Acme Inc., 100 Example Street, Springfield, EX 00000",
  buyer_titles: "VP Engineering, Head of Engineering",
  buyer_seniority: "vp, head",
  buyer_cares: "Shipping on time and keeping engineers on product work.",
  champion_titles: "Staff Engineer, Platform Lead",
  champion_seniority: "lead, senior",
  champion_cares: "Never rerunning a red build that passes on retry.",
  icp_who: "Software companies whose engineers run CI on every pull request.",
  icp_must_have: "An automated test suite in CI.",
  icp_why_now: "Flaky tests are slowing their releases.",
  never_reason: "Partners are handled by their account team.",
  never_domains: "initech.example",
  never_titles: "",
  pain: "Flaky tests make engineers rerun builds and lose trust in CI.",
  difference: "Acme quarantines a flaky test the moment it is detected, so it stops blocking merges.",
  proof_claim: "Brightloop cut CI reruns after adopting Acme.",
  proof_figure: "62% fewer reruns",
  proof_url: "https://acme.example/customers/brightloop",
  booking_url: "https://acme.example/book",
  send_days: "MON, TUE, WED, THU",
  send_hours: "8-15",
  voice_do: "Write short, plain sentences an engineer would say.",
  voice_dont: "Never sound like a marketing brochure.",
  signoff: "Avery",
};

const PROOF = ["proof_claim", "proof_figure", "proof_url"];
const without = (keys: string[], base = ACME) => Object.fromEntries(Object.entries(base).filter(([k]) => !keys.includes(k)));

/** A new deployment directory with a brain/ folder to write into, and a gtm.config.ts init must never touch. */
function project(): { root: string; brain: string; config: string } {
  const root = mkdtempSync(join(tmpdir(), "gtm-brain-init-"));
  const brain = join(root, "brain");
  mkdirSync(brain);
  const config = join(root, "gtm.config.ts");
  writeFileSync(config, "// the deployer's own file\n");
  return { root, brain, config };
}

async function initWith(answers: Record<string, unknown>, p = project()) {
  const file = join(p.root, "answers.json");
  writeFileSync(file, JSON.stringify(answers));
  const io = captureIo(p.root);
  const code = await main(["brain", "init", "brain", "--answers", file], io);
  return { code, io, ...p };
}

const read = (dir: string, component: ComponentId) => readFileSync(join(dir, `${component}.md`), "utf8");
const items = (dir: string, component: ComponentId) => parseBrainFile(`${component}.md`, read(dir, component)).items;
const markdown = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".md"));

/** An io whose prompts answer the questions in order from `script` (an id may appear twice: a re-ask). */
function scriptedIo(cwd: string, script: Array<[string, string]>) {
  const io = captureIo(cwd);
  const queue = [...script];
  const asked: string[] = [];
  return Object.assign(io, {
    asked,
    ask(question: string) {
      asked.push(question);
      return Promise.resolve(queue.shift()?.[1] ?? "");
    },
  });
}

describe("gtm brain init: the gate", () => {
  it("scripted answers write a draft brain that gtm brain validate accepts, and a skipped proof leaves facts without a figure", async () => {
    const full = await initWith(ACME);
    expect(full.code, full.io.text()).toBe(0);
    expect(markdown(full.brain).sort()).toEqual(["facts.md", "icp.md", "message-pillars.md", "personas.md", "voice.md"]);
    for (const f of markdown(full.brain)) expect(readFileSync(join(full.brain, f), "utf8"), f).toMatch(/^---\ncomponent: [a-z-]+\nstatus: draft\nversion: 1\nupdated: \d{4}-\d{2}-\d{2}\n---/);
    const validate = captureIo(full.root);
    expect(await main(["brain", "validate", "brain"], validate)).toBe(0);
    expect(validate.text()).toMatch(/5 component\(s\), 0 template\(s\), 0 error\(s\)/);
    expect(items(full.brain, "facts")[0]?.raw.value?.value).toBe("62% fewer reruns");

    const skipped = await initWith(without(PROOF));
    expect(skipped.code, skipped.io.text()).toBe(0);
    expect(existsSync(join(skipped.brain, "facts.md"))).toBe(false);
    expect(read(skipped.brain, "message-pillars")).not.toContain("- proof:");
    expect(await main(["brain", "validate", "brain"], captureIo(skipped.root))).toBe(0);

    const claimOnly = await initWith(without(["proof_figure", "proof_url"]));
    expect(claimOnly.code).toBe(0);
    expect(items(claimOnly.brain, "facts")).toHaveLength(1);
    expect(read(claimOnly.brain, "facts")).not.toContain("- value:");
  });

  it("asks the same questions on a terminal, again when an answer is invalid, and a blank answer skips", async () => {
    const p = project();
    const script: Array<[string, string]> = BRAIN_INIT_QUESTIONS.flatMap((q): Array<[string, string]> =>
      q.id === "proof_url" ? [[q.id, "http://acme.example/customers/brightloop"], [q.id, ACME.proof_url ?? ""]] : q.id === "voice_dont" ? [[q.id, ""]] : [[q.id, ACME[q.id] ?? ""]],
    );
    const io = scriptedIo(p.root, script);
    expect(await main(["brain", "init", "brain"], io), io.text()).toBe(0);
    expect(io.asked).toHaveLength(BRAIN_INIT_QUESTIONS.length + 1);
    expect(io.text()).toMatch(/https/);
    expect(items(p.brain, "facts")[0]?.raw.url?.value).toBe(ACME.proof_url);
    expect(items(p.brain, "voice").map((i) => i.id)).toEqual(["do", "signoff"]);
    expect(await main(["brain", "validate", "brain"], captureIo(p.root))).toBe(0);
  });
});

describe("gtm brain init: skip, never fill", () => {
  it("writes no component whose questions were all skipped, and names it as missing", async () => {
    const r = await initWith(without(["voice_do", "voice_dont", "signoff"]));
    expect(r.code).toBe(0);
    expect(existsSync(join(r.brain, "voice.md"))).toBe(false);
    expect(r.io.text()).toMatch(/Not written \(no answers\): voice/);
  });

  it("records a skipped ICP question as unknown, and writes no never item without a domain or title list", async () => {
    const r = await initWith(without(["icp_must_have", "icp_why_now", "never_domains", "never_titles"]));
    expect(r.code).toBe(0);
    const icp = items(r.brain, "icp");
    expect(icp.map((i) => [i.id, i.raw.kind?.value])).toEqual([
      ["who", "who"],
      ["must-have", "unknown"],
      ["why-now", "unknown"],
    ]);
    expect(icp.find((i) => i.id === "must-have")?.raw.text?.value).toBe("Not answered yet: what must be true of a company you sell to.");
    expect(r.io.text()).toMatch(/never.*needs a domain or a title list/);
  });

  it("writes no ICP at all when every ICP question was skipped", async () => {
    const r = await initWith(without(["icp_who", "icp_must_have", "icp_why_now", "never_reason", "never_domains", "never_titles"]));
    expect(existsSync(join(r.brain, "icp.md"))).toBe(false);
  });

  it("uses a fixed line for a never item whose reason was skipped", async () => {
    const r = await initWith(without(["never_reason"]));
    expect(items(r.brain, "icp").find((i) => i.id === "never")?.raw.text?.value).toBe("Excluded by the deployer.");
  });

  it("writes no persona missing its titles or what they care about", async () => {
    const r = await initWith(without(["champion_cares"]));
    expect(items(r.brain, "personas").map((i) => i.id)).toEqual(["economic-buyer"]);
    expect(r.io.text()).toMatch(/champion.*incomplete/);
  });

  it("treats a differently cased file as the same component, and says so before asking", async () => {
    const p = project();
    const mine = "---\ncomponent: voice\nstatus: draft\nversion: 1\nupdated: 2026-11-01\n---\n\n# Voice\n\n## mine\n- kind: do\n- text: My own words.\n";
    writeFileSync(join(p.brain, "Voice.md"), mine);
    const io = scriptedIo(p.root, BRAIN_INIT_QUESTIONS.map((q): [string, string] => [q.id, ACME[q.id] ?? ""]));
    // Exit 1: the validator refuses the file name Voice.md itself; init's job is only never to overwrite it.
    expect(await main(["brain", "init", "brain"], io), io.text()).toBe(1);
    expect(io.text()).toContain('"Voice.md" is not a brain component');
    const announced = io.stdout.findIndex((l) => l.includes("left alone whatever you answer: voice"));
    expect(announced).toBeGreaterThanOrEqual(0);
    expect(announced).toBeLessThan(io.stdout.findIndex((l) => l.startsWith("1. ")));
    expect(readFileSync(join(p.brain, "Voice.md"), "utf8")).toBe(mine);
    expect(io.text()).toMatch(/Left alone \(already there\): voice/);
  });

  it("writes nothing when the interview is stopped", async () => {
    const p = project();
    const io = Object.assign(captureIo(p.root), { ask: () => Promise.reject(new Error("aborted")) });
    expect(await main(["brain", "init", "brain"], io)).toBe(2);
    expect(io.text()).toMatch(/stopped; nothing was written/);
    expect(markdown(p.brain)).toEqual([]);
  });

  it("never overwrites a component file that already exists", async () => {
    const p = project();
    const mine = "---\ncomponent: voice\nstatus: approved\nversion: 3\nupdated: 2026-11-01\n---\n\n# Voice\n\n## mine\n- kind: do\n- text: My own words.\n";
    writeFileSync(join(p.brain, "voice.md"), mine);
    const r = await initWith(ACME, p);
    expect(r.code).toBe(0);
    expect(read(p.brain, "voice")).toBe(mine);
    expect(r.io.text()).toMatch(/Left alone \(already there\): voice/);
  });

  it("never ties a pillar to the customer result on its own, and says how to", async () => {
    const r = await initWith(ACME);
    expect(read(r.brain, "message-pillars")).not.toContain("- proof:");
    expect(r.io.text()).toContain('add "- proof: customer-result" to that pillar');
    const p = project();
    writeFileSync(join(p.brain, "facts.md"), "---\ncomponent: facts\nstatus: draft\nversion: 1\nupdated: 2026-11-01\n---\n\n# Facts\n\n## other\n- text: Acme runs on every CI provider.\n");
    const kept = await initWith(ACME, p);
    expect(kept.code, kept.io.text()).toBe(0);
    expect(kept.io.text()).not.toContain("customer-result");
  });
});

describe("gtm brain init: the answers it refuses", () => {
  it("exits 2 and writes nothing for an unknown key, a value that is not text, or an answer the schema refuses", async () => {
    for (const bad of [{ ...ACME, nope: "x" }, { ...ACME, buyer_titles: 7 }, { ...ACME, proof_url: "http://acme.example/case" }, { ...ACME, buyer_seniority: "boss" }, { ...ACME, reply_to: "not an address" }, { ...ACME, pain: "See https://acme.example/why for details." }, { ...ACME, difference: "Half the price at $20 a seat." },
      { ...ACME, never_domains: "Initech, Globex Corp" }, { ...ACME, voice_do: `Short${String.fromCharCode(0x2014)}plain.` }, { ...ACME, buyer_titles: "TBD" }, { ...ACME, icp_why_now: "not sure" },
      { ...ACME, sender_email: "avery@acme.example" }, { ...ACME, agent_name: "A".repeat(61) }, { ...ACME, company_domain: "acme.ex4mple" }]) {
      const r = await initWith(bad);
      expect(r.code, JSON.stringify(bad).slice(0, 80)).toBe(2);
      expect(markdown(r.brain)).toEqual([]);
    }
  });

  it("exits 2 without a terminal and without an answers file", async () => {
    const p = project();
    const io = captureIo(p.root);
    expect(await main(["brain", "init", "brain"], io)).toBe(2);
    expect(io.text()).toMatch(/--answers/);
  });

  it("keeps a multi-line answer on one line, so it cannot add a field or an item", async () => {
    const r = await initWith({ ...ACME, voice_do: "Short sentences.\n\n## injected\n- kind: dont\n- text: Shout." });
    expect(r.code).toBe(0);
    expect(items(r.brain, "voice").map((i) => i.id)).toEqual(["do", "dont", "signoff"]);
    expect(items(r.brain, "voice")[0]?.raw.kind?.value).toBe("do");
  });

  it("warns when a pillar answer holds a figure, which belongs in the proof answer", async () => {
    const r = await initWith({ ...ACME, pain: "Engineers lose 5 hours a week to reruns." });
    expect(r.code).toBe(0);
    expect(r.io.text()).toMatch(/WARN.*pain.*figure/);
  });
});

describe("gtm brain init: the questions and the config snippet", () => {
  it("prints every question as JSON in seven batches, each writing a real component field or config path", async () => {
    const io = captureIo();
    expect(await main(["brain", "init", "--questions"], io)).toBe(0);
    const printed = JSON.parse(io.stdout.join("\n")) as { batches: Array<{ number: number; questions: Array<{ id: string; writes: string }> }> };
    expect(printed.batches.map((b) => b.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const ids = printed.batches.flatMap((b) => b.questions.map((q) => q.id));
    expect(ids).toEqual(BRAIN_INIT_QUESTIONS.map((q) => q.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const q of BRAIN_INIT_QUESTIONS) {
      if (q.target.kind === "brain") expect(Object.keys(COMPONENT_SCHEMAS[q.target.component].shape), q.id).toContain(q.target.field);
      else expect(q.target.path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], configFromAnswers(ACME)), q.id).toBeDefined();
    }
    expect(Object.keys(ACME).sort()).toEqual([...ids].sort());
  });

  it("prints a snippet of only the answered values, which the config schema accepts, and never edits gtm.config.ts", async () => {
    const r = await initWith(without(["booking_url"]));
    const text = r.io.text();
    expect(text).toContain('replyTo: "avery@acme.example"');
    expect(text).toContain('domain: "outreach.acme.example"');
    expect(text).toContain("windowHours: { start: 8, end: 15 }");
    expect(text).not.toContain("bookingUrl");
    expect(readFileSync(r.config, "utf8")).toBe("// the deployer's own file\n");
    const parsed = configSchema.safeParse(configFromAnswers(ACME));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("points to the dashboard and gtm brain pull for drafting from the site", async () => {
    const r = await initWith(ACME);
    expect(r.io.text()).toMatch(/Product and ICP page/);
    expect(r.io.text()).toMatch(/gtm brain pull/);
  });
});
