// GTM-agents: tests for the content lint every outbound message passes.
import { describe, expect, it } from "vitest";
import { lintOutbound } from "../src/quality/index.ts";

const ok = { subject: "Flaky tests at Acme", body: "Hi Jane,\n\nDo flaky tests slow your merges?\n\nAvery" };
const codes = (r: { blocks: Array<{ code: string }>; warnings: Array<{ code: string }> }) => ({ blocks: r.blocks.map((f) => f.code), warnings: r.warnings.map((f) => f.code) });

describe("lintOutbound", () => {
  it("passes ordinary plain-text copy", () => {
    expect(lintOutbound(ok)).toEqual({ blocks: [], warnings: [] });
  });

  it("blocks what must never be sent", () => {
    const cases: Array<[Partial<typeof ok>, string]> = [
      [{ subject: " " }, "EMPTY_SUBJECT"],
      [{ body: "" }, "EMPTY_BODY"],
      [{ body: `Hi Jane${String.fromCharCode(0x200b)},` }, "HIDDEN_CHARACTER"],
      [{ body: `Fast ${String.fromCharCode(0x2014)} and reliable` }, "HOUSE_RULE_CHARACTER"],
      [{ body: "Hi {{first_name}}," }, "PLACEHOLDER_LEAK"],
      [{ body: "Hi [Your Name]," }, "PLACEHOLDER_LEAK"],
      [{ body: "TODO: add a hook" }, "PLACEHOLDER_LEAK"],
      [{ body: "See https://bit.ly/abc" }, "URL_SHORTENER"],
      [{ body: "<p>Hello</p>" }, "HTML"],
    ];
    for (const [patch, code] of cases) expect(codes(lintOutbound({ ...ok, ...patch })).blocks, code).toContain(code);
  });

  it("warns where a person should look", () => {
    const cases: Array<[Partial<typeof ok>, string]> = [
      [{ body: "This is risk-free, act now." }, "SPAM_PHRASE"],
      [{ subject: "FLAKY TESTS FIXED" }, "SUBJECT_CAPS"],
      [{ subject: "Flaky tests?!" }, "SUBJECT_PUNCTUATION"],
      [{ body: "Great! Really great!" }, "EXCLAMATIONS"],
      [{ body: "word ".repeat(201) }, "BODY_TOO_LONG"],
    ];
    for (const [patch, code] of cases) expect(codes(lintOutbound({ ...ok, ...patch })).warnings, code).toContain(code);
  });

  it("warns on AI-written cliches, whole words only, after NFKC", () => {
    const cliche = (body: string, subject = ok.subject) => lintOutbound({ subject, body }).warnings.filter((w) => w.code === "CLICHE").map((w) => w.detail);
    const hits: string[] = [
      "Hi Jane,\n\nI hope this email finds you well. Do flaky tests slow your merges?\n\nAvery",
      "Hi Jane,\n\nHope you are well and this finds you rested. Do flaky tests slow your merges?\n\nAvery",
      "Hi Jane,\n\nI hope you're doing well. Do flaky tests slow your merges?\n\nAvery",
      "Hi Jane,\n\nJust checking in.\n\nThanks,\nAvery",
      "Hi Jane,\n\nCircling back on this.\n\nAvery",
      "Hi Jane,\n\nBumping this to the top of your inbox.\n\nBest,\nAvery",
      "Hi Jane,\n\nFollowing up on my last note.\n\nAvery",
      "There is real synergy between our teams.",
      "We leverage your build logs to find flaky tests.",
      "This could unlock faster merges.",
      "It is a game-changer for CI.",
      "Our cutting-edge retry engine helps.",
      "A best-in-class flake detector.",
      "Elevate your test suite this quarter.",
      "As a VP of Engineering at Globex, you know how flaky tests hurt.",
      "Quick question about your CI. It runs on every merge.",
      "We LEVERAGE your logs.",
      `We ${String.fromCharCode(0xff4c, 0xff45, 0xff56, 0xff45, 0xff52, 0xff41, 0xff47, 0xff45)} your logs.`,
    ];
    for (const body of hits) expect(cliche(body), body).not.toEqual([]);
    // The subject is checked too; a quick question the body then asks is not a cliche.
    expect(cliche(ok.body, "Quick question for Globex")).toEqual([]);
    expect(cliche("Hi Jane,\n\nDo flaky tests slow your merges?\n\nAvery", "Unlock faster merges")).not.toEqual([]);
    // Leverage as a noun is still a hit; a person decides, which is acceptable.
    expect(cliche("The fact sheet says teams gain leverage over flaky tests.")).not.toEqual([]);
  });

  it("does not warn on near-misses", () => {
    const cliche = (body: string) => lintOutbound({ subject: ok.subject, body }).warnings.filter((w) => w.code === "CLICHE");
    const misses: string[] = [
      ok.body,
      "Hi Jane,\n\nI hope the release went well. Do flaky tests slow your merges?\n\nAvery",
      "Hi Jane,\n\nFollowing up on your question about retries: we keep a log of every rerun and its cause, so the team can see which tests fail without a code change. Would a short call help?\n\nAvery",
      "Our unlocked plan is the same price.",
      "The game changed for us last year.",
      "A cutting tool for the edge cases.",
      "As a rule, flaky tests at Globex slow merges.",
      "Quick question: do flaky tests slow your merges?",
      "The unlocker tool is not on the list.",
      "The synergistic word is not on the list.",
    ];
    for (const body of misses) expect(cliche(body), body).toEqual([]);
  });

  it("normalizes compatibility characters before checking", () => {
    const fullwidthBraces = `Hi ${String.fromCharCode(0xff5b, 0xff5b)}first_name${String.fromCharCode(0xff5d, 0xff5d)},`;
    expect(codes(lintOutbound({ ...ok, body: fullwidthBraces })).blocks).toContain("PLACEHOLDER_LEAK");
  });
});
