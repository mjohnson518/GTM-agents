// GTM-agents: tests for the deterministic quality gate: every check, its code and its severity.
import { describe, expect, it } from "vitest";
import { findFlag } from "../src/flags/registry.ts";
import { CLICHE_LINT_FLAG, QUALITY_CODES, approvedClaimLines, checkClaims, checkOutboundQuality, isUsableAccountName, summarizeQuality, usableFirstName, voiceAvoidPhrases, type QualityInput } from "../src/quality/index.ts";

const BODY = [
  "Hi Jane,",
  "",
  "When a build fails for a reason unrelated to the change, someone reruns it, waits, and loses the thread of what they were doing.",
  "",
  "Is flaky-test time something your team tracks at Globex, or does it mostly show up as frustration in standup?",
  "",
  "Avery",
].join("\n");

const base: QualityInput = {
  kind: "cold_intro",
  subject: "Flaky builds at Globex",
  body: BODY,
  recipient: "jane@globex.example",
  contact: { email: "jane@globex.example", firstName: "Jane", accountName: "Globex", accountKey: "globex.example" },
  links: { domains: ["acme.example"], exactUrls: ["https://cal.example/acme/intro"] },
  claimSources: [BODY, "Flaky builds at Globex"],
};

const run = (patch: Partial<QualityInput>) => checkOutboundQuality({ ...base, ...patch });
const codes = (patch: Partial<QualityInput>) => run(patch).findings.map((f) => f.code);
const severityOf = (patch: Partial<QualityInput>, code: string) => run(patch).findings.find((f) => f.code === code)?.severity;

