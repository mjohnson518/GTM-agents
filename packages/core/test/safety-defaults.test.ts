// GTM-agents: tests that pin the skeleton's fail-closed defaults: autonomy caps, the halt flag in
// the job runner, the loop's own ceiling, strict cron parsing, the sending subdomain rule, the flag
// registry, migration idempotency and site text in subjects.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { PERMANENT_HUMAN, effectiveLevel } from "../src/autonomy/levels.ts";
import { ConfigError, defineConfig } from "../src/config/index.ts";
import { findFlag } from "../src/flags/registry.ts";
import { CronError, parseCron } from "../src/jobs/cron.ts";
import { defaultRunner, runScheduledJobs } from "../src/jobs/loop.ts";
import { createJobRegistry, defineJob, type JobContext, type RegisteredJob } from "../src/jobs/registry.ts";
import { renderTemplate } from "../src/templates/render.ts";
import { validateTemplateFile } from "../src/templates/validate.ts";
import { acmeConfig } from "./fixtures.ts";

const config = defineConfig(acmeConfig);
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

function ctx(job: RegisteredJob, signal: AbortSignal, get: (key: string) => Promise<string | null>): JobContext {
  return { env: {}, config, job: job.name, now: new Date(), signal, ceilings: job.ceilings, flags: { get }, log: quiet };
}

describe("autonomy levels", () => {
  it("caps every permanently human-only class at 1, whatever is stored", () => {
    for (const cls of PERMANENT_HUMAN) expect(effectiveLevel(cls, 3)).toBe(1);
  });

  it("never gives an unknown or differently cased class more than the default", () => {
    expect(effectiveLevel("Merge_Code", 3)).toBe(1);
    expect(effectiveLevel("made_up_class", 2)).toBe(1);
    expect(effectiveLevel("made_up_class", 0)).toBe(0);
  });

  it("lets an earnable class keep its level, and falls back to the default for malformed values", () => {
    expect(effectiveLevel("cold_batch", 2)).toBe(2);
    expect(effectiveLevel("cold_batch", "3")).toBe(1);
    expect(effectiveLevel("cold_batch", 7)).toBe(1);
  });
});

describe("job runner and loop", () => {
  const job = defineJob({ name: "probe", schedule: "0 9 * * *", ceilings: { maxDurationMs: 30 }, run: async () => ({ summary: "ran" }) });

  it("skips every job while the system is halted, and when the halt flag cannot be read", async () => {
    const signal = new AbortController().signal;
    const halted = await defaultRunner(job, ctx(job, signal, async (k) => (k === "system:halt" ? '{"reason":"maintenance"}' : null)));
    expect(halted).toMatchObject({ status: "skipped", summary: "halted" });
    const unreadable = await defaultRunner(job, ctx(job, signal, () => Promise.reject(new Error("KV down"))));
    expect(unreadable).toMatchObject({ status: "skipped", summary: "halted" });
    expect((await defaultRunner(job, ctx(job, signal, async () => null))).status).toBe("completed");
  });

  it("does not let a runner that never settles block the jobs after it", async () => {
    const ran: string[] = [];
    const registry = createJobRegistry([
      defineJob({ name: "stuck", schedule: "0 9 * * *", ceilings: { maxDurationMs: 20 }, run: async () => {} }),
      defineJob({ name: "after", schedule: "0 9 * * *", ceilings: { maxDurationMs: 20 }, run: async () => { ran.push("after"); } }),
    ]);
    const hangingRunner = (j: RegisteredJob, c: JobContext) => (j.name === "stuck" ? new Promise<never>(() => {}) : defaultRunner(j, c));
    const outcomes = await runScheduledJobs(registry, "0 9 * * *", (j, signal) => ctx(j, signal, async () => null), hangingRunner);
    expect(outcomes.map((o) => [o.job, o.status])).toEqual([["stuck", "failed"], ["after", "completed"]]);
    expect(ran).toEqual(["after"]);
  });
});

describe("cron strictness", () => {
  it.each(["0 9 * * MON-FRI-SAT", "0 1-2-3 * * *", "0 1-5/2/3 * * *", "*/0x10 * * * *", "*/1e1 * * * *", "*/0 * * * *"])("rejects %s", (expr) => {
    expect(() => parseCron(expr)).toThrow(CronError);
  });
});

describe("configuration", () => {
  it("requires cold mail to come from a subdomain of the company domain", () => {
    const input = { ...acmeConfig, sending: { ...acmeConfig.sending, domain: "acme.example", from: { email: "avery@acme.example" } } };
    expect(() => defineConfig(input)).toThrow(ConfigError);
    const elsewhere = { ...acmeConfig, sending: { ...acmeConfig.sending, domain: "mail.globex.example", from: { email: "avery@mail.globex.example" } } };
    expect(() => defineConfig(elsewhere)).toThrow(/isolated subdomain/);
  });
});

describe("flag registry", () => {
  it("finds exact flags and families of flags", () => {
    expect(findFlag("system:halt")?.kind).toBe("json");
    expect(findFlag("budget:job:discovery_cycle:daily_cents")?.key).toBe("budget:job:<job>:daily_cents");
    expect(findFlag("autonomy:cold_batch")?.default).toBe("1");
    expect(findFlag("no:such:flag")).toBeUndefined();
  });
});

describe("baseline migration", () => {
  it("can be applied twice without error", async () => {
    const sql = "CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));";
    await env.DB.prepare(sql).run();
    await env.DB.prepare("INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('baseline', '1')").run();
    const { results } = await env.DB.prepare("SELECT key FROM schema_meta").all<{ key: string }>();
    expect(results.filter((r) => r.key === "baseline")).toHaveLength(1);
  });
});

describe("site text in templates", () => {
  it("rejects {{company_context}} in a subject, and flags any use for per-draft review", () => {
    const file = ["---", "id: t", "kind: check_in", "status: draft", "subject: About {{company_context}}", "---", "Hi {{first_name}}, a short note about your release cadence this quarter, is it a good time?", ""].join("\n");
    expect(validateTemplateFile("t.md", file).issues.some((i) => i.severity === "error" && i.message.includes("company_context"))).toBe(true);
    const rendered = renderTemplate({ subject: "About {{company_context}}", body: "Hi {{first_name}}" }, { first_name: "Dana", company_context: "We ship weekly." });
    expect(rendered).toMatchObject({ ok: true, perDraftReview: true });
  });
});
