// GTM-agents: the code-github adapter: the CodeHost port over the GitHub REST API, with plain fetch.
//
// It translates and decides nothing. The ship module decides what to commit, which task a webhook
// belongs to and what a production deploy is (docs/SHIP.md). Specifically:
//   - every method refuses a repository outside options.repos with a non-retryable "invalid"
//     AdapterError before any request, so the token can only ever touch the listed repositories;
//   - commit makes exactly one commit through the git data API: a blob per added or changed file,
//     one tree on the base commit's tree (deletions and the old side of a rename are tree entries
//     with a null sha), one commit whose only parent is the base commit, and the ref
//     refs/heads/ship/<task>. It is idempotent on retry: when the branch already points at a commit
//     with the same tree and the same parent, that commit is returned with created false. It never
//     moves an existing ref, never forces, and never names the base branch in a write, so a branch
//     holding anything else is refused. Submodule entries (mode 160000) are refused, and so are
//     paths that escape the repository or touch .git;
//   - openPullRequest looks for a pull request from the task's branch first and returns it with
//     created false; only when there is none does it open one, with maintainer edits off;
//   - nothing here merges. Merging code is permanently human (merge_code);
//   - verifyWebhook checks X-Hub-Signature-256 before it reads the body: an HMAC-SHA256 of the raw
//     body keyed with GITHUB_WEBHOOK_SECRET, compared in constant time. GitHub signs no timestamp
//     and no delivery id, so every event carries a digest of what was signed (the event name and the
//     HMAC of the body) for the caller to deduplicate on, along with the delivery id for logs. Mapped events: ping, pull_request, check_run, check_suite, status and
//     deployment_status; every other event, and any event for a repository outside options.repos,
//     is `ignored`. Names (check names, environments) are third-party text: they are stripped of
//     control characters and capped, and are metadata taint.
// GitHub charges nothing per API call, so no cost is recorded.
//
// Secrets: GITHUB_TOKEN (a fine-grained token, used only from the Worker, for the listed
// repositories: contents read and write, pull requests read and write, checks and commit statuses
// read; never given to a sandbox), GITHUB_WEBHOOK_SECRET (the webhook's secret).
// Options (adapters.code-github.options):
//   repos        the repositories the ship loop may touch, as owner/name. Required; empty refuses all
//   apiBaseUrl   defaults to https://api.github.com (a GitHub Enterprise Server API URL also works)
//   author       { name, email } for the commit author and committer; omitted, GitHub uses the
//                token's account
//   shipBranchCiIsolated
//                true once workflow runs for ship/ branches get no secret and no write token
//                (docs/SHIP.md, CI and the ship branch). Until then commit refuses, because pushing
//                the branch is what runs the agent's code in the repository's CI.
import { constantTimeEqual } from "@gtm-agents/core/http";
import {
  AdapterError,
  SHIP_BRANCH_PREFIX,
  shipBranch,
  type AdapterContext,
  type AdapterErrorCode,
  type ChangedFile,
  type CheckConclusion,
  type ChecksState,
  type CodeHost,
  type CodeHostEvent,
  type CommitResult,
  type PathKind,
  type DeploymentState,
  type PullRequestRef,
  type PullRequestState,
  type RepoFile,
} from "@gtm-agents/core/ports";

export const NAME = "code-github";
export const GITHUB_API = "https://api.github.com";
export const TOKEN_NAME = "GITHUB_TOKEN";
export const WEBHOOK_SECRET_NAME = "GITHUB_WEBHOOK_SECRET";
export const SIGNATURE_HEADER = "x-hub-signature-256";
export const EVENT_HEADER = "x-github-event";
export const DELIVERY_HEADER = "x-github-delivery";
export const API_VERSION = "2022-11-28";
export const WEBHOOK_MAX_BYTES = 1024 * 1024;
/** Committable file modes. 160000 (a submodule) cannot be made from content, so it is refused. */
export const COMMIT_MODES: ReadonlySet<string> = new Set(["100644", "100755", "120000"]);