describe("checkOutboundQuality", () => {
  it("passes clean, personal, in-bounds copy", () => {
    expect(run({})).toEqual({ verdict: "pass", score: 100, findings: [] });
  });

  it("maps the lint's blocks to blocks and its warnings to holds", () => {
    expect(severityOf({ body: `${BODY}\nTODO: add proof` }, "LINT_PLACEHOLDER_LEAK")).toBe("block");
    expect(severityOf({ body: BODY.replace("waits", `waits ${String.fromCharCode(0x2014)}`) }, "LINT_HOUSE_RULE_CHARACTER")).toBe("block");
    expect(severityOf({ body: `${BODY}\nSee https://bit.ly/x` }, "LINT_URL_SHORTENER")).toBe("block");
    expect(severityOf({ body: BODY.replace("Avery", "Act now. Avery") }, "LINT_SPAM_PHRASE")).toBe("hold");
    expect(run({ body: `${BODY}\nTODO` }).verdict).toBe("block");
  });

  it("normalizes compatibility characters before checking", () => {
    const fullwidth = String.fromCharCode(0xff5b, 0xff5b);
    expect(codes({ body: BODY.replace("Hi Jane,", `Hi ${fullwidth}first_name}},`) })).toContain("LINT_PLACEHOLDER_LEAK");
  });

  it("blocks a recipient who is not the contact the copy was written for", () => {
    expect(severityOf({ recipient: "someone@globex.example" }, "RECIPIENT_MISMATCH")).toBe("block");
    expect(codes({ recipient: "jane@globex.example, cc@attacker.example" })).toContain("RECIPIENT_MISMATCH");
    expect(codes({ recipient: "JANE@globex.example" })).not.toContain("RECIPIENT_MISMATCH");
  });

  it("blocks copy that names an account name the identity rules reject", () => {
    const patch = { contact: { ...base.contact!, accountName: "Inc" }, subject: "Hello from Inc", body: BODY.replace("at Globex", "at Inc") };
    expect(severityOf(patch, "UNUSABLE_ACCOUNT_NAME")).toBe("block");
  });

  it("holds a greeting that is not personal, and one for a contact with no usable first name", () => {
    expect(severityOf({ body: BODY.replace("Hi Jane,", "Hi there,") }, "GREETING_NOT_PERSONAL")).toBe("hold");
    expect(codes({ contact: { ...base.contact!, firstName: "j" }, body: BODY.replace("Hi Jane,", "Hi there,") })).toContain("GREETING_NOT_PERSONAL");
    expect(codes({ kind: "reply", body: BODY.replace("Hi Jane,", "Thanks,") })).not.toContain("GREETING_NOT_PERSONAL");
  });

  it("holds a generic fallback while the account name is known", () => {
    const body = BODY.replace("at Globex", "at your company");
    expect(severityOf({ body, subject: "Flaky builds" }, "ACCOUNT_FALLBACK_USED")).toBe("hold");
  });

  it("allows only the company's domain, its subdomains and the exact booking URL", () => {
    expect(codes({ body: `${BODY}\nhttps://docs.acme.example/setup` })).not.toContain("LINK_NOT_ALLOWED");
    expect(codes({ body: `${BODY}\nBook a time: https://cal.example/acme/intro.` })).not.toContain("LINK_NOT_ALLOWED");
    expect(severityOf({ body: `${BODY}\nhttps://cal.example/someone-else` }, "LINK_NOT_ALLOWED")).toBe("hold");
    expect(codes({ body: `${BODY}\nwww.tracker.example/x` })).toContain("LINK_NOT_ALLOWED");
    expect(codes({ body: `${BODY}\nhttps://acme.example.attacker.example/` })).toContain("LINK_NOT_ALLOWED");
    expect(codes({ body: `${BODY}\nDetails at offers.attacker.example/deal` })).toContain("LINK_NOT_ALLOWED");
    expect(codes({ body: `${BODY}\nDocs live at docs.acme.example/setup.` })).not.toContain("LINK_NOT_ALLOWED");
    expect(codes({ body: `${BODY}\nWrite to jane@globex.example any time.` })).not.toContain("LINK_NOT_ALLOWED");
  });

  it("blocks a line break in the subject", () => {
    expect(severityOf({ subject: "Flaky builds\r\nBcc: list@attacker.example" }, "SUBJECT_LINE_BREAK")).toBe("block");
  });

  it("holds a figure or claim that no approved source contains", () => {
    expect(severityOf({ body: BODY.replace("waits,", "waits 40% longer,") }, "UNAPPROVED_CLAIM")).toBe("hold");
    expect(codes({ body: BODY.replace("waits,", "waits, and our customers love it,") })).toContain("UNAPPROVED_CLAIM");
    expect(codes({ body: BODY.replace("waits,", "waits 40% longer,"), claimSources: [...base.claimSources!, "Teams wait 40% longer"] })).not.toContain("UNAPPROVED_CLAIM");
    expect(codes({ body: BODY.replace("waits,", "waits 40% longer,"), claimSources: undefined })).not.toContain("UNAPPROVED_CLAIM");
  });

  it("holds bodies out of bounds for their kind, long subjects, a cold intro with no question and exclamations", () => {
    expect(severityOf({ body: "Hi Jane,\n\nQuick one?" }, "TOO_SHORT")).toBe("hold");
    expect(codes({ body: `${BODY}\n${"word ".repeat(200)}` })).toContain("TOO_LONG");
    expect(codes({ kind: "follow_up", body: "Hi Jane,\n\nCircling back on the note about flaky builds at Globex. Worth a look?" })).not.toContain("TOO_SHORT");
    expect(severityOf({ subject: `Flaky builds at Globex ${"x".repeat(80)}` }, "SUBJECT_TOO_LONG")).toBe("hold");
    expect(severityOf({ body: BODY.replace("?", ".") }, "NO_QUESTION")).toBe("hold");
    expect(codes({ kind: "follow_up", body: BODY.replace("?", ".") })).not.toContain("NO_QUESTION");
    expect(severityOf({ body: BODY.replace("Hi Jane,", "Hi Jane!").replace("Avery", "Thanks! Avery") }, "EXCLAMATIONS")).toBe("hold");
  });

  it("scores 100 minus 40 per block and 15 per hold", () => {
    const result = run({ body: BODY.replace("Hi Jane,", "Hi there,").replace("?", "."), recipient: "x@globex.example" });
    expect(result.verdict).toBe("block");
    expect(result.score).toBe(100 - 40 - 15 - 15);
  });

  it("declares a severity for every code it reports", () => {
    const all = new Set(Object.keys(QUALITY_CODES));
    for (const patch of [{ body: "TODO" }, { recipient: "x@y.example" }, { body: BODY.replace("waits,", "waits 9x,") }]) {
      for (const f of run(patch).findings) expect(all.has(f.code), f.code).toBe(true);
    }
  });
});

