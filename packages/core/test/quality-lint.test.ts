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

  it("normalizes compatibility characters before checking", () => {
    const fullwidthBraces = `Hi ${String.fromCharCode(0xff5b, 0xff5b)}first_name${String.fromCharCode(0xff5d, 0xff5d)},`;
    expect(codes(lintOutbound({ ...ok, body: fullwidthBraces })).blocks).toContain("PLACEHOLDER_LEAK");
  });
});
