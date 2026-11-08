// GTM-agents: tests for the JSONC reader used on wrangler.jsonc.
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../src/lib/jsonc.ts";

describe("parseJsonc", () => {
  it("accepts line and block comments and trailing commas", () => {
    const text = `// header\n{\n  /* block */ "a": 1, // trailing comment\n  "b": [1, 2,],\n}\n`;
    expect(parseJsonc(text)).toEqual({ a: 1, b: [1, 2] });
  });

  it("leaves comment-like text and commas inside strings alone", () => {
    expect(parseJsonc(`{"url": "https://acme.example/a,}", "c": "/* not a comment */"}`)).toEqual({ url: "https://acme.example/a,}", c: "/* not a comment */" });
  });

  it("keeps escaped quotes inside strings", () => {
    expect(parseJsonc(String.raw`{"q": "say \"hi\" // still a string"}`)).toEqual({ q: 'say "hi" // still a string' });
  });

  it("rejects malformed input", () => {
    expect(() => parseJsonc("{ /* never closed ")).toThrow();
    expect(() => parseJsonc('{ "a": 1 "b": 2 }')).toThrow();
  });
});