const encoder = new TextEncoder();
const REPO = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const DELIVERY = /^[A-Za-z0-9-]{1,100}$/;
const EVENT = /^[a-z_]{1,50}$/;
const MAX_FILES = 1000;
const MAX_MESSAGE = 10_000;
const MAX_TITLE = 256;
const MAX_BODY = 60_000;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** One line of third-party text fit to show: control and format characters removed, capped. Pure. */
export function cleanName(value: unknown, max = 100): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** A lowercase owner/name, or null when it is not one. Pure. */
export function normalizeRepo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const repo = value.trim().toLowerCase();
  return REPO.test(repo) && !repo.endsWith(".git") ? repo : null;
}

/** True for a repository-relative path that stays inside the work tree and never touches .git. Pure. */
export function safeRepoPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096) return false;
  if (path.startsWith("/") || path.includes("\\") || /[\p{Cc}]/u.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && segment.toLowerCase() !== ".git");
}

interface GithubOptions {
  baseUrl: string;
  repos: readonly string[];
  author: { name: string; email: string } | null;
  /**
   * The deployer's statement that CI in these repositories gives no secret and no write token to
   * a workflow run for a ship/ branch (docs/SHIP.md, "CI and the ship branch"). Until it is true,
   * commit refuses: pushing the branch is what makes CI run the agent's code.
   */
  shipBranchCiIsolated: boolean;
}

/** The commit refusal while CI isolation has not been confirmed. */
export const CI_NOT_ISOLATED =
  "the ship branch is not pushed until CI is isolated: a workflow run for a ship/ branch must get no secret and no write token (docs/SHIP.md, CI and the ship branch), then set shipBranchCiIsolated: true in the code-github options";

function readOptions(raw: Record<string, unknown>): GithubOptions {
  const base = typeof raw.apiBaseUrl === "string" && /^https:\/\/[^\s/@]+(?:\/\S*)?$/.test(raw.apiBaseUrl) ? raw.apiBaseUrl.replace(/\/+$/, "") : GITHUB_API;
  const repos = Array.isArray(raw.repos) ? [...new Set(raw.repos.map(normalizeRepo).filter((r): r is string => r !== null))].sort() : [];
  let author: GithubOptions["author"] = null;
  if (isRecord(raw.author)) {
    const name = cleanName(raw.author.name, 100);
    const email = typeof raw.author.email === "string" && /^[^\s@<>]{1,64}@[^\s@<>]{1,255}$/.test(raw.author.email) ? raw.author.email : "";
    if (name && email) author = { name, email };
  }
  return { baseUrl: base, repos, author, shipBranchCiIsolated: raw.shipBranchCiIsolated === true };
}

/** Codes for an HTTP failure from the API. Pure. */
export function classifyStatus(status: number, headers?: Headers): { code: AdapterErrorCode; retryable: boolean } {
  if (status === 401) return { code: "auth", retryable: false };
  if (status === 403) {
    const limited = headers?.get("x-ratelimit-remaining") === "0" || headers?.has("retry-after") === true;
    return limited ? { code: "rate_limited", retryable: true } : { code: "auth", retryable: false };
  }
  if (status === 404) return { code: "not_found", retryable: false };
  if (status === 429) return { code: "rate_limited", retryable: true };
  if (status >= 500) return { code: "unavailable", retryable: true };
  return { code: "invalid", retryable: false };
}

