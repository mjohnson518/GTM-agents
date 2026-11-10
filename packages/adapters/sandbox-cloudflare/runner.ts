// GTM-agents: one task's sandbox, as its Durable Object runs it: start the container with internet
// access off, route its traffic through the egress entrypoint, run each build step in the
// background, report how it ended, and collect the changed files within the limits.
//
// It works against the slice of the Container API it uses (ContainerLike) and a file reader and
// writer (FilesLike), so the contract test can drive it with a fake container. index.ts gives it
// ctx.container, @cloudflare/sandbox's Files and the Durable Object's synchronous storage.
//
// Nothing secret enters the container: no environment variable, argument or file carries a
// credential, and the git host, the registries and the model API are reached only through the
// egress entrypoint, which holds the credentials in the Worker. Everything that comes out of the
// container (exit codes aside) is untrusted: the collected files are validated here, and a status
// never carries the container's own text.
import { SHIP_TASK_ID, type ChangedFile, type CodingCollectResult, type CodingStatus, type CodingStep, type CodingStepKind } from "@gtm-agents/core/ports";
import type { EgressProps } from "./egress.ts";
import { INACTIVITY_TIMEOUT_MS, ROUND_TURNS, type SandboxOptions } from "./options.ts";
import { HOME_DIR, REPO_DIR, SPEC_PATH, TASK_DIR, type AgentProfile, type Round } from "./profiles.ts";

export interface ExecHandle {
  readonly exitCode: Promise<number>;
  output(): Promise<{ stdout: ArrayBuffer; stderr: ArrayBuffer; exitCode: number }>;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdout?: "pipe" | "ignore";
  stderr?: "pipe" | "ignore" | "combined";
  signal?: AbortSignal;
}

/** The part of the Durable Object's ctx.container this runner uses. */
export interface ContainerLike {
  readonly running: boolean;
  readonly images: Record<string, string>;
  start(options: { image: string; enableInternet: boolean; instance?: string }): void;
  exec(cmd: string[], options?: ExecOptions): Promise<ExecHandle>;
  destroy(reason?: unknown): Promise<void>;
  setInactivityTimeout(durationMs: number): Promise<void>;
  interceptOutboundHttp(addr: string, binding: Fetcher): Promise<void>;
  interceptOutboundHttps(addr: string, binding: Fetcher): Promise<void>;
  interceptAllOutboundHttp(binding: Fetcher): Promise<void>;
}

/** The part of @cloudflare/sandbox's Files this runner uses. */
export interface FilesLike {
  readFile(path: string): Promise<Response>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
}

/** The Durable Object's synchronous key-value storage. */
export interface RunnerStore {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): unknown;
}

export interface RunnerDeps {
  container: ContainerLike;
  files: FilesLike;
  store: RunnerStore;
  /** The egress entrypoint, bound to one route's props. */
  egress: (props: EgressProps) => Fetcher;
  options: SandboxOptions;
  profile: AgentProfile;
  /** The deployment's coder model, or null when none is configured. */
  coderModel: string | null;
  /** The Durable Object's name when the runtime knows it; begin() records the task id either way. */
  name: string | null;
  now(): Date;
}

/** What the Durable Object exposes over RPC. */
export interface SandboxRpc {
  begin(taskId: string, stepId: string, step: CodingStep): Promise<{ accepted: boolean; reason?: string }>;
  report(): Promise<CodingStatus>;
  collect(): Promise<CodingCollectResult>;
  teardown(): Promise<void>;
}

export const STEP_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
export const RUN_SCRIPT = "/usr/local/bin/ship-run";
export const COLLECT_SCRIPT = "/usr/local/lib/ship/ship-collect.mjs";
export const CHANGES_PATH = `${TASK_DIR}/changes.json`;
export const BASE_SHA_PATH = `${TASK_DIR}/base-sha`;
/** Exit codes from `timeout`: 124 when the limit ended the command, 137 when it had to be killed. */
export const TIMEOUT_EXIT_CODES: ReadonlySet<number> = new Set([124, 137]);
const MAX_SPEC_BYTES = 64 * 1024;
const MAX_LOG_BYTES = 64 * 1024;
const LOG_TAIL_BYTES = 12 * 1024;
const OUTCOME_TAIL_BYTES = 256 * 1024;
const REPO = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const COLLECTABLE_MODES: ReadonlySet<string> = new Set(["100644", "100755", "120000"]);

