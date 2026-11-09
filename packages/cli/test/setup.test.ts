// GTM-agents: tests for `gtm setup`: it plans from the placeholders, reuses resources that exist,
// asks before creating, writes ids surgically, is idempotent, and lists missing secrets by name.
import { lstatSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setupCommand } from "../src/commands/setup.ts";
import { parseJsonc } from "../src/lib/jsonc.ts";
import { placeholderPaths } from "../src/lib/wrangler-config.ts";
import { ADAPTERS_DIR, makeDeployment } from "./deployment.ts";
import { FakeAccount } from "./fake-wrangler.ts";
import { captureIo } from "./helpers.ts";

type Config = Record<string, unknown> & { env: Record<string, Record<string, unknown>> };

const read = (dir: string) => readFileSync(join(dir, "wrangler.jsonc"), "utf8");
const parse = (text: string) => parseJsonc(text) as Config;
const creates = (account: FakeAccount) => account.calls.filter((c) => c.args.includes("create")).map((c) => c.args.slice(0, 3).join(" ") + (c.args[0] === "kv" ? ` ${c.args[3] ?? ""}` : ""));

async function setup(dir: string, account: FakeAccount, args: string[] = ["--yes"], confirm?: (q: string) => Promise<boolean>) {
  const io = captureIo(dir);
  if (confirm) io.confirm = confirm;
  const code = await setupCommand(args, io, { runner: account.runner, adaptersDir: ADAPTERS_DIR });
  return { code, io, text: io.text() };
}

