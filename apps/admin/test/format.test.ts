// GTM-agents: tests for the dashboard's formatting and URL checks, plus a scan that keeps raw HTML
// sinks out of the source and the strict content security policy in the page.
import { describe, expect, it } from "vitest";
import indexHtml from "../index.html?raw";
import { formatCents, formatNumber, formatRate, formatRelative, humanizeKey, isoDay, safeHttpsUrl, shortDigest } from "../src/format.ts";

describe("safeHttpsUrl", () => {
  it("accepts https URLs and normalizes them", () => {
    expect(safeHttpsUrl("https://acme.example/pricing")).toBe("https://acme.example/pricing");
    expect(safeHttpsUrl("HTTPS://Acme.example")).toBe("https://acme.example/");
  });

  it.each([
    ["javascript:alert(1)"],
    ["JaVaScRiPt:alert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    ["http://acme.example"],
    ["//acme.example"],
    ["https://user:secret@acme.example"],
    ["https://acme.example/\njavascript:alert(1)"],
    ["https://acme.example/ space"],
    ["https:\\\\acme.example"],
    [" https://acme.example"],
    ["https://"],
    [""],
  ])("refuses %j", (value) => {
    expect(safeHttpsUrl(value)).toBeNull();
  });

  it("refuses values that are not strings", () => {
    expect(safeHttpsUrl(null)).toBeNull();
    expect(safeHttpsUrl({ href: "https://acme.example" })).toBeNull();
  });
});

describe("formatting", () => {
  it("never turns a missing value into zero", () => {
    expect(formatRate(null)).toBe("n/a");
    expect(formatNumber(null)).toBe("none");
    expect(formatCents(undefined)).toBe("none");
  });

  it("formats rates, cents and numbers", () => {
    expect(formatRate(0.125)).toBe("12.5%");
    expect(formatCents(1234)).toBe("$12.34");
    expect(formatNumber(1234567)).toBe("1,234,567");
  });

  it("formats relative times", () => {
    const now = Date.parse("2026-01-05T12:00:00Z");
    expect(formatRelative("2026-01-05T11:58:00Z", now)).toBe("2m ago");
    expect(formatRelative("2026-01-03T12:00:00Z", now)).toBe("2d ago");
    expect(formatRelative("not a date", now)).toBe("not a date");
  });

  it("humanizes keys and shortens digests", () => {
    expect(humanizeKey("coldPause")).toBe("Cold pause");
    expect(humanizeKey("sent_7d")).toBe("Sent 7d");
    expect(shortDigest("0123456789abcdef")).toBe("0123456789ab...");
    expect(isoDay(new Date("2026-01-08T09:00:00Z"), 7)).toBe("2026-01-01");
  });
});

describe("page hygiene", () => {
  const sources = import.meta.glob<string>("../src/**/*.ts", { query: "?raw", import: "default", eager: true });

  it("scans the source", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
  });

  it.each(Object.entries(sources))("%s has no raw HTML sink and no inline style", (_path, text) => {
    expect(text).not.toMatch(/unsafeHTML|unsafeSVG|unsafeStatic|innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/);
    expect(text).not.toMatch(/\sstyle=/);
  });

  it("serves a strict content security policy and no inline script", () => {
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(indexHtml)?.[1] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/connect-src 'self'(;|$)/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(indexHtml).not.toMatch(/\sstyle=/);
  });
});