function decodeBase64(data: string): Uint8Array | null {
  try {
    const binary = atob(data.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** UTF-8 text with no NUL byte, else base64. Pure. */
export function encodeContent(bytes: Uint8Array): { encoding: "utf-8" | "base64"; data: string } {
  if (!bytes.includes(0)) {
    try {
      return { encoding: "utf-8", data: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
    } catch {
      // Not UTF-8: fall through to base64.
    }
  }
  return { encoding: "base64", data: toBase64(bytes) };
}

function conclusionOf(value: unknown): CheckConclusion {
  switch (value) {
    case "success":
      return "success";
    case "failure":
    case "error":
    case "timed_out":
    case "cancelled":
    case "action_required":
    case "startup_failure":
      return "failure";
    case "neutral":
    case "skipped":
    case "stale":
      return "neutral";
    default:
      return "pending";
  }
}

function deploymentStateOf(value: unknown): DeploymentState {
  switch (value) {
    case "success":
      return "success";
    case "failure":
    case "error":
      return "failure";
    case "pending":
    case "queued":
    case "in_progress":
      return "pending";
    case "inactive":
      return "inactive";
    default:
      return "other";
  }
}

const shaOf = (v: unknown): string | null => (typeof v === "string" && SHA.test(v) ? v : null);
const prNumber = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 1e9 ? v : null);
const prNumbers = (v: unknown): number[] => (Array.isArray(v) ? v.map((p) => (isRecord(p) ? prNumber(p.number) : null)).filter((n): n is number => n !== null).slice(0, 50) : []);

/** Map a verified GitHub webhook to the port's CodeHostEvent. Throws an "invalid" AdapterError for a payload it cannot read. Pure. */
export function mapGithubEvent(event: string, deliveryId: string, payload: unknown, allowed: readonly string[]): CodeHostEvent {
  if (!isRecord(payload)) throw new AdapterError("the webhook body is not a GitHub event", "invalid", false);
  if (event === "ping") return { type: "ping", deliveryId };
  const repo = isRecord(payload.repository) ? normalizeRepo(payload.repository.full_name) : null;
  if (!repo) throw new AdapterError("the webhook names no repository", "invalid", false);
  if (!allowed.includes(repo)) return { type: "ignored", deliveryId, reason: "the repository is not in options.repos" };

  if (event === "pull_request") {
    const pr = isRecord(payload.pull_request) ? payload.pull_request : null;
    const number = prNumber(pr?.number ?? payload.number);
    const head = pr && isRecord(pr.head) ? pr.head : null;
    const base = pr && isRecord(pr.base) ? pr.base : null;
    const headSha = shaOf(head?.sha);
    const headBranch = str(head?.ref) ?? "";
    const baseBranch = str(base?.ref) ?? "";
    if (!pr || number === null || !headSha || !BRANCH.test(headBranch) || !BRANCH.test(baseBranch)) throw new AdapterError("the pull request event is missing its number, head or base", "invalid", false);
    const action = str(payload.action);
    const known = action === "opened" || action === "closed" || action === "reopened" || action === "synchronize" ? action : "other";
    const merged = pr.merged === true;
    return { type: "pull_request", deliveryId, repo, number, action: known, merged, mergeCommitSha: merged ? shaOf(pr.merge_commit_sha) : null, headSha, headBranch, baseBranch };
  }

  if (event === "check_run" || event === "check_suite") {
    const raw = payload[event];
    const check = isRecord(raw) ? raw : null;
    const headSha = shaOf(check?.head_sha);
    if (!check || !headSha) throw new AdapterError("the check event has no head commit", "invalid", false);
    const completed = check.status === "completed" || payload.action === "completed";
    const app = isRecord(check.app) ? check.app : {};
    const name = cleanName(event === "check_run" ? check.name : (app.name ?? app.slug)) || event;
    return { type: "check", deliveryId, repo, headSha, name, conclusion: completed ? conclusionOf(check.conclusion) : "pending", pullRequests: prNumbers(check.pull_requests) };
  }

  if (event === "status") {
    const headSha = shaOf(payload.sha);
    if (!headSha) throw new AdapterError("the status event has no commit", "invalid", false);
    return { type: "check", deliveryId, repo, headSha, name: cleanName(payload.context) || "status", conclusion: conclusionOf(payload.state), pullRequests: [] };
  }

  if (event === "deployment_status") {
    const deployment = isRecord(payload.deployment) ? payload.deployment : null;
    const status = isRecord(payload.deployment_status) ? payload.deployment_status : null;
    const sha = shaOf(deployment?.sha);
    if (!deployment || !status || !sha) throw new AdapterError("the deployment event has no commit", "invalid", false);
    const environment = cleanName(status.environment ?? deployment.environment, 100);
    const production = typeof deployment.production_environment === "boolean" ? deployment.production_environment : null;
    return { type: "deployment", deliveryId, repo, sha, environment, productionEnvironment: production, state: deploymentStateOf(status.state) };
  }

  return { type: "ignored", deliveryId, reason: `not handled: ${event}` };
}

/** The body as text, or null once it passes `max` bytes: a chunked body is never buffered whole. */
async function readCapped(request: Request, max: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = (request.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface TreeEntry {
  path: string;
  mode: string;
  type: "blob";
  sha: string | null;
}

/** The checks a file must pass before it is sent anywhere. Pure; throws an "invalid" AdapterError. */
export function assertCommittable(files: readonly ChangedFile[]): void {
  if (files.length === 0) throw new AdapterError("there is nothing to commit", "invalid", false);
  if (files.length > MAX_FILES) throw new AdapterError("too many files for one commit", "invalid", false);
  const seen = new Set<string>();
  for (const file of files) {
    if (!safeRepoPath(file.path)) throw new AdapterError("a path leaves the repository or touches .git", "invalid", false);
    if (seen.has(file.path)) throw new AdapterError("a path appears twice", "invalid", false);
    seen.add(file.path);
    if (file.change === "deleted") {
      if (file.content !== null) throw new AdapterError("a deleted file carries content", "invalid", false);
      continue;
    }
    if (!COMMIT_MODES.has(file.mode)) throw new AdapterError("a file mode cannot be committed (submodules and unknown modes are refused)", "invalid", false);
    if (!file.content || (file.content.encoding !== "utf-8" && file.content.encoding !== "base64")) throw new AdapterError("a changed file has no content", "invalid", false);
    if (file.content.encoding === "base64" && decodeBase64(file.content.data) === null) throw new AdapterError("a file's base64 content does not decode", "invalid", false);
    if (file.change === "renamed") {
      if (!safeRepoPath(file.previousPath) || file.previousPath === file.path) throw new AdapterError("a rename has no valid previous path", "invalid", false);
      if (seen.has(file.previousPath)) throw new AdapterError("a path appears twice", "invalid", false);
      seen.add(file.previousPath);
    }
  }
}

export function createAdapter(ctx: AdapterContext): CodeHost {
  const options = readOptions(ctx.options);

  const assertRepo = (repo: string): string => {
    const normalized = normalizeRepo(repo);
    if (!normalized || !options.repos.includes(normalized)) throw new AdapterError("the repository is not in options.repos", "invalid", false);
    return normalized;
  };

  async function api(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const token = ctx.optionalSecret(TOKEN_NAME);
    if (!token) throw new AdapterError(`${TOKEN_NAME} is not set`, "auth", false);
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": API_VERSION,
      "user-agent": "gtm-agents-code-github",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await ctx.fetch(`${options.baseUrl}${path}`, { method, headers, redirect: "manual", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch (error) {
      throw new AdapterError("the code host did not answer", "timeout", true, { cause: error });
    }
    const data = await response.json<unknown>().catch(() => null);
    if (response.status >= 300) {
      if (method === "GET" && response.status === 404) return { status: 404, data };
      if (method === "POST" && response.status === 422) return { status: 422, data };
      const { code, retryable } = classifyStatus(response.status, response.headers);
      throw new AdapterError(`the code host answered HTTP ${response.status}`, code, retryable);
    }
    return { status: response.status, data };
  }

  const repoPath = (repo: string) => `/repos/${repo}`;
  const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

  async function refHead(repo: string, branch: string): Promise<string | null> {
    const { status, data } = await api("GET", `${repoPath(repo)}/git/ref/heads/${encodePath(branch)}`);
    if (status === 404) return null;
    const sha = isRecord(data) && isRecord(data.object) ? shaOf(data.object.sha) : null;
    if (!sha) throw new AdapterError("the code host returned a ref without a commit", "unknown", false);
    return sha;
  }

  async function commitShape(repo: string, sha: string): Promise<{ tree: string; parents: string[] }> {
    const { status, data } = await api("GET", `${repoPath(repo)}/git/commits/${sha}`);
    if (status === 404) throw new AdapterError("the commit does not exist", "not_found", false);
    const tree = isRecord(data) && isRecord(data.tree) ? shaOf(data.tree.sha) : null;
    const parents = isRecord(data) && Array.isArray(data.parents) ? data.parents.map((p) => (isRecord(p) ? shaOf(p.sha) : null)) : [];
    if (!tree || parents.some((p) => p === null)) throw new AdapterError("the code host returned a commit it cannot describe", "unknown", false);
    return { tree, parents: parents as string[] };
  }

  async function existingPullRequest(repo: string, branch: string): Promise<PullRequestRef | null> {
    const owner = repo.split("/")[0] ?? "";
    const query = new URLSearchParams({ head: `${owner}:${branch}`, state: "all", per_page: "5" });
    const { data } = await api("GET", `${repoPath(repo)}/pulls?${query.toString()}`);
    const list = Array.isArray(data) ? data.filter(isRecord) : [];
    const found = list.find((pr) => isRecord(pr.head) && pr.head.ref === branch);
    if (!found) return null;
    const number = prNumber(found.number);
    const url = str(found.html_url) ?? "";
    const headSha = isRecord(found.head) ? shaOf(found.head.sha) : null;
    if (number === null || !headSha || !/^https:\/\//.test(url)) throw new AdapterError("the code host returned a pull request it cannot describe", "unknown", false);
    return { number, url, headSha, created: false };
  }

  return {
    name: NAME,

    allowedRepos: () => options.repos,

    pushRefusal: () => (options.shipBranchCiIsolated ? null : CI_NOT_ISOLATED),

    async branchHead(repo, branch) {
      const r = assertRepo(repo);
      if (!BRANCH.test(branch)) throw new AdapterError("not a branch name", "invalid", false);
      return refHead(r, branch);
    },

    async readFile(args): Promise<RepoFile | null> {
      const r = assertRepo(args.repo);
      if (!safeRepoPath(args.path)) throw new AdapterError("the path leaves the repository or touches .git", "invalid", false);
      if (!SHA.test(args.ref) && !BRANCH.test(args.ref)) throw new AdapterError("not a ref", "invalid", false);
      const { status, data } = await api("GET", `${repoPath(r)}/contents/${encodePath(args.path)}?${new URLSearchParams({ ref: args.ref }).toString()}`);
      if (status === 404) return null;
      if (Array.isArray(data)) throw new AdapterError("the path is a directory or submodule at that ref", "invalid", false);
      if (!isRecord(data)) return null;
      const size = typeof data.size === "number" && Number.isInteger(data.size) && data.size >= 0 ? data.size : -1;
      if (data.type === "symlink") {
        const target = str(data.target) ?? "";
        return { size: encoder.encode(target).length, encoding: "utf-8", data: target };
      }
      // A directory or submodule is not a file: refused, so a change can never replace one with a blob.
      if (Array.isArray(data) || data.type === "dir" || data.type === "submodule") throw new AdapterError("the path is a directory or submodule at that ref", "invalid", false);
      if (data.type !== "file" || size < 0) return null;
      if (args.maxBytes !== undefined && size > args.maxBytes) return { size, encoding: "base64", data: null };
      if (data.encoding !== "base64" || typeof data.content !== "string") return { size, encoding: "base64", data: null };
      const bytes = decodeBase64(data.content);
      if (!bytes) throw new AdapterError("the code host returned content that does not decode", "unknown", false);
      return { size: bytes.length, ...encodeContent(bytes) };
    },

    async pathKind(args): Promise<PathKind> {
      const r = assertRepo(args.repo);
      if (!safeRepoPath(args.path)) throw new AdapterError("the path leaves the repository or touches .git", "invalid", false);
      if (!SHA.test(args.ref) && !BRANCH.test(args.ref)) throw new AdapterError("not a ref", "invalid", false);
      const { status, data } = await api("GET", `${repoPath(r)}/contents/${encodePath(args.path)}?${new URLSearchParams({ ref: args.ref }).toString()}`);
      if (status === 404) return "missing";
      // The contents API lists a directory as an array; an object names its own type.
      if (Array.isArray(data)) return "directory";
      if (!isRecord(data)) throw new AdapterError("the code host returned a path entry it does not describe", "unknown", false);
      if (data.type === "file" || data.type === "symlink" || data.type === "submodule") return data.type;
      if (data.type === "dir") return "directory";
      throw new AdapterError("the code host returned a path entry of an unknown type", "unknown", false);
    },

    async commit(req): Promise<CommitResult> {
      const repo = assertRepo(req.repo);
      // Pushing the branch makes the repository's own workflows run the agent's code. Until the
      // deployer says those runs get no secrets, nothing is pushed (a gate: it fails closed).
      if (!options.shipBranchCiIsolated) throw new AdapterError(CI_NOT_ISOLATED, "invalid", false);
      const branch = shipBranch(req.taskId);
      if (!SHA.test(req.baseSha)) throw new AdapterError("the base is not a commit sha", "invalid", false);
      if (typeof req.message !== "string" || req.message.trim() === "" || req.message.length > MAX_MESSAGE) throw new AdapterError("the commit message is empty or too long", "invalid", false);
      assertCommittable(req.files);

      const base = await commitShape(repo, req.baseSha);
      const entries: TreeEntry[] = [];
      for (const file of req.files) {
        if (file.change === "deleted") {
          entries.push({ path: file.path, mode: "100644", type: "blob", sha: null });
          continue;
        }
        if (file.change === "renamed" && file.previousPath) entries.push({ path: file.previousPath, mode: "100644", type: "blob", sha: null });
        const content = file.content as { encoding: "utf-8" | "base64"; data: string };
        const blob = await api("POST", `${repoPath(repo)}/git/blobs`, { content: content.data, encoding: content.encoding === "base64" ? "base64" : "utf-8" });
        const sha = isRecord(blob.data) ? shaOf(blob.data.sha) : null;
        if (blob.status === 422 || !sha) throw new AdapterError("the code host refused a file", "invalid", false);
        entries.push({ path: file.path, mode: file.mode, type: "blob", sha });
      }
      const tree = await api("POST", `${repoPath(repo)}/git/trees`, { base_tree: base.tree, tree: entries });
      const treeSha = isRecord(tree.data) ? shaOf(tree.data.sha) : null;
      if (tree.status === 422 || !treeSha) throw new AdapterError("the code host refused the tree", "invalid", false);
      if (treeSha === base.tree) throw new AdapterError("the change leaves the tree as it was", "invalid", false);

      const sameChange = async (sha: string): Promise<boolean> => {
        const shape = await commitShape(repo, sha);
        return shape.tree === treeSha && shape.parents.length === 1 && shape.parents[0] === req.baseSha;
      };

      const existing = await refHead(repo, branch);
      if (existing) {
        if (await sameChange(existing)) return { branch, commitSha: existing, treeSha, created: false };
        throw new AdapterError(`${branch} already holds other work; it is never forced`, "invalid", false);
      }

      const dated = options.author ? { ...options.author, date: ctx.now().toISOString() } : null;
      const commit = await api("POST", `${repoPath(repo)}/git/commits`, { message: req.message, tree: treeSha, parents: [req.baseSha], ...(dated ? { author: dated, committer: dated } : {}) });
      const commitSha = isRecord(commit.data) ? shaOf(commit.data.sha) : null;
      if (commit.status === 422 || !commitSha) throw new AdapterError("the code host refused the commit", "invalid", false);

      const ref = await api("POST", `${repoPath(repo)}/git/refs`, { ref: `refs/heads/${branch}`, sha: commitSha });
      if (ref.status === 422) {
        // Another attempt created the branch first: accept it only if it holds this same change.
        const raced = await refHead(repo, branch);
        if (raced && (raced === commitSha || (await sameChange(raced)))) return { branch, commitSha: raced, treeSha, created: false };
        throw new AdapterError(`${branch} already holds other work; it is never forced`, "invalid", false);
      }
      return { branch, commitSha, treeSha, created: true };
    },

    async openPullRequest(req): Promise<PullRequestRef> {
      const repo = assertRepo(req.repo);
      const branch = shipBranch(req.taskId);
      if (!BRANCH.test(req.base) || req.base.startsWith(SHIP_BRANCH_PREFIX)) throw new AdapterError("the base is not a branch a ship change can target", "invalid", false);
      const title = cleanName(req.title, MAX_TITLE);
      if (!title) throw new AdapterError("the pull request needs a title", "invalid", false);
      const body = typeof req.body === "string" ? req.body.slice(0, MAX_BODY) : "";

      const existing = await existingPullRequest(repo, branch);
      if (existing) return existing;
      const created = await api("POST", `${repoPath(repo)}/pulls`, { title, head: branch, base: req.base, body, draft: req.draft === true, maintainer_can_modify: false });
      if (created.status === 422) {
        const raced = await existingPullRequest(repo, branch);
        if (raced) return raced;
        throw new AdapterError("the code host refused the pull request", "invalid", false);
      }
      const pr = isRecord(created.data) ? created.data : {};
      const number = prNumber(pr.number);
      const url = str(pr.html_url) ?? "";
      const headSha = isRecord(pr.head) ? shaOf(pr.head.sha) : null;
      if (number === null || !headSha || !/^https:\/\//.test(url)) throw new AdapterError("the code host returned a pull request it cannot describe", "unknown", false);
      return { number, url, headSha, created: true };
    },

    async pullRequest(repo, number): Promise<PullRequestState | null> {
      const r = assertRepo(repo);
      if (prNumber(number) === null) throw new AdapterError("not a pull request number", "invalid", false);
      const { status, data } = await api("GET", `${repoPath(r)}/pulls/${number}`);
      if (status === 404 || !isRecord(data)) return null;
      const head = isRecord(data.head) ? data.head : {};
      const base = isRecord(data.base) ? data.base : {};
      const headSha = shaOf(head.sha);
      const url = str(data.html_url) ?? "";
      if (!headSha || !/^https:\/\//.test(url)) throw new AdapterError("the code host returned a pull request it cannot describe", "unknown", false);
      const merged = data.merged === true;
      return {
        number,
        url,
        state: data.state === "open" ? "open" : "closed",
        merged,
        mergeCommitSha: merged ? shaOf(data.merge_commit_sha) : null,
        headSha,
        headBranch: str(head.ref) ?? "",
        baseBranch: str(base.ref) ?? "",
      };
    },

    async checks(repo, sha): Promise<ChecksState> {
      const r = assertRepo(repo);
      if (!SHA.test(sha)) throw new AdapterError("not a commit sha", "invalid", false);
      const runs = await api("GET", `${repoPath(r)}/commits/${sha}/check-runs?per_page=100`);
      const combined = await api("GET", `${repoPath(r)}/commits/${sha}/status`);
      const failing: string[] = [];
      let pending = false;
      let succeeded = false;
      const checkRuns = isRecord(runs.data) && Array.isArray(runs.data.check_runs) ? runs.data.check_runs.filter(isRecord) : [];
      for (const run of checkRuns) {
        const conclusion = run.status === "completed" ? conclusionOf(run.conclusion) : "pending";
        if (conclusion === "failure") failing.push(cleanName(run.name) || "check");
        else if (conclusion === "pending") pending = true;
        else if (conclusion === "success") succeeded = true;
      }
      const statuses = isRecord(combined.data) && Array.isArray(combined.data.statuses) ? combined.data.statuses.filter(isRecord) : [];
      for (const status of statuses) {
        const conclusion = conclusionOf(status.state);
        if (conclusion === "failure") failing.push(cleanName(status.context) || "status");
        else if (conclusion === "pending") pending = true;
        else if (conclusion === "success") succeeded = true;
      }
      const unique = [...new Set(failing)].slice(0, 20);
      return { state: unique.length > 0 ? "failure" : pending ? "pending" : succeeded ? "success" : "none", failing: unique };
    },

    async verifyWebhook(request): Promise<CodeHostEvent> {
      const secret = ctx.optionalSecret(WEBHOOK_SECRET_NAME);
      if (!secret) throw new AdapterError(`${WEBHOOK_SECRET_NAME} is not set, so webhooks cannot be verified`, "unavailable", false);
      const match = /^sha256=([0-9a-f]{64})$/.exec(request.headers.get(SIGNATURE_HEADER) ?? "");
      if (!match) throw new AdapterError("the webhook is not signed", "auth", false);
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BYTES) throw new AdapterError("the webhook body is too large", "invalid", false);
      const body = await readCapped(request, WEBHOOK_MAX_BYTES);
      if (body === null) throw new AdapterError("the webhook body is too large", "invalid", false);
      const signed = await hmacHex(secret, body);
      if (!(await constantTimeEqual(match[1] ?? "", signed))) throw new AdapterError("the webhook signature does not match", "auth", false);
      const deliveryId = request.headers.get(DELIVERY_HEADER) ?? "";
      const event = request.headers.get(EVENT_HEADER) ?? "";
      if (!DELIVERY.test(deliveryId) || !EVENT.test(event)) throw new AdapterError("the webhook has no delivery id or event name", "invalid", false);
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new AdapterError("the webhook body is not JSON", "invalid", false);
      }
      // The delivery id and event name are headers GitHub does not sign; the digest covers what
      // the signature does, so a payload replayed under a new delivery id deduplicates.
      return { ...mapGithubEvent(event, deliveryId, payload, options.repos), digest: `${event}:${signed}` };
    },
  };
}
