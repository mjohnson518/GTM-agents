// GTM-agents: behavior evals for the quality gate's cliche lint and the brain voice's avoid phrases
// (quality:cliche_lint_enabled). Invented Acme copy to invented contacts: twelve drafts that lean on
// stock phrases are held with LINT_CLICHE while the flag is on and are untouched while it is off,
// twelve clean drafts pass with the flag on, and a reply that uses a phrase the voice quotes in an
// avoid item is held with VOICE_AVOIDED. The suite also proves its own scorer catches a bad output,
// so it cannot pass by scoring nothing.
//
// The gate runs inside the Worker, so it is loaded by path at run time and called through a small
// local signature, as tests/evals/writers.eval.ts does.
import { describe, expect, it } from "vitest";

const MODULES = {
  gate: "../../packages/core/src/quality/gate.ts",
  claims: "../../packages/core/src/quality/claims.ts",
} as const;
const load = async <T>(path: string): Promise<T> => (await import(/* @vite-ignore */ path)) as T;

interface QualityResult {
  verdict: "pass" | "hold" | "block";
  findings: Array<{ code: string; severity: string; detail: string }>;
}
interface Gate {
  checkOutboundQuality(input: unknown): QualityResult;
  QUALITY_CODES: Record<string, string>;
}
interface Claims {
  voiceAvoidPhrases(slice: string): string[];
}

const VOICE_SLICE = [
  "GTM BRAIN (version 0a1b2c3d4e5f, operator-approved; task: judge)",
  "",
  "### voice (v1)",
  "- plain: kind: do; text: Write like one engineer talking to another.",
  '- avoid-guilt: kind: avoid; text: Avoid guilt-trip follow-ups such as "just checking in" or "did you see my last email".',
  '- no-hype: kind: dont; text: Never call the product "the future of testing".',
  "- no-prose: kind: dont; text: Do not pretend to know the reader or their team.",
].join("\n");

interface Draft {
  name: string;
  kind: "cold_intro" | "follow_up" | "reply";
  first: string;
  domain: string;
  account: string;
  subject: string;
  body: string;
}

const frame = (first: string, middle: string, ask: string) =>
  [`Hi ${first},`, "", "When a build fails for a reason unrelated to the change, someone reruns it, waits, and loses the thread of what they were doing.", "", middle, "", ask, "", "Avery"].join("\n");

const cold = (name: string, first: string, account: string, middle: string, ask = `Is rerun time something the team at ${account} tracks today?`): Draft => ({
  name,
  kind: "cold_intro",
  first,
  domain: `${account.toLowerCase()}.example`,
  account,
  subject: `Flaky builds at ${account}`,
  body: frame(first, middle, ask),
});

const CLICHE_DRAFTS: Draft[] = [
  cold("hope it finds you well", "Jane", "Globex", "I hope this message finds you well and the week is going smoothly."),
  cold("hope you are doing well", "Sam", "Initech", "I hope you're doing well after the release."),
  cold("synergy", "Priya", "Umbrella", "There is a clear synergy between our retry engine and your pipeline."),
  cold("leverage", "Tomas", "Hooli", "Teams leverage Acme to see which tests fail without a code change."),
  cold("unlock", "Mei", "Vandelay", "Acme can unlock shorter queues for the whole team."),
  cold("game-changer", "Lena", "Wayne", "Engineers tell us the rerun report is a game-changer for their mornings."),
  cold("cutting-edge", "Omar", "Stark", "Our cutting-edge detector reads every rerun."),
  cold("best-in-class", "Ines", "Tyrell", "Acme is a best-in-class flake detector for busy pipelines."),
  cold("elevate your", "Kofi", "Soylent", "Elevate your pipeline by knowing which tests are flaky."),
  cold("as a title at company", "Rosa", "Cyberdyne", "As a VP of Engineering at Cyberdyne, you know how much a red build costs."),
  cold("quick question with no question", "Arjun", "Massive", "Quick question about your pipeline. It runs on every merge.", "Let me know what you think about it, whenever there is a moment."),
  cold("three questions", "Nora", "Gringotts", "Does the team rerun failed builds? Who decides when a test is quarantined?", "Is rerun time tracked at Gringotts?"),
];

const NUDGE: Draft = {
  name: "a nudge with nothing new",
  kind: "follow_up",
  first: "Jane",
  domain: "globex.example",
  account: "Globex",
  subject: "Re: Flaky builds at Globex",
  body: "Hi Jane,\n\nCircling back on my note from last week about the build reruns.\n\nThanks,\nAvery",
};