describe("name and claim helpers", () => {
  it("accepts names and company names that read as such", () => {
    expect(usableFirstName("Jane")).toBe("Jane");
    expect(usableFirstName("Ana-Maria")).toBe("Ana-Maria");
    expect(usableFirstName("j")).toBeNull();
    expect(usableFirstName("jane@globex.example")).toBeNull();
    expect(usableFirstName("Jane2")).toBeNull();
    expect(isUsableAccountName("Globex Corporation")).toBe(true);
    expect(isUsableAccountName("Inc")).toBe(false);
    expect(isUsableAccountName("GV", "gv.example")).toBe(true);
    expect(isUsableAccountName("https://globex.example")).toBe(false);
  });

  it("matches figures with their suffixes and claim terms by pattern", () => {
    expect(checkClaims("We are 10x faster", ["10 engineers"])).toEqual({ ok: false, token: "10x" });
    expect(checkClaims("It is free", ["Feel free to ignore this"])).toEqual({ ok: false, token: "free" });
    expect(checkClaims("Setup takes under an hour, see https://acme.example/2026/setup", ["Most teams finish setup in under an hour."])).toEqual({ ok: true });
    expect(checkClaims("Three teams asked", ["three teams"])).toEqual({ ok: true });
  });

  it("reads approved claims only from the facts and message-pillars blocks of a slice", () => {
    const slice = [
      "GTM BRAIN (version 3f9a1c0b7d2e, operator-approved; task: judge)",
      "",
      "### voice (v1)",
      "- plain: kind: do; text: Use 5 words",
      "",
      "### facts (v2)",
      "- setup-time: text: Most teams finish setup in under an hour.; value: under an hour",
      "",
      "### message-pillars (v1)",
      "- less-rerunning: text: Engineers stop rerunning builds.",
      "",
      "Missing from the brain for this task: none.",
    ].join("\n");
    expect(approvedClaimLines(slice)).toEqual(["setup-time: text: Most teams finish setup in under an hour.; value: under an hour", "less-rerunning: text: Engineers stop rerunning builds."]);
  });

  it("summarizes results in one line for operator messages", () => {
    const pass = run({});
    const held = run({ body: BODY.replace("Hi Jane,", "Hi there,") });
    expect(summarizeQuality([pass, held, held])).toBe("1 pass, 2 held, 0 blocked; most common: GREETING_NOT_PERSONAL (2)");
  });
});