describe("gtm setup", () => {
  it("creates every missing production resource, fills wrangler.jsonc surgically, and leaves staging alone", async () => {
    const dir = makeDeployment();
    const before = read(dir);
    const account = new FakeAccount();
    const { code, text } = await setup(dir, account, ["--yes", "--base-url", "https://agent.acme.example"]);
    expect(code).toBe(0);
    expect(creates(account)).toEqual([
      "d1 create acme-gtm-db",
      "kv namespace create acme-gtm-kv",
      "r2 bucket create",
      "vectorize create acme-gtm-memory",
      "queues create acme-gtm-events",
      "queues create acme-gtm-chat",
      "queues create acme-gtm-jobs",
      "queues create acme-gtm-events-dlq",
      "queues create acme-gtm-jobs-dlq",
    ]);
    // Wrangler is never allowed to edit the config itself, and KV titles are not prefixed with an env.
    for (const c of account.calls.filter((c) => c.args.includes("create") && c.args[0] !== "queues")) expect(c.args).toContain("--update-config=false");
    expect(account.callsTo("kv", "namespace", "create")[0]?.args).not.toContain("--env");
    expect(account.callsTo("vectorize", "create")[0]?.args).toEqual(expect.arrayContaining(["--dimensions=1536", "--metric=cosine"]));

    const after = read(dir);
    const config = parse(after);
    expect(placeholderPaths(Object.fromEntries(Object.entries(config).filter(([k]) => k !== "env")))).toEqual([]);
    const d1 = (config.d1_databases as Array<Record<string, string>>)[0];
    expect(d1?.database_name).toBe("acme-gtm-db");
    expect(d1?.database_id).toBe(account.d1.get("acme-gtm-db"));
    expect((config.kv_namespaces as Array<Record<string, string>>)[0]?.id).toBe(account.kvNamespaces.get("acme-gtm-kv"));
    expect((config.vars as Record<string, string>).AGENT_BASE_URL).toBe("https://agent.acme.example");
    const queues = config.queues as { producers: Array<Record<string, string>>; consumers: Array<Record<string, string>> };
    expect(queues.producers.map((p) => p.queue)).toEqual(["acme-gtm-events", "acme-gtm-chat", "acme-gtm-jobs"]);
    expect(queues.consumers[0]).toMatchObject({ queue: "acme-gtm-events", dead_letter_queue: "acme-gtm-events-dlq" });
    // The jobs queue, its dead-letter queue and the dead-letter queue's own consumer share two names.
    expect(queues.consumers.slice(2).map((c) => [c.queue, c.dead_letter_queue])).toEqual([
      ["acme-gtm-jobs", "acme-gtm-jobs-dlq"],
      ["acme-gtm-jobs-dlq", undefined],
    ]);

    // Staging keeps its placeholders, and every comment and line outside the filled values is untouched.
    expect(placeholderPaths(config.env.staging)).not.toEqual([]);
    expect(after).toContain("// GTM-agents: Worker configuration template.");
    const changed = before.split("\n").map((line, i) => [line, after.split("\n")[i]] as const).filter(([a, b]) => a !== b);
    expect(before.split("\n")).toHaveLength(after.split("\n").length);
    for (const [line] of changed) expect(line).toContain("${");

    expect(text).toContain("The chat queue is acme-gtm-chat");
    expect(text).toContain("The jobs queue is acme-gtm-jobs, with dead-letter queue acme-gtm-jobs-dlq; list them in scheduler.jobsQueue and scheduler.deadLetterQueue");
    expect(text).toContain("npx wrangler secret put UNSUBSCRIBE_SIGNING_KEY");
    expect(text).toContain("npx wrangler secret put EXAMPLE_EMAIL_KEY");
  });

  it("plans nothing on a second run", async () => {
    const dir = makeDeployment();
    const account = new FakeAccount();
    expect((await setup(dir, account)).code).toBe(0);
    const once = read(dir);
    account.calls = [];
    const second = await setup(dir, account);
    expect(second.code).toBe(0);
    expect(second.text).toContain("Nothing to do");
    expect(creates(account)).toEqual([]);
    expect(read(dir)).toBe(once);
  });

  it("refuses to adopt a resource wrangler.jsonc does not name yet unless told to, since it may belong to another deployment", async () => {
    const dir = makeDeployment();
    const before = read(dir);
    const account = new FakeAccount();
    account.d1.set("acme-gtm-db", "other-deployment-db");
    const { code, text } = await setup(dir, account);
    expect(code).toBe(1);
    expect(text).toContain("rerun with --reuse-existing");
    expect(creates(account)).toEqual([]);
    expect(read(dir)).toBe(before);
  });

  it("refuses an existing Vectorize index whose dimensions differ from the ones asked for", async () => {
    const dir = makeDeployment();
    const account = new FakeAccount();
    account.indexes.set("acme-gtm-memory", 768);
    const { code, text } = await setup(dir, account, ["--yes", "--reuse-existing"]);
    expect(code).toBe(1);
    expect(text).toContain("768 dimensions");
    expect(creates(account)).toEqual([]);
    expect((await setup(dir, account, ["--yes", "--reuse-existing", "--vector-dimensions", "768"])).code).toBe(0);
  });

  it("writes through a symlinked wrangler.jsonc to the real file", async () => {
    const dir = makeDeployment();
    const real = join(dir, "real-wrangler.jsonc");
    renameSync(join(dir, "wrangler.jsonc"), real);
    symlinkSync(real, join(dir, "wrangler.jsonc"));
    const account = new FakeAccount();
    expect((await setup(dir, account)).code).toBe(0);
    expect(lstatSync(join(dir, "wrangler.jsonc")).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toContain(account.d1.get("acme-gtm-db") ?? "missing");
  });

  it("runs the deployment's own Wrangler, never one npx would download", async () => {
    const dir = makeDeployment();
    const seen: string[][] = [];
    const account = new FakeAccount();
    await setupCommand(["--yes"], captureIo(dir), {
      runner: (command, args, options) => {
        seen.push([command, ...args.slice(0, 2)]);
        return account.runner(command, args, options);
      },
      adaptersDir: ADAPTERS_DIR,
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s).toEqual(["npx", "--no-install", "wrangler"]);
  });

  it("reuses resources that already exist under the derived names instead of creating duplicates", async () => {
    const dir = makeDeployment();
    const account = new FakeAccount();
    account.d1.set("acme-gtm-db", "existing-db-id");
    account.kvNamespaces.set("acme-gtm-kv", "e".repeat(32));
    account.queues.add("acme-gtm-events");
    account.buckets.add("acme-gtm-bucket");
    const { code, text } = await setup(dir, account, ["--yes", "--reuse-existing"]);
    expect(code).toBe(0);
    expect(text).toMatch(/reuse\s+D1 database\s+acme-gtm-db.*already in this account/);
    expect(text).toMatch(/reuse\s+R2 bucket\s+acme-gtm-bucket \(named in wrangler\.jsonc and already in this account/);
    expect(creates(account)).toEqual(["vectorize create acme-gtm-memory", "queues create acme-gtm-chat", "queues create acme-gtm-jobs", "queues create acme-gtm-events-dlq", "queues create acme-gtm-jobs-dlq"]);
    const config = parse(read(dir));
    expect((config.d1_databases as Array<Record<string, string>>)[0]?.database_id).toBe("existing-db-id");
    expect((config.kv_namespaces as Array<Record<string, string>>)[0]?.id).toBe("e".repeat(32));
  });

  it("sets up staging in its own block, with its own names", async () => {
    const dir = makeDeployment();
    const account = new FakeAccount();
    expect((await setup(dir, account, ["--yes", "--env", "staging"])).code).toBe(0);
    expect(account.d1.has("acme-gtm-staging-db")).toBe(true);
    expect(account.queues.has("acme-gtm-staging-chat")).toBe(true);
    expect(account.queues.has("acme-gtm-staging-jobs")).toBe(true);
    expect(account.queues.has("acme-gtm-staging-jobs-dlq")).toBe(true);
    const config = parse(read(dir));
    expect(placeholderPaths(config.env.staging).filter((p) => !p.startsWith("vars"))).toEqual([]);
    expect((config.d1_databases as Array<Record<string, string>>)[0]?.database_id).toBe("${DB_ID}");
  });

  it("creates nothing and leaves the file alone when Cloudflare cannot be asked", async () => {
    const dir = makeDeployment();
    const before = read(dir);
    const account = new FakeAccount();
    account.intercept = (args) => (args[0] === "kv" && args[2] === "list" ? { code: 1, stdout: "", stderr: "X [ERROR] Authentication error [code: 10000]" } : undefined);
    const { code, text } = await setup(dir, account);
    expect(code).toBe(1);
    expect(text).toContain("could not list KV namespaces");
    expect(creates(account)).toEqual([]);
    expect(read(dir)).toBe(before);
  });

  it("asks before creating, and needs --yes when there is no terminal", async () => {
    const dir = makeDeployment();
    const account = new FakeAccount();
    const noTerminal = await setup(dir, account, []);
    expect(noTerminal.code).toBe(2);
    expect(noTerminal.text).toContain("--yes");
    const declined = await setup(dir, account, [], async () => false);
    expect(declined.code).toBe(0);
    expect(declined.text).toContain("nothing was changed");
    expect(creates(account)).toEqual([]);
    let asked = "";
    const accepted = await setup(dir, account, [], async (q) => {
      asked = q;
      return true;
    });
    expect(accepted.code).toBe(0);
    expect(asked).toMatch(/^Create 9 resource\(s\) and write \d+ value\(s\) to wrangler\.jsonc\?$/);
    expect(account.d1.size).toBe(1);
  });

  it("stops at the first failed create, keeps what was made, and finishes on the next run", async () => {
    const dir = makeDeployment();
    const account = new FakeAccount();
    account.intercept = (args) => (args[0] === "vectorize" && args[1] === "create" ? { code: 1, stdout: "", stderr: "X [ERROR] Vectorize is not enabled" } : undefined);
    const first = await setup(dir, account);
    expect(first.code).toBe(1);
    expect(first.text).toContain("could not create Vectorize index acme-gtm-memory");
    expect(account.queues.size).toBe(0);
    expect((parse(read(dir)).d1_databases as Array<Record<string, string>>)[0]?.database_id).toBe(account.d1.get("acme-gtm-db"));

    account.intercept = undefined;
    account.calls = [];
    expect((await setup(dir, account)).code).toBe(0);
    expect(creates(account)).toEqual([
      "vectorize create acme-gtm-memory",
      "queues create acme-gtm-events",
      "queues create acme-gtm-chat",
      "queues create acme-gtm-jobs",
      "queues create acme-gtm-events-dlq",
      "queues create acme-gtm-jobs-dlq",
    ]);
  });

  it("does not overwrite wrangler.jsonc when it changed while setup ran, and prints the values instead", async () => {
    const dir = makeDeployment();
    const account = new FakeAccount();
    const edited = `${read(dir)}\n// edited by hand\n`;
    account.intercept = (args) => {
      if (args[0] === "d1" && args[1] === "create") writeFileSync(join(dir, "wrangler.jsonc"), edited);
      return undefined;
    };
    const { code, text } = await setup(dir, account);
    expect(code).toBe(1);
    expect(text).toContain("changed while setup was running");
    expect(text).toContain(`d1_databases[0].database_id = ${account.d1.get("acme-gtm-db") ?? "?"}`);
    expect(read(dir)).toBe(edited);
  });

  it("rejects a base URL that is not an https origin, and an unknown environment", async () => {
    const dir = makeDeployment();
    const account = new FakeAccount();
    expect((await setup(dir, account, ["--yes", "--base-url", "http://agent.acme.example"])).code).toBe(2);
    expect((await setup(dir, account, ["--yes", "--base-url", "https://agent.acme.example/path"])).code).toBe(2);
    expect((await setup(dir, account, ["--yes", "--env", "qa"])).code).toBe(2);
    expect(account.calls).toEqual([]);
  });

  it("lists only the secrets that are still missing once the Worker exists, and never sets one", async () => {
    const dir = makeDeployment();
    const account = new FakeAccount();
    account.secrets.set("production", ["GATEWAY_TOKEN", "UNSUBSCRIBE_SIGNING_KEY"]);
    const { text } = await setup(dir, account);
    expect(text).toContain("npx wrangler secret put EXAMPLE_EMAIL_KEY");
    expect(text).not.toContain("secret put GATEWAY_TOKEN");
    expect(account.calls.some((c) => c.args[0] === "secret" && c.args[1] !== "list")).toBe(false);
  });
});