const CLEAN_DRAFTS: Draft[] = [
  cold("plain question", "Jane", "Globex", "Acme keeps a log of every rerun and the test that caused it, so the team can see where the time goes."),
  cold("queue time", "Sam", "Initech", "Most of that time is the queue, not the test itself, and the queue grows when the same test fails twice."),
  cold("quarantine", "Priya", "Umbrella", "Acme marks a test that fails without a code change and suggests it for quarantine, which a person approves."),
  cold("standup", "Tomas", "Hooli", "It usually shows up as frustration in standup rather than as a number anyone tracks."),
  cold("owners", "Mei", "Vandelay", "Each flaky test gets an owner from the code history, so the fix lands with the person who knows the code."),
  cold("nightly", "Lena", "Wayne", "The nightly report lists the tests that failed and passed on the same commit, with the rerun cost for each."),
  cold("merge queue", "Omar", "Stark", "A red build in the merge queue holds up everyone behind it, which is where the cost adds up."),
  cold("ownership", "Ines", "Tyrell", "Acme reads the build logs you already keep and needs no change to the tests themselves."),
  cold("signal", "Kofi", "Soylent", "A red build should mean a real problem, and that stops being true once people learn to rerun by habit."),
  cold("on call", "Rosa", "Cyberdyne", "The person on call usually pays for it, because a flaky failure at night looks the same as a real one."),
  cold("different ask", "Arjun", "Massive", "Acme groups failures by test and by runner, so a bad runner does not look like a bad test.", "Would a short look at last month's reruns at Massive be useful?"),
  cold("one quick question asked", "Nora", "Gringotts", "Here is the one quick question I have for you: does anyone own the flaky list?", "If so, would they want a report like this?"),
];

const AVOID_REPLY: Draft = {
  name: "a reply with a phrase the voice avoids",
  kind: "reply",
  first: "Jane",
  domain: "globex.example",
  account: "Globex",
  subject: "Re: Flaky builds at Globex",
  body: "Thanks Jane, just checking in on the rerun numbers you mentioned. Would Thursday work for a short call?\n\nAvery",
};

function input(draft: Draft, extras: Record<string, unknown>): Record<string, unknown> {
  const email = `${draft.first.toLowerCase()}@${draft.domain}`;
  return {
    kind: draft.kind,
    subject: draft.subject,
    body: draft.body,
    recipient: email,
    contact: { email, firstName: draft.first, accountName: draft.account, accountKey: draft.domain },
    links: { domains: ["acme.example"], exactUrls: [] },
    ...extras,
  };
}

/** The scorer: did the gate hold the draft for a cliche or an avoided phrase? */
const heldForVoice = (result: QualityResult) => result.verdict === "hold" && result.findings.some((f) => f.code === "LINT_CLICHE" || f.code === "VOICE_AVOIDED");

describe("quality gate eval: the cliche lint and the voice's avoid phrases", () => {
  it("declares both codes as holds", async () => {
    const gate = await load<Gate>(MODULES.gate);
    expect(gate.QUALITY_CODES.LINT_CLICHE).toBe("hold");
    expect(gate.QUALITY_CODES.VOICE_AVOIDED).toBe("hold");
  });

  it("holds every cliche draft with LINT_CLICHE while the flag is on, and none while it is off", async () => {
    const gate = await load<Gate>(MODULES.gate);
    const avoidPhrases = (await load<Claims>(MODULES.claims)).voiceAvoidPhrases(VOICE_SLICE);
    expect(CLICHE_DRAFTS).toHaveLength(12);
    for (const draft of [...CLICHE_DRAFTS, NUDGE]) {
      const on = gate.checkOutboundQuality(input(draft, { clicheLint: true, avoidPhrases }));
      expect(on.findings.map((f) => f.code), draft.name).toContain("LINT_CLICHE");
      expect(heldForVoice(on), draft.name).toBe(true);
      const off = gate.checkOutboundQuality(input(draft, {}));
      expect(off.findings.map((f) => f.code), draft.name).not.toContain("LINT_CLICHE");
    }
  });

  it("passes every clean draft with the flag on", async () => {
    const gate = await load<Gate>(MODULES.gate);
    const avoidPhrases = (await load<Claims>(MODULES.claims)).voiceAvoidPhrases(VOICE_SLICE);
    expect(CLEAN_DRAFTS).toHaveLength(12);
    for (const draft of CLEAN_DRAFTS) {
      const result = gate.checkOutboundQuality(input(draft, { clicheLint: true, avoidPhrases }));
      expect(result.findings, draft.name).toEqual([]);
      expect(result.verdict, draft.name).toBe("pass");
    }
  });

  it("holds a reply that uses a phrase quoted in a voice avoid item, only when the phrases are passed", async () => {
    const gate = await load<Gate>(MODULES.gate);
    const avoidPhrases = (await load<Claims>(MODULES.claims)).voiceAvoidPhrases(VOICE_SLICE);
    expect(avoidPhrases).toEqual(["just checking in", "did you see my last email", "the future of testing"]);
    const on = gate.checkOutboundQuality(input(AVOID_REPLY, { avoidPhrases }));
    expect(on.findings.find((f) => f.code === "VOICE_AVOIDED")?.detail).toContain("just checking in");
    expect(heldForVoice(on)).toBe(true);
    expect(gate.checkOutboundQuality(input(AVOID_REPLY, {})).findings.map((f) => f.code)).not.toContain("VOICE_AVOIDED");
  });

  it("the scorer catches a bad output and clears a good one", async () => {
    const gate = await load<Gate>(MODULES.gate);
    const bad = CLICHE_DRAFTS[0];
    const good = CLEAN_DRAFTS[0];
    if (!bad || !good) throw new Error("the eval needs drafts");
    expect(heldForVoice(gate.checkOutboundQuality(input(bad, { clicheLint: true })))).toBe(true);
    expect(heldForVoice(gate.checkOutboundQuality(input(good, { clicheLint: true })))).toBe(false);
    // A gate result that held for something else is not a voice hold.
    expect(heldForVoice({ verdict: "hold", findings: [{ code: "NO_QUESTION", severity: "hold", detail: "x" }] })).toBe(false);
  });
});
