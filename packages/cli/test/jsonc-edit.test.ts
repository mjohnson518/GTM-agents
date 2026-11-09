// GTM-agents: tests for surgical JSONC edits: string spans are found by path, and a replacement
// changes those bytes only, keeping comments, spacing and trailing commas.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../src/lib/jsonc.ts";
import { pathKey, replaceStrings, stringSpans } from "../src/lib/jsonc-edit.ts";
import { REPO_ROOT } from "./helpers.ts";

describe("stringSpans", () => {
  it("finds every string value by path, skipping keys, comments and strings that look like comments", () => {
    const text = `// header "not": "a value"\n{\n  /* "x": "y" */ "a": "one", // trailing\n  "list": ["two", 3, { "deep": "three" },],\n  "url": "https://acme.example/a//b",\n  "q": "say \\"hi\\"",\n}\n`;
    const spans = stringSpans(text);
    expect(spans.map((s) => [pathKey(s.path), s.value])).toEqual([
      ["a", "one"],
      ["list[0]", "two"],
      ["list[2].deep", "three"],
      ["url", "https://acme.example/a//b"],
      ["q", 'say "hi"'],
    ]);
    for (const s of spans) expect(JSON.parse(text.slice(s.start, s.end))).toBe(s.value);
  });

  it("rejects malformed input", () => {
    expect(() => stringSpans('{ "a": "unterminated }')).toThrow();
    expect(() => stringSpans('{ "a" "b" }')).toThrow();
    expect(() => stringSpans('{ "a": 1 } extra')).toThrow();
  });
});

describe("replaceStrings", () => {
  it("replaces only the chosen values in the worker template and keeps every other byte", () => {
    const text = readFileSync(join(REPO_ROOT, "apps/worker/wrangler.jsonc"), "utf8");
    const spans = stringSpans(text);
    const id = spans.find((s) => pathKey(s.path) === "d1_databases[0].database_id");
    const queue = spans.filter((s) => s.value === "${EVENTS_QUEUE_NAME}");
    expect(id).toBeDefined();
    expect(queue).toHaveLength(2);
    const next = replaceStrings(text, [
      { start: id?.start ?? 0, end: id?.end ?? 0, value: "db-id-example" },
      ...queue.map((s) => ({ start: s.start, end: s.end, value: "acme-gtm-events" })),
    ]);
    const config = parseJsonc(next) as { d1_databases: Array<{ database_id: string }>; env: { staging: { d1_databases: Array<{ database_id: string }> } } };
    expect(config.d1_databases[0]?.database_id).toBe("db-id-example");
    expect(config.env.staging.d1_databases[0]?.database_id).toBe("${STAGING_DB_ID}");
    expect(next.replace("db-id-example", "${DB_ID}").replaceAll("acme-gtm-events", "${EVENTS_QUEUE_NAME}")).toBe(text);
  });

  it("refuses overlapping replacements", () => {
    expect(() => replaceStrings('{"a": "b"}', [{ start: 6, end: 9, value: "x" }, { start: 7, end: 9, value: "y" }])).toThrow(/overlapping/);
  });
});
