// GTM-agents: behavior eval for operator templates. Renders every template in the example brain for
// synthetic contacts and scores the result the way a send-time gate would: no unresolved
// placeholders, no em or en dashes, word and subject bounds, a question in a cold intro, at most one
// exclamation mark, and no link except the configured booking URL. A contact missing a variable the
// template needs must be held, never filled with a guess.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SUBJECT_MAX, WORD_BOUNDS, countWords, parseTemplate, renderTemplate } from "../../packages/core/src/templates/index.ts";

const dir = resolve(import.meta.dirname, "../../examples/brains/acme/templates");
const templates = readdirSync(dir)
  .filter((f) => f.endsWith(".md") && f !== "README.md")
  .map((file) => parseTemplate(file, readFileSync(join(dir, file), "utf8")));

const BOOKING_URL = "https://acme.example/book";

const contacts = [
  { first_name: "Dana", account_name: "Globex", persona_line: "Platform teams usually feel it first." },
  { first_name: "Sam", account_name: "Initech Systems", persona_line: undefined },
].map((c) => ({ ...c, sender_name: "Avery", booking_url: BOOKING_URL, original_subject: "Flaky builds at " + c.account_name }));

describe("example templates render cleanly for every synthetic contact", () => {
  it("has the three-step sequence", () => {
    expect(templates.map((t) => t.meta?.kind).sort()).toEqual(["breakup", "cold_intro", "follow_up"]);
  });

  for (const template of templates) {
    for (const contact of contacts) {
      it(`${template.file} for ${contact.first_name}`, () => {
        const meta = template.meta;
        expect(meta).toBeDefined();
        if (!meta) return;
        const result = renderTemplate(template, contact);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const text = `${result.subject}\n${result.body}`;

        expect(text).not.toMatch(/\{\{|\}\}/);
        expect(text).not.toMatch(/[\u2013\u2014]/);
        expect(result.subject.length).toBeLessThanOrEqual(SUBJECT_MAX);
        const words = countWords(result.body);
        expect(words).toBeGreaterThanOrEqual(WORD_BOUNDS[meta.kind].min);
        expect(words).toBeLessThanOrEqual(WORD_BOUNDS[meta.kind].max);
        expect((text.match(/!/g) ?? []).length).toBeLessThanOrEqual(1);
        if (meta.kind === "cold_intro") expect(result.body).toContain("?");
        for (const link of text.match(/https?:\/\/\S+/g) ?? []) expect(link).toBe(BOOKING_URL);
        expect(result.body).toContain(`Hi ${contact.first_name},`);
      });
    }
  }

  it("holds a draft for a contact without a first name instead of guessing a greeting", () => {
    for (const template of templates) {
      const result = renderTemplate(template, { ...contacts[0], first_name: undefined });
      expect(result).toEqual({ ok: false, missing: ["first_name"] });
    }
  });
});
