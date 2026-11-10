// GTM-agents: tests for `gtm brain upload` and `gtm brain diff`: validation first, the runtime's own
// KV keys, files before locks in separate calls, temp files removed, and a result the runtime
// loaders actually serve.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRAIN_LOCK_KEY, loadBrain } from "@gtm-agents/core/brain";
import { TEMPLATES_LOCK_KEY, loadTemplates } from "@gtm-agents/core/templates";
import { describe, expect, it } from "vitest";
import { brainCommand } from "../src/commands/brain.ts";
import { setUpDeployment } from "./deployment.ts";
import { FakeAccount } from "./fake-wrangler.ts";
import { captureIo } from "./helpers.ts";

async function brain(dir: string, account: FakeAccount, args: string[]) {
  const io = captureIo(dir);
  const code = await brainCommand(args, io, { runner: account.runner });
  return { code, text: io.text() };
}

const kvReader = (store: Map<string, string>) => ({ get: async (key: string) => store.get(key) ?? null });

describe("gtm brain upload", () => {
  it("writes the approved files first and the locks last, under the keys the runtime reads", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account, { brain: true });
    const { code, text } = await brain(dir, account, ["upload", "--yes"]);
    expect(code).toBe(0);
    expect(text).toMatch(/uploaded brain version [0-9a-f]{12} \(14 component\(s\)\) and 10 approved template\(s\)/);

    const puts = account.callsTo("kv", "bulk", "put");
    expect(puts).toHaveLength(2);
    const keysOf = (i: number) => (puts[i]?.file as Array<{ key: string }>).map((e) => e.key);
    expect(keysOf(0).every((k) => k.startsWith("brain:file:") || k.startsWith("template:file:"))).toBe(true);
    expect(keysOf(0)).toEqual(expect.arrayContaining(["brain:file:icp", "brain:file:personas", "template:file:cold-intro", "template:file:follow-up", "template:file:breakup"]));
    expect(keysOf(1)).toEqual([BRAIN_LOCK_KEY, TEMPLATES_LOCK_KEY]);
    for (const p of puts) {
      expect(p.args).toEqual(expect.arrayContaining(["--binding", "KV", "--remote"]));
      expect(existsSync(p.filePath ?? "")).toBe(false);
    }

    // The uploaded lock is the reviewed one on disk, and the runtime serves what was uploaded.
    const store = account.store();
    expect(JSON.parse(store.get(BRAIN_LOCK_KEY) ?? "{}")).toEqual(JSON.parse(readFileSync(join(dir, "brain/brain.lock.json"), "utf8")));
    const slice = await loadBrain({ KV: kvReader(store) }, "outreach");
    expect(slice.missing).toEqual([]);
    expect(slice.included.length).toBeGreaterThan(0);
    const templates = await loadTemplates(kvReader(store), { companyDomain: "acme.example" });
    expect(templates.templates.map((t) => t.id).sort()).toEqual(["breakup", "cold-intro", "follow-up", "lifecycle-at-risk", "lifecycle-first-use", "lifecycle-last-first-use", "lifecycle-reengage", "lifecycle-upgrade-offer", "lifecycle-usefulness", "lifecycle-win-back"]);
    expect(templates.skipped).toEqual([]);
  });

  it("uploads nothing when a file changed after it was locked", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account, { brain: true });
    const facts = join(dir, "brain/facts.md");
    writeFileSync(facts, readFileSync(facts, "utf8").replace("under an hour", "in minutes"));
    const { code, text } = await brain(dir, account, ["upload", "--yes"]);
    expect(code).toBe(1);
    expect(text).toContain("facts.md changed since it was locked");
    expect(account.calls).toEqual([]);
  });

  it("never writes the locks when writing the files fails", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account, { brain: true });
    account.intercept = (args) => (args[0] === "kv" && args[2] === "put" ? { code: 1, stdout: "", stderr: "X [ERROR] A request to the Cloudflare API failed. [code: 10013]" } : undefined);
    const { code, text } = await brain(dir, account, ["upload", "--yes"]);
    expect(code).toBe(1);
    expect(text).toContain("The locks were not written");
    expect(account.callsTo("kv", "bulk", "put")).toHaveLength(1);
    expect(account.store().has(BRAIN_LOCK_KEY)).toBe(false);
  });

  it("with --dry-run, lists the keys and calls nothing", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account, { brain: true });
    const { code, text } = await brain(dir, account, ["upload", "--dry-run"]);
    expect(code).toBe(0);
    expect(text).toContain("brain:file:icp");
    expect(text).toContain("templates:lock");
    expect(account.calls).toEqual([]);
  });
});

describe("gtm brain upload confirmation", () => {
  it("asks before uploading to production, and needs --yes without a terminal", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account, { brain: true });
    const { code, text } = await brain(dir, account, ["upload"]);
    expect(code).toBe(2);
    expect(text).toContain("--yes");
    expect(account.callsTo("kv", "bulk", "put")).toEqual([]);
  });
});

describe("gtm brain diff", () => {
  it("reports what differs from KV, then in sync after an upload, then a changed template", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account, { brain: true });
    const before = await brain(dir, account, ["diff"]);
    expect(before.code).toBe(0);
    expect(before.text).toMatch(/brain: uploaded nothing, local [0-9a-f]{12}/);
    expect(before.text).toContain("new      icp.md");

    await brain(dir, account, ["upload", "--yes"]);
    const synced = await brain(dir, account, ["diff"]);
    expect(synced.text).toMatch(/brain: in sync/);
    expect(synced.text).toMatch(/templates: in sync/);

    const intro = join(dir, "templates/cold-intro.md");
    writeFileSync(intro, readFileSync(intro, "utf8").replace("loses the thread", "drops the thread"));
    const changed = await brain(dir, account, ["diff"]);
    expect(changed.text).toContain("changed  cold-intro.md");
    expect(changed.text).toMatch(/brain: in sync/);
    expect(account.callsTo("kv", "bulk", "put")).toHaveLength(2);
  });
});