describe("the cliche lint and the brain's voice phrases (quality:cliche_lint_enabled)", () => {
  const VOICE_SLICE = [
    "GTM BRAIN (version 3f9a1c0b7d2e, operator-approved; task: replies)",
    "",
    "### voice (v1)",
    "- plain: kind: do; text: Say \"thanks for the note\" when it fits.",
    '- avoid-guilt: kind: avoid; text: Avoid guilt-trip follow-ups such as "just checking in" or "did you see my last email?".',
    "- no-hype: kind: dont; text: Never write \u201cworld class platform\u201d or \"wow\".",
    "- no-prose: kind: dont; text: Do not pretend to know the reader.",
    "",
    "### facts (v2)",
    '- quoted: text: Customers say "just checking in" is fine here.',
  ].join("\n");
  const hopeIntro = BODY.replace("Hi Jane,", "Hi Jane,\n\nI hope this message finds you well.");
  const reply = {
    kind: "reply" as const,
    subject: "Re: Flaky builds at Globex",
    body: "Thanks Jane, just checking in on the build times you mentioned. Would Thursday work for a short call?\n\nAvery",
    claimSources: undefined,
  };

  it("holds a cold intro that hopes the message finds them well, and a reply with a phrase quoted in a voice avoid item, only with the flag on", () => {
    const on = run({ body: hopeIntro, clicheLint: true });
    expect(on.verdict).toBe("hold");
    expect(on.findings.find((f) => f.code === "LINT_CLICHE")?.severity).toBe("hold");

    const avoidPhrases = voiceAvoidPhrases(VOICE_SLICE);
    const replyOn = run({ ...reply, avoidPhrases });
    expect(replyOn.verdict).toBe("hold");
    const avoided = replyOn.findings.find((f) => f.code === "VOICE_AVOIDED");
    expect(avoided?.severity).toBe("hold");
    expect(avoided?.detail).toContain("just checking in");

    // The flag off: callers pass neither field, and neither code appears.
    expect(codes({ body: hopeIntro })).not.toContain("LINT_CLICHE");
    expect(codes({ body: hopeIntro, clicheLint: false })).not.toContain("LINT_CLICHE");
    expect(codes({ ...reply })).not.toContain("VOICE_AVOIDED");
    expect(run({ body: hopeIntro })).toEqual(run({ body: hopeIntro, clicheLint: false }));
  });

  it("reads only quoted phrases of two to six words from voice items of kind dont or avoid", () => {
    expect(voiceAvoidPhrases(VOICE_SLICE)).toEqual(["just checking in", "did you see my last email", "world class platform"]);
    expect(voiceAvoidPhrases("### voice (v1)\n- no-prose: kind: dont; text: Do not pretend to know the reader.")).toEqual([]);
    expect(voiceAvoidPhrases("")).toEqual([]);
    expect(voiceAvoidPhrases('### voice (v1)\n- long: kind: avoid; text: Avoid "one two three four five six seven".')).toEqual([]);
  });

  it("matches an avoided phrase as a whole phrase, case-insensitively, after NFKC", () => {
    const avoidPhrases = ["just checking in"];
    expect(codes({ ...reply, body: reply.body.replace("just checking in", "JUST  checking\nin"), avoidPhrases })).toContain("VOICE_AVOIDED");
    expect(codes({ ...reply, body: reply.body.replace("just checking in", "just checking into"), avoidPhrases })).not.toContain("VOICE_AVOIDED");
    const fullwidth = String.fromCharCode(0xff4a, 0xff55, 0xff53, 0xff54);
    expect(codes({ ...reply, body: reply.body.replace("just", fullwidth), avoidPhrases })).toContain("VOICE_AVOIDED");
  });

  it("holds three or more question marks in a cold intro only with the flag on", () => {
    const many = BODY.replace("standup?", "standup? Is it daily? Weekly?");
    expect(codes({ body: many, clicheLint: true })).toContain("LINT_CLICHE");
    expect(codes({ body: many })).not.toContain("LINT_CLICHE");
    expect(codes({ kind: "follow_up", body: many, clicheLint: true })).not.toContain("LINT_CLICHE");
  });

  it("declares a severity for both new codes", () => {
    expect(QUALITY_CODES.LINT_CLICHE).toBe("hold");
    expect(QUALITY_CODES.VOICE_AVOIDED).toBe("hold");
  });

  it("is listed in the flag registry, off by default", () => {
    expect(CLICHE_LINT_FLAG).toBe("quality:cliche_lint_enabled");
    expect(findFlag(CLICHE_LINT_FLAG)).toMatchObject({ kind: "boolean", default: "false" });
  });
});