// Every HTTPS request goes through an intercept, so the intercept's CA alone is the trust store.
const TRUST_ENV = Object.freeze({ NODE_EXTRA_CA_CERTS: CA_PATH, GIT_SSL_CAINFO: CA_PATH, CURL_CA_BUNDLE: CA_PATH, SSL_CERT_FILE: CA_PATH, NPM_CONFIG_CAFILE: CA_PATH });
const BASE_ENV = Object.freeze({
  HOME: HOME_DIR,
  CI: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_FUND: "false",
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
});

// The clone, then the install. Arguments arrive as positional parameters, never spliced into the script.
const PREPARE_SCRIPT = [
  'url=$1; branch=$2; shift 2',
  'git clone --depth 1 --single-branch --no-tags --branch "$branch" -- "$url" /workspace/repo',
  "cd /workspace/repo",
  "git rev-parse HEAD > /workspace/task/base-sha",
  'if [ "$#" -gt 0 ]; then "$@"; fi',
].join(" && ");
// The checks' output goes where the repair round's instruction says it is.
const CHECKS_SCRIPT = '"$@" > /workspace/task/checks.log 2>&1';

interface StepRecord {
  stepId: string;
  kind: CodingStepKind;
  startedAt: string;
  /** Set once the step is known to have ended, so later reports do not read the container again. */
  final?: CodingStatus;
}

const idle = (baseSha: string | null): CodingStatus => ({ stepId: null, kind: null, state: "idle", exitCode: null, timedOut: false, baseSha, detail: null });

function isSandboxFileMissing(error: unknown): boolean {
  return error !== null && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT";
}

async function readText(files: FilesLike, path: string, maxBytes: number): Promise<string | undefined> {
  let response: Response;
  try {
    response = await files.readFile(path);
  } catch (error) {
    if (isSandboxFileMissing(error)) return undefined;
    throw error;
  }
  if (!response.body) return "";
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RangeError("the file is larger than allowed");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function decodeBase64(data: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) return null;
  try {
    const binary = atob(data);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function safePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096) return false;
  if (path.startsWith("/") || path.includes("\\") || /[\p{Cc}]/u.test(path)) return false;
  return path.split("/").every((s) => s !== "" && s !== "." && s !== ".." && s.toLowerCase() !== ".git");
}

const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 10_000_000;
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Validates what the image's collector wrote. The container is untrusted, so every field is checked
 * here, sizes are recomputed from the content, and anything unexpected refuses the whole change. Pure.
 */
export function parseCollected(raw: string, baseSha: string, limits: { maxDiffBytes: number; maxFileBytes: number; maxFiles: number }): CodingCollectResult {
  const fail = (reason: "too_many_files" | "file_too_large" | "diff_too_large" | "invalid_output", detail: string): CodingCollectResult => ({ ok: false, reason, detail, log: "" });
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return fail("invalid_output", "the collector's output is not JSON");
  }
  if (!isRecord(doc) || doc.version !== 1 || doc.base !== baseSha || !Array.isArray(doc.files)) return fail("invalid_output", "the collector's output is not for this base commit");
  if (doc.status === "too_many_files") return fail("too_many_files", `more than ${limits.maxFiles} files changed`);
  if (doc.status === "file_too_large") return fail("file_too_large", `a file is larger than ${limits.maxFileBytes} bytes`);
  if (doc.status === "diff_too_large") return fail("diff_too_large", `the change is larger than ${limits.maxDiffBytes} bytes`);
  if (doc.status !== "ok") return fail("invalid_output", "the collector reported an unknown status");
  if (doc.files.length > limits.maxFiles) return fail("too_many_files", `more than ${limits.maxFiles} files changed`);

  const files: ChangedFile[] = [];
  const seen = new Set<string>();
  let diffBytes = 0;
  const encoder = new TextEncoder();
  for (const entry of doc.files) {
    if (!isRecord(entry) || !safePath(entry.path) || seen.has(entry.path)) return fail("invalid_output", "a path is unsafe or repeated");
    const change = entry.change;
    if (change !== "added" && change !== "modified" && change !== "deleted" && change !== "renamed") return fail("invalid_output", "a file has an unknown change type");
    if (!count(entry.additions) || !count(entry.deletions) || typeof entry.binary !== "boolean" || typeof entry.mode !== "string") return fail("invalid_output", "a file's counts or mode are malformed");
    seen.add(entry.path);
    const file: ChangedFile = { path: entry.path, change, additions: entry.additions, deletions: entry.deletions, mode: entry.mode, binary: entry.binary, content: null };
    if (change === "renamed") {
      if (!safePath(entry.previousPath) || entry.previousPath === entry.path || seen.has(entry.previousPath)) return fail("invalid_output", "a rename has no valid previous path");
      seen.add(entry.previousPath);
      file.previousPath = entry.previousPath;
    }
    if (change === "deleted") {
      if (entry.content !== null) return fail("invalid_output", "a deleted file carries content");
    } else {
      if (!COLLECTABLE_MODES.has(entry.mode)) return fail("invalid_output", "a file mode cannot be committed (submodules are refused)");
      const content = entry.content;
      if (!isRecord(content) || typeof content.data !== "string") return fail("invalid_output", "a changed file has no content");
      let size: number;
      if (content.encoding === "base64") {
        const bytes = decodeBase64(content.data);
        if (!bytes) return fail("invalid_output", "a file's base64 content does not decode");
        size = bytes.byteLength;
      } else if (content.encoding === "utf-8" && !entry.binary) {
        size = encoder.encode(content.data).byteLength;
      } else {
        return fail("invalid_output", "a file's encoding does not match its kind");
      }
      if (size > limits.maxFileBytes) return fail("file_too_large", `a file is larger than ${limits.maxFileBytes} bytes`);
      diffBytes += size;
      if (diffBytes > limits.maxDiffBytes) return fail("diff_too_large", `the change is larger than ${limits.maxDiffBytes} bytes`);
      file.content = { encoding: content.encoding, data: content.data };
    }
    files.push(file);
  }
  return { ok: true, files, diffBytes, log: "" };
}

