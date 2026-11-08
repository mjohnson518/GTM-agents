// GTM-agents: tests for template validation and rendering.
import { describe, expect, it } from "vitest";
import { renderTemplate } from "../src/templates/render.ts";
import { validateTemplateFile, validateTemplates } from "../src/templates/validate.ts";

function template(fields: Record<string, string>, body: string): string {
  return ["---", ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), "---", body, ""].join("\n");
}

const coldBody = [
  "Hi {{first_name}},",
  "",
  "Most teams we talk to lose a few engineer-hours a week rerunning builds that failed for reasons unrelated to the change in front of them.",
  "{{persona_line}}",
  "",
  "Is that something your team tracks today at {{account_name}}, or does it mostly show up as frustration in standup?",
  "",
  "{{sender_name}}",
].join("\n");

const coldFields = { id: "cold-intro", kind: "cold_intro", status: "approved", step: "1", subject: "Flaky builds at {{account_name}}" };
const errors = (issues: Array<{ severity: string; message: string }>) => issues.filter((i) => i.severity === "error").map((i) => i.message);

describe("validateTemplateFile", () => {
  it("accepts a well-formed cold intro", () => {
    const parsed = validateTemplateFile("cold-intro.md", template(coldFields, coldBody), { companyDomain: "acme.example" });
    expect(errors(parsed.issues)).toEqual([]);
    expect(parsed.meta?.angle).toBe("none");
  });

  it("rejects unknown variables and a copy line that does not sit alone", () => {
    const body = coldBody.replace("{{first_name}}", "{{firstname}}").replace("{{persona_line}}", "Also {{persona_line}}");
    const messages = errors(validateTemplateFile("cold-intro.md", template(coldFields, body)).issues).join("\n");
    expect(messages).toMatch(/unknown variable \{\{firstname\}\}/);
    expect(messages).toMatch(/must sit alone/);
  });

  it("rejects placeholder leaks, an unsubscribe line and links off the company domain", () => {
    const body = `${coldBody}\n[INSERT case study]\nSee https://elsewhere.example/page\nTo unsubscribe, reply STOP.`;
    const messages = errors(validateTemplateFile("cold-intro.md", template(coldFields, body), { companyDomain: "acme.example" }).issues).join("\n");
    expect(messages).toMatch(/\[INSERT/);
    expect(messages).toMatch(/not allowed/);
    expect(messages).toMatch(/unsubscribe/);
  });

  it("requires a question in a cold intro, a step for sequence kinds and an id that matches the file", () => {
    const noQuestion = coldBody.replace("?", ".");
    expect(errors(validateTemplateFile("cold-intro.md", template(coldFields, noQuestion)).issues).join()).toMatch(/question/);
    const { step: _step, ...withoutStep } = coldFields;
    expect(errors(validateTemplateFile("cold-intro.md", template(withoutStep, coldBody)).issues).join()).toMatch(/need a step/);
    expect(errors(validateTemplateFile("other-name.md", template(coldFields, coldBody)).issues).join()).toMatch(/must equal the file name/);
  });

  it("rejects em dashes and more than one exclamation mark", () => {
    const dash = String.fromCharCode(0x2014);
    const body = coldBody.replace("Most teams", `Great news! Big news! Most teams${dash}`);
    const messages = errors(validateTemplateFile("cold-intro.md", template(coldFields, body)).issues).join("\n");
    expect(messages).toMatch(/dashes/);
    expect(messages).toMatch(/exclamation/);
  });

  it("ignores a README in the templates folder", () => {
    const content = template(coldFields, coldBody);
    const result = validateTemplates([
      { name: "cold-intro.md", content },
      { name: "README.md", content: "# Templates" },
    ]);
    expect(result.parsed).toHaveLength(1);
  });
});

describe("renderTemplate", () => {
  const values = { first_name: "Dana", account_name: "Globex", sender_name: "Avery", persona_line: "Platform teams feel this first." };

  it("fills every variable", () => {
    const result = renderTemplate({ subject: "Flaky builds at {{account_name}}", body: coldBody }, values);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.subject).toBe("Flaky builds at Globex");
    expect(result.body).toContain("Hi Dana,");
    expect(result.body).toContain("Platform teams feel this first.");
    expect(result.body).not.toContain("{{");
  });

  it("holds the draft when a variable has no value, instead of guessing", () => {
    const result = renderTemplate({ subject: "Hi {{first_name}}", body: coldBody }, { ...values, first_name: "  " });
    expect(result).toEqual({ ok: false, missing: ["first_name"] });
  });

  it("removes the whole line when a copy line is empty", () => {
    const result = renderTemplate({ subject: "s", body: coldBody }, { ...values, persona_line: undefined });
    expect(result.ok && result.body.includes("persona")).toBe(false);
    expect(result.ok && !result.body.includes("\n\n\n")).toBe(true);
  });

  it("reads attributes and marks drafts that use fetched site text for individual review", () => {
    const body = "Hi {{first_name}}, about {{attributes.stack}}.\n{{company_context}}";
    const result = renderTemplate({ subject: "s", body }, { first_name: "Dana", company_context: "We ship weekly.", attributes: { stack: "Buildkite" } });
    expect(result).toMatchObject({ ok: true, perDraftReview: true });
    expect(result.ok && result.body).toContain("about Buildkite.");
  });
});