export class SandboxRunner implements SandboxRpc {
  readonly #d: RunnerDeps;

  constructor(deps: RunnerDeps) {
    this.#d = deps;
  }

  #stepDir(stepId: string): string {
    return `${TASK_DIR}/steps/${stepId}`;
  }

  /** The task this sandbox belongs to: recorded by the first begin(), so egress props always name it. */
  #taskId(): string {
    return this.#d.store.get<string>("taskId") ?? this.#d.name ?? "";
  }

  #baseSha(): string | null {
    const sha = this.#d.store.get<string>("baseSha");
    return typeof sha === "string" && SHA.test(sha) ? sha : null;
  }

  /**
   * Routes every outbound request. Specific hostnames first, then a catch-all for HTTP and HTTPS
   * that denies, because a hostname registered after a catch-all would never be reached. Registering
   * a target again replaces its handler, which is how the git route is closed after the clone.
   */
  async #intercept(repo: string): Promise<void> {
    const { container, egress, options } = this.#d;
    const taskId = this.#taskId();
    const deny = (host: string) => egress({ route: "deny", taskId, host });
    await container.interceptOutboundHttps(options.gitHost, egress({ route: "git", taskId, host: options.gitHost, repo }));
    for (const host of options.registryHosts) await container.interceptOutboundHttps(host, egress({ route: "registry", taskId, host }));
    await container.interceptOutboundHttps(options.model.host, egress({ route: "model", taskId, host: options.model.host }));
    await container.interceptAllOutboundHttp(deny("*"));
    await container.interceptOutboundHttps("*", deny("*"));
  }

  async #launch(stepId: string, limitSeconds: number, argv: string[], cwd: string, env: Record<string, string>): Promise<void> {
    await this.#d.files.mkdir(this.#stepDir(stepId), { recursive: true });
    // ship-run returns at once and runs the command in its own session, writing its process id,
    // its output and finally its exit code into the step's directory.
    await this.#d.container.exec(["/bin/sh", RUN_SCRIPT, this.#stepDir(stepId), String(limitSeconds), ...argv], {
      cwd,
      env: { ...BASE_ENV, ...TRUST_ENV, ...env },
      stdout: "ignore",
      stderr: "ignore",
    });
  }

  async begin(taskId: string, stepId: string, step: CodingStep): Promise<{ accepted: boolean; reason?: string }> {
    const { container, files, store, options, profile } = this.#d;
    if (!SHIP_TASK_ID.test(taskId) || (this.#d.name !== null && this.#d.name !== taskId)) return { accepted: false, reason: "this sandbox belongs to another task" };
    const recorded = store.get<string>("taskId");
    if (recorded !== undefined && recorded !== taskId) return { accepted: false, reason: "this sandbox belongs to another task" };
    store.put("taskId", taskId);
    if (!STEP_ID.test(stepId)) return { accepted: false, reason: "the step id is malformed" };
    const current = store.get<StepRecord>("step");
    if (current?.stepId === stepId) return { accepted: true, reason: "already started" };
    if (current && (await this.report()).state === "running") return { accepted: false, reason: "busy" };

    if (step.kind === "prepare") {
      const repo = typeof step.repo === "string" ? step.repo.trim().toLowerCase() : "";
      if (!REPO.test(repo) || !BRANCH.test(step.baseBranch)) return { accepted: false, reason: "the repository or branch is malformed" };
      const install: readonly unknown[] = step.install ?? [];
      if (!Array.isArray(install) || install.length > 50 || !install.every((a): a is string => typeof a === "string" && a.length <= 1000)) return { accepted: false, reason: "the install command is malformed" };
      const image = container.images[profile.image];
      if (!image) return { accepted: false, reason: `the image ${profile.image} is not configured for this container` };
      // A fresh container for every build: whatever ran before is discarded.
      if (container.running) await container.destroy("a new build is starting");
      store.delete("baseSha");
      store.put("turns", 0);
      // HTTPS intercepts go in before start, so the CA file exists when the container boots.
      await this.#intercept(repo);
      container.start({ image, enableInternet: false, instance: options.instance });
      try {
        await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
        await files.mkdir(TASK_DIR, { recursive: true });
        await files.mkdir(HOME_DIR, { recursive: true });
        await this.#launch(stepId, options.timeouts.prepare, ["/bin/sh", "-c", PREPARE_SCRIPT, "ship-prepare", `https://${options.gitHost}/${repo}.git`, step.baseBranch, ...install], "/workspace", {});
      } catch (error) {
        await container.destroy("the sandbox could not be set up");
        throw error;
      }
    } else {
      if (!container.running) return { accepted: false, reason: "the sandbox is not running" };
      if (!this.#baseSha()) return { accepted: false, reason: "the sandbox has not been prepared" };
      // The clone is done: the git host is closed for everything that follows. Only its handler is
      // replaced; the other intercepts stay as the prepare step registered them.
      await container.interceptOutboundHttps(options.gitHost, this.#d.egress({ route: "deny", taskId, host: options.gitHost }));
      await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      if (step.kind === "checks") {
        const command: readonly unknown[] = step.command;
        if (!Array.isArray(command) || command.length === 0 || command.length > 50 || !command.every((a): a is string => typeof a === "string" && a.length > 0 && a.length <= 1000)) {
          return { accepted: false, reason: "the checks command is malformed" };
        }
        await this.#launch(stepId, options.timeouts.checks, ["/bin/sh", "-c", CHECKS_SCRIPT, "ship-checks", ...command], REPO_DIR, {});
      } else {
        if (!this.#d.coderModel) return { accepted: false, reason: "no coder model is configured" };
        if (typeof step.spec !== "string" || new TextEncoder().encode(step.spec).byteLength > MAX_SPEC_BYTES) return { accepted: false, reason: "the spec is missing or too large" };
        try {
          if (!isRecord(JSON.parse(step.spec))) return { accepted: false, reason: "the spec is not a JSON object" };
        } catch {
          return { accepted: false, reason: "the spec is not JSON" };
        }
        const round: Round = step.kind;
        const args = { round, model: this.#d.coderModel, maxTurns: Math.min(ROUND_TURNS[round], options.limits.maxModelTurns), route: options.model };
        await files.writeFile(SPEC_PATH, step.spec);
        for (const file of profile.configFiles(args)) {
          await files.mkdir(file.path.slice(0, file.path.lastIndexOf("/")), { recursive: true });
          await files.writeFile(file.path, file.content);
        }
        await this.#launch(stepId, options.timeouts.agent, profile.command(args), REPO_DIR, profile.env(args));
      }
    }
    store.put<StepRecord>("step", { stepId, kind: step.kind, startedAt: this.#d.now().toISOString() });
    return { accepted: true };
  }

  async #running(stepDir: string): Promise<boolean> {
    // Alive, and started in this container: a process id from an earlier container does not count.
    const probe = await this.#d.container.exec(["/bin/sh", "-c", 'read -r pid boot < "$1" && [ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ] && kill -0 "$pid"', "probe", `${stepDir}/pid`], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await probe.exitCode) === 0;
  }

  async report(): Promise<CodingStatus> {
    const { container, files, store, profile } = this.#d;
    const record = store.get<StepRecord>("step");
    const baseSha = this.#baseSha();
    if (!record) return idle(baseSha);
    if (record.final) return { ...record.final, baseSha: this.#baseSha() };
    const base = { stepId: record.stepId, kind: record.kind, baseSha };
    if (!container.running) return this.#finish(record, { ...base, state: "lost", exitCode: null, timedOut: false, detail: "the container stopped before the step ended" });
    const dir = this.#stepDir(record.stepId);
    let exit = await readText(files, `${dir}/exit-code`, 64);
    if (exit === undefined) {
      if (await this.#running(dir)) return { ...base, state: "running", exitCode: null, timedOut: false, detail: null };
      // The step can end between the two reads.
      exit = await readText(files, `${dir}/exit-code`, 64);
      if (exit === undefined) {
        const pid = await readText(files, `${dir}/pid`, 256);
        // ship-run writes the process id as its first act; a moment before that, the step is starting.
        if (pid === undefined && this.#d.now().getTime() - Date.parse(record.startedAt) < 60_000) return { ...base, state: "running", exitCode: null, timedOut: false, detail: null };
        return this.#finish(record, { ...base, state: "lost", exitCode: null, timedOut: false, detail: "the step ended without recording how" });
      }
    }
    const code = /^\d{1,3}$/.test(exit.trim()) ? Number(exit.trim()) : -1;
    if (code !== 0) {
      const timedOut = TIMEOUT_EXIT_CODES.has(code);
      return this.#finish(record, { ...base, state: "failed", exitCode: code, timedOut, detail: timedOut ? "the step hit its time limit" : `the step exited with ${code}` });
    }
    if (record.kind === "prepare") {
      const sha = (await readText(files, BASE_SHA_PATH, 256))?.trim() ?? "";
      if (!SHA.test(sha)) return this.#finish(record, { ...base, state: "failed", exitCode: 0, timedOut: false, detail: "the clone recorded no base commit" });
      store.put("baseSha", sha);
      return this.#finish(record, { ...base, baseSha: sha, state: "succeeded", exitCode: 0, timedOut: false, detail: null });
    }
    if (record.kind === "agent" || record.kind === "repair") {
      const tail = await this.#tail(`${dir}/stdout.log`, OUTCOME_TAIL_BYTES);
      if (profile.outcome(tail) !== "succeeded") return this.#finish(record, { ...base, state: "failed", exitCode: 0, timedOut: false, detail: "the agent reported that its run failed" });
    }
    return this.#finish(record, { ...base, state: "succeeded", exitCode: 0, timedOut: false, detail: null });
  }

  #finish(record: StepRecord, status: CodingStatus): CodingStatus {
    this.#d.store.put<StepRecord>("step", { ...record, final: status });
    return status;
  }

  async #tail(path: string, bytes: number): Promise<string> {
    try {
      const proc = await this.#d.container.exec(["tail", "-c", String(bytes), path], { stdout: "pipe", stderr: "ignore" });
      const out = await proc.output();
      return new TextDecoder().decode(out.stdout);
    } catch {
      return "";
    }
  }

  async #log(): Promise<string> {
    const parts: string[] = [];
    let listing: string;
    try {
      const proc = await this.#d.container.exec(["ls", "-1", `${TASK_DIR}/steps`], { stdout: "pipe", stderr: "ignore" });
      listing = new TextDecoder().decode((await proc.output()).stdout);
    } catch {
      return "";
    }
    for (const step of listing.split("\n").filter((s) => STEP_ID.test(s)).sort()) {
      for (const stream of ["stdout", "stderr"]) {
        const tail = await this.#tail(`${TASK_DIR}/steps/${step}/${stream}.log`, LOG_TAIL_BYTES);
        if (tail) parts.push(`== ${step} ${stream} (last ${LOG_TAIL_BYTES} bytes)\n${tail}`);
      }
    }
    const checks = await this.#tail(`${TASK_DIR}/checks.log`, LOG_TAIL_BYTES);
    if (checks) parts.push(`== checks (last ${LOG_TAIL_BYTES} bytes)\n${checks}`);
    const log = parts.join("\n");
    return log.length > MAX_LOG_BYTES ? log.slice(log.length - MAX_LOG_BYTES) : log;
  }

  async collect(): Promise<CodingCollectResult> {
    const { container, files, options } = this.#d;
    const status = await this.report();
    const baseSha = this.#baseSha();
    if (!container.running || !baseSha || status.state === "running" || status.state === "idle") return { ok: false, reason: "not_ready", detail: "no finished step to collect from", log: "" };
    const log = await this.#log();
    const controller = new AbortController();
    const proc = await container.exec(
      [
        "node",
        COLLECT_SCRIPT,
        "--repo",
        REPO_DIR,
        "--base",
        baseSha,
        "--out",
        CHANGES_PATH,
        "--max-files",
        String(options.limits.maxFiles),
        "--max-file-bytes",
        String(options.limits.maxFileBytes),
        "--max-diff-bytes",
        String(options.limits.maxDiffBytes),
      ],
      { cwd: REPO_DIR, env: { ...BASE_ENV }, stdout: "ignore", stderr: "ignore", signal: controller.signal },
    );
    const timer = setTimeout(() => controller.abort(), options.timeouts.collect * 1000);
    let exitCode: number;
    try {
      exitCode = await proc.exitCode;
    } finally {
      clearTimeout(timer);
    }
    if (exitCode !== 0) return { ok: false, reason: "invalid_output", detail: "the collector failed", log };
    // Base64 grows content by a third; the cap leaves room for that and the JSON around it.
    let raw: string | undefined;
    try {
      raw = await readText(files, CHANGES_PATH, Math.ceil(options.limits.maxDiffBytes * 1.4) + 1024 * 1024);
    } catch (error) {
      if (error instanceof RangeError) return { ok: false, reason: "diff_too_large", detail: `the change is larger than ${options.limits.maxDiffBytes} bytes`, log };
      return { ok: false, reason: "invalid_output", detail: "the collector's output could not be read", log };
    }
    if (raw === undefined) return { ok: false, reason: "invalid_output", detail: "the collector wrote nothing", log };
    const result = parseCollected(raw, baseSha, options.limits);
    return { ...result, log };
  }

  async teardown(): Promise<void> {
    const { container, store } = this.#d;
    if (container.running) await container.destroy("the build is over");
    store.delete("step");
    store.delete("baseSha");
  }

  /**
   * Counts one model request against the task's limit and holds one of its in-flight slots until
   * releaseTurn. Synchronous storage, so two calls cannot both take the last turn or the last slot.
   * A call with every slot taken is refused without using a turn: the agent retries it.
   */
  takeTurn(limit: number, maxInFlight: number, nowMs: number): ModelTurn {
    const used = this.#d.store.get<number>("turns") ?? 0;
    if (!Number.isInteger(used) || used >= limit) return { allowed: false, turns: used };
    const inFlight = liveCalls(this.#d.store.get<unknown>("inflight"), nowMs);
    if (Object.keys(inFlight).length >= maxInFlight) return { allowed: false, turns: used, busy: true };
    const ticket = crypto.randomUUID();
    inFlight[ticket] = nowMs;
    this.#d.store.put("inflight", inFlight);
    this.#d.store.put("turns", used + 1);
    return { allowed: true, turns: used + 1, ticket };
  }

  /** Frees the in-flight slot a finished model call held. Releasing twice, or an unknown ticket, does nothing. */
  releaseTurn(ticket: string, nowMs: number): void {
    const inFlight = liveCalls(this.#d.store.get<unknown>("inflight"), nowMs);
    delete inFlight[ticket];
    this.#d.store.put("inflight", inFlight);
  }
}

/** One model request's claim on a task: its turn count, and the ticket that frees its in-flight slot. */
export interface ModelTurn {
  allowed: boolean;
  turns: number;
  /** True when it was refused because the task already has its most calls in flight. */
  busy?: boolean;
  ticket?: string;
}

/** A model call in flight longer than this is treated as finished, so a release that never arrives cannot hold a slot for good. */
export const IN_FLIGHT_STALE_MS = 15 * 60 * 1000;

/** The in-flight calls, without the stale ones. Pure. */
function liveCalls(stored: unknown, nowMs: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return out;
  for (const [ticket, at] of Object.entries(stored as Record<string, unknown>)) {
    if (typeof at === "number" && Number.isFinite(at) && nowMs - at < IN_FLIGHT_STALE_MS) out[ticket] = at;
  }
  return out;
}
