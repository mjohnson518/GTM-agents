// GTM-agents: the code-github adapter: the CodeHost port over the GitHub REST API, with plain fetch.
//
// It translates and decides nothing. The ship module decides what to commit, which task a webhook
// belongs to and what a production deploy is (docs/SHIP.md). Specifically:
//   - every method refuses a repository outside options.repos with a non-retryable "invalid"
//     AdapterError before any request, so the tokens can only ever touch the listed repositories
//     and the forks options.forks gives them;
//   - commit makes exactly one commit through the git data API: a blob per added or changed file,
//     one tree on the base commit's tree (deletions and the old side of a rename are tree entries
//     with a null sha), one commit whose only parent is the base commit, and the ref
//     refs/heads/ship/<task>. It is idempotent on retry: when the branch already points at a commit
//     with the same tree and the same parent, that commit is returned with created false. It never
//     moves an existing ref, never forces, and never names the base branch in a write, so a branch
//     holding anything else is refused. Submodule entries (mode 160000) are refused, and so are
//     paths that escape the repository or touch .git;
//   - with a fork configured for a repository (options.forks), commit makes that same commit on
//     ship/<task> in the fork and writes nothing in the target. The fork must be a fork of the
//     target under another owner. Before the commit, the fork's copy of the base branch must reach
//     the base commit: when it does not, and it is only behind the target's, the fork is synced
//     (merge-upstream, which then fast-forwards it); when it has commits of its own, or cannot be
//     brought to the base commit, the commit is refused. Requests to the fork carry
//     GITHUB_FORK_TOKEN, requests to the target carry GITHUB_TOKEN, and neither token is ever sent
//     to the other repository;
//   - openPullRequest looks for a pull request from the task's branch first and returns it with
//     created false; only when there is none does it open one, with maintainer edits off. It is
//     always opened in the target; with a fork, its head is <fork owner>:ship/<task>;
//   - contains answers from the compare API whether one commit is in another's history;
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
// Secrets (docs/SHIP.md lists the token permissions for each mode):
//   GITHUB_TOKEN           a fine-grained token for the listed repositories, used only from the
//                          Worker and never given to a sandbox. Without a fork: contents read and
//                          write, pull requests read and write, checks and commit statuses read.
//                          With a fork, contents read is enough on the target
//   GITHUB_FORK_TOKEN      only with options.forks: a fine-grained token whose resource owner is
//                          the forks' owner, for the forks only, with contents read and write. A
//                          fine-grained token has one resource owner, so it cannot be GITHUB_TOKEN
//   GITHUB_WEBHOOK_SECRET  the webhook's secret
// Options (adapters.code-github.options):
//   repos        the repositories the ship loop may touch, as owner/name. Required; empty refuses all
//   forks        optional: { "<owner/name in repos>": "<fork owner>/<name>" }. A listed repository
//                gets its ship branches in that fork and its pull requests from it. A fork entry
//                that cannot be used (malformed, not for a listed repository, under the same
//                owner, or forks under more than one owner, which one GITHUB_FORK_TOKEN cannot
//                cover) refuses every push rather than fall back to pushing to the target
//   apiBaseUrl   defaults to https://api.github.com (a GitHub Enterprise Server API URL also works)
//   author       { name, email } for the commit author and committer; omitted, GitHub uses the
//                token's account
//   shipBranchCiIsolated
//                true once the deployer has confirmed that CI cannot hand the agent's code a
//                secret or a write token: for a ship/ branch in the target, or, with a fork, for a
//                pull request from a fork (docs/SHIP.md, CI and the ship branch). Until then
//                commit refuses, because pushing the branch is what runs the agent's code in CI.
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
export const FORK_TOKEN_NAME = "GITHUB_FORK_TOKEN";
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

export interface GithubOptions {
  baseUrl: string;
  repos: readonly string[];
  author: { name: string; email: string } | null;
  /**
   * The deployer's statement that CI cannot hand the agent's code a secret or a write token: for a
   * repository without a fork, no workflow run for a ship/ branch gets either; for one with a
   * fork, no pull_request_target workflow checks out or runs a pull request's head and workflows
   * for fork pull requests get no secrets (docs/SHIP.md, "CI and the ship branch"). Until it is
   * true, commit refuses: pushing the branch is what makes CI run the agent's code.
   */
  shipBranchCiIsolated: boolean;
  /** Each listed repository that commits through a fork, to its fork. Lowercase owner/name. */
  forks: ReadonlyMap<string, string>;
  /** Why options.forks cannot be used, one sentence each. Any problem refuses every push. */
  forkProblems: readonly string[];
}

/** The commit refusal while CI isolation for ship/ branches in the target has not been confirmed. */
export const CI_NOT_ISOLATED =
  "the ship branch is not pushed until CI is isolated: a workflow run for a ship/ branch must get no secret and no write token (docs/SHIP.md, CI and the ship branch), then set shipBranchCiIsolated: true in the code-github options";

/** The commit refusal while CI isolation for pull requests from a fork has not been confirmed. */
export const FORK_CI_NOT_ISOLATED =
  "the ship branch is not pushed to the fork until CI is isolated for fork pull requests: no pull_request_target or workflow_run workflow in the repository may check out or run a pull request's code, and workflows for fork pull requests must get no secrets and no write token (in a private repository, sending secrets and write tokens to workflows from fork pull requests stays off). See docs/SHIP.md, CI and the ship branch, then set shipBranchCiIsolated: true in the code-github options";

const ownerOf = (repo: string): string => repo.split("/")[0] ?? "";

function readForks(raw: unknown, repos: readonly string[]): { forks: Map<string, string>; problems: string[] } {
  const forks = new Map<string, string>();
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { forks, problems };
  if (!isRecord(raw)) return { forks, problems: ["options.forks must map each repository to its fork, owner/name to owner/name"] };
  for (const [key, value] of Object.entries(raw)) {
    const target = normalizeRepo(key);
    const fork = normalizeRepo(value);
    const shown = cleanName(key, 140);
    if (!target || !repos.includes(target)) problems.push(`options.forks names ${shown}, which is not in options.repos`);
    else if (forks.has(target)) problems.push(`options.forks names ${target} twice`);
    else if (!fork) problems.push(`the fork for ${target} is not owner/name`);
    else if (ownerOf(fork) === ownerOf(target)) problems.push(`the fork for ${target} must be under another owner than ${ownerOf(target)}`);
    else forks.set(target, fork);
  }
  // GITHUB_FORK_TOKEN has one resource owner, so every fork must be under the same one.
  const owners = [...new Set([...forks.values()].map(ownerOf))].sort();
  if (owners.length > 1) problems.push(`the forks are under ${owners.join(", ")}, and one ${FORK_TOKEN_NAME} can only reach one owner`);
  return { forks, problems };
}

/** The adapter's options, normalized. Pure. */
export function readOptions(raw: Record<string, unknown>): GithubOptions {
  const base = typeof raw.apiBaseUrl === "string" && /^https:\/\/[^\s/@]+(?:\/\S*)?$/.test(raw.apiBaseUrl) ? raw.apiBaseUrl.replace(/\/+$/, "") : GITHUB_API;
  const repos = Array.isArray(raw.repos) ? [...new Set(raw.repos.map(normalizeRepo).filter((r): r is string => r !== null))].sort() : [];
  let author: GithubOptions["author"] = null;
  if (isRecord(raw.author)) {
    const name = cleanName(raw.author.name, 100);
    const email = typeof raw.author.email === "string" && /^[^\s@<>]{1,64}@[^\s@<>]{1,255}$/.test(raw.author.email) ? raw.author.email : "";
    if (name && email) author = { name, email };
  }
  const { forks, problems } = readForks(raw.forks, repos);
  return { baseUrl: base, repos, author, shipBranchCiIsolated: raw.shipBranchCiIsolated === true, forks, forkProblems: problems };
}

/**
 * Why nothing is pushed with these options, or null. `forkToken` says whether GITHUB_FORK_TOKEN
 * is set. Each mode in use names its own confirmation. Pure.
 */
export function pushRefusalFor(options: GithubOptions, forkToken: boolean): string | null {
  if (options.forkProblems.length > 0) return `the code-github fork configuration cannot be used, so nothing is pushed: ${options.forkProblems.join("; ")}`;
  if (options.forks.size > 0 && !forkToken) return `${FORK_TOKEN_NAME} is not set, so nothing is pushed to the forks in options.forks (docs/SHIP.md, enabling the build)`;
  if (options.shipBranchCiIsolated) return null;
  const forked = options.repos.filter((r) => options.forks.has(r));
  const direct = options.repos.filter((r) => !options.forks.has(r));
  if (forked.length === 0) return CI_NOT_ISOLATED;
  if (direct.length === 0) return FORK_CI_NOT_ISOLATED;
  return `for ${direct.join(", ")}: ${CI_NOT_ISOLATED}. For ${forked.join(", ")}, through a fork: ${FORK_CI_NOT_ISOLATED}`;
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

/** One repository as the adapter talks to it: where its requests go and which secret they carry. */
interface Side {
  repo: string;
  tokenName: string;
}

/** How a head commit relates to a base commit (the compare API's status), or "unknown" when the host finds no relation. */
type Relation = "ahead" | "identical" | "behind" | "diverged" | "unknown";

export function createAdapter(ctx: AdapterContext): CodeHost {
  const options = readOptions(ctx.options);
  // Every request names its repository through a Side, so a token only ever reaches its own:
  // GITHUB_TOKEN the targets, GITHUB_FORK_TOKEN the forks.
  const target = (repo: string): Side => ({ repo, tokenName: TOKEN_NAME });
  const forkSide = (fork: string): Side => ({ repo: fork, tokenName: FORK_TOKEN_NAME });

  const assertRepo = (repo: string): string => {
    const normalized = normalizeRepo(repo);
    if (!normalized || !options.repos.includes(normalized)) throw new AdapterError("the repository is not in options.repos", "invalid", false);
    return normalized;
  };
  const assertForksUsable = (): void => {
    if (options.forkProblems.length > 0) throw new AdapterError(pushRefusalFor(options, true) ?? "options.forks cannot be used", "invalid", false);
  };

  /** A request to `side.repo` (path is below /repos/<owner>/<name>). GET 404, POST 422 and `pass` come back instead of throwing. */
  async function api(side: Side, method: "GET" | "POST", path: string, body?: unknown, pass: readonly number[] = []): Promise<{ status: number; data: unknown }> {
    const token = ctx.optionalSecret(side.tokenName);
    if (!token) throw new AdapterError(`${side.tokenName} is not set`, "auth", false);
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": API_VERSION,
      "user-agent": "gtm-agents-code-github",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await ctx.fetch(`${options.baseUrl}/repos/${side.repo}${path}`, { method, headers, redirect: "manual", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch (error) {
      throw new AdapterError("the code host did not answer", "timeout", true, { cause: error });
    }
    const data = await response.json<unknown>().catch(() => null);
    if (response.status >= 300) {
      if (method === "GET" && response.status === 404) return { status: 404, data };
      if (method === "POST" && response.status === 422) return { status: 422, data };
      if (pass.includes(response.status)) return { status: response.status, data };
      const { code, retryable } = classifyStatus(response.status, response.headers);
      throw new AdapterError(`the code host answered HTTP ${response.status}`, code, retryable);
    }
    return { status: response.status, data };
  }

  const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

  async function refHead(side: Side, branch: string): Promise<string | null> {
    const { status, data } = await api(side, "GET", `/git/ref/heads/${encodePath(branch)}`);
    if (status === 404) return null;
    const sha = isRecord(data) && isRecord(data.object) ? shaOf(data.object.sha) : null;
    if (!sha) throw new AdapterError("the code host returned a ref without a commit", "unknown", false);
    return sha;
  }

  async function commitShape(side: Side, sha: string): Promise<{ tree: string; parents: string[] }> {
    const { status, data } = await api(side, "GET", `/git/commits/${sha}`);
    if (status === 404) throw new AdapterError("the commit does not exist", "not_found", false);
    const tree = isRecord(data) && isRecord(data.tree) ? shaOf(data.tree.sha) : null;
    const parents = isRecord(data) && Array.isArray(data.parents) ? data.parents.map((p) => (isRecord(p) ? shaOf(p.sha) : null)) : [];
    if (!tree || parents.some((p) => p === null)) throw new AdapterError("the code host returned a commit it cannot describe", "unknown", false);
    return { tree, parents: parents as string[] };
  }

  /** How `head` relates to `base` in `side.repo`, through the compare API. A 404 (no such commit, no shared history) is "unknown". */
  async function relation(side: Side, base: string, head: string): Promise<Relation> {
    if (base === head) return "identical";
    const { status, data } = await api(side, "GET", `/compare/${base}...${head}?per_page=1`);
    if (status === 404) return "unknown";
    const value = isRecord(data) ? data.status : undefined;
    if (value === "ahead" || value === "identical" || value === "behind" || value === "diverged") return value;
    throw new AdapterError("the code host returned a comparison it does not describe", "unknown", false);
  }

  /**
   * Makes baseSha reachable from the fork's copy of baseBranch before anything is committed there.
   * The fork must be a fork of `repo`. A copy that already reaches baseSha is left alone; one that
   * is only behind is synced, which fast-forwards it; one with commits of its own is refused, so
   * the sync never makes a merge commit. The sync is the only write here, and nothing is forced.
   */
  async function ensureBaseInFork(repo: string, fork: string, baseBranch: string, baseSha: string): Promise<void> {
    const side = forkSide(fork);
    const meta = await api(side, "GET", "");
    if (meta.status === 404) throw new AdapterError(`the fork ${fork} does not exist, or ${FORK_TOKEN_NAME} cannot read it`, "invalid", false);
    const parent = isRecord(meta.data) && isRecord(meta.data.parent) ? normalizeRepo(meta.data.parent.full_name) : null;
    if (!isRecord(meta.data) || meta.data.fork !== true || parent !== repo) throw new AdapterError(`${fork} is not a fork of ${repo}`, "invalid", false);

    const reach = async (): Promise<{ head: string; relation: Relation }> => {
      const head = await refHead(side, baseBranch);
      if (!head) throw new AdapterError(`the fork ${fork} has no ${baseBranch} branch`, "invalid", false);
      return { head, relation: await relation(side, baseSha, head) };
    };
    const reached = (r: Relation) => r === "ahead" || r === "identical";
    const diverged = () => new AdapterError(`the fork's ${baseBranch} has commits ${repo} does not have; reset it to ${repo}'s ${baseBranch}, which the ship loop only ever fast-forwards`, "invalid", false);
    const notYet = () => new AdapterError(`the fork ${fork} does not show the base commit yet`, "unavailable", true);

    const before = await reach();
    if (reached(before.relation)) return;
    if (before.relation === "diverged") throw diverged();
    if (before.relation === "unknown") {
      // The fork does not know the base commit. Sync only when the fork's head is in the
      // target's history of it, so the sync is a fast-forward.
      const inTarget = await relation(target(repo), before.head, baseSha);
      if (inTarget === "behind") throw notYet();
      if (inTarget !== "ahead") throw diverged();
    }
    const synced = await api(side, "POST", "/merge-upstream", { branch: baseBranch }, [409]);
    if (synced.status === 409) throw new AdapterError(`the fork's ${baseBranch} conflicts with ${repo}'s and cannot be synced; reset it to ${repo}'s ${baseBranch}`, "invalid", false);
    if (synced.status === 422) throw new AdapterError(`the fork's ${baseBranch} could not be synced with ${repo}`, "invalid", false);
    // GitHub's sync writes a merge commit when the fork's branch gained commits of its own since it
    // was read. Only a fast-forward (or nothing to do) is accepted; anything else is refused.
    const mergeType = isRecord(synced.data) ? synced.data.merge_type : undefined;
    if (mergeType !== "fast-forward" && mergeType !== "none") throw new AdapterError(`syncing the fork's ${baseBranch} was not a fast-forward (${typeof mergeType === "string" ? mergeType : "unknown"}); reset it to ${repo}'s ${baseBranch}`, "invalid", false);

    const after = await reach();
    if (reached(after.relation)) return;
    if (after.relation === "diverged") throw new AdapterError(`the base commit is no longer on ${repo}'s ${baseBranch}, so the fork cannot be brought up to it`, "invalid", false);
    throw notYet();
  }

  async function existingPullRequest(repo: string, branch: string, fork: string | null): Promise<PullRequestRef | null> {
    const query = new URLSearchParams({ head: `${ownerOf(fork ?? repo)}:${branch}`, state: "all", per_page: "5" });
    const { data } = await api(target(repo), "GET", `/pulls?${query.toString()}`);
    const list = Array.isArray(data) ? data.filter(isRecord) : [];
    // From a fork, the head repository must be that fork, not merely a branch of the same name.
    const fromFork = (head: Record<string, unknown>) => fork === null || (isRecord(head.repo) && normalizeRepo(head.repo.full_name) === fork);
    const found = list.find((pr) => isRecord(pr.head) && pr.head.ref === branch && fromFork(pr.head));
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

    pushRefusal: () => pushRefusalFor(options, Boolean(ctx.optionalSecret(FORK_TOKEN_NAME))),

    async branchHead(repo, branch) {
      const r = assertRepo(repo);
      if (!BRANCH.test(branch)) throw new AdapterError("not a branch name", "invalid", false);
      return refHead(target(r), branch);
    },

    async readFile(args): Promise<RepoFile | null> {
      const r = assertRepo(args.repo);
      if (!safeRepoPath(args.path)) throw new AdapterError("the path leaves the repository or touches .git", "invalid", false);
      if (!SHA.test(args.ref) && !BRANCH.test(args.ref)) throw new AdapterError("not a ref", "invalid", false);
      const { status, data } = await api(target(r), "GET", `/contents/${encodePath(args.path)}?${new URLSearchParams({ ref: args.ref }).toString()}`);
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
      const { status, data } = await api(target(r), "GET", `/contents/${encodePath(args.path)}?${new URLSearchParams({ ref: args.ref }).toString()}`);
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
      // Pushing the branch makes CI run the agent's code: the target's workflows for a ship/
      // branch, or its fork pull request workflows. Until the deployer says those runs get no
      // secrets, nothing is pushed. A fork entry that cannot be used refuses too, rather than
      // pushing to the target instead. Both are gates: they fail closed, before any request.
      assertForksUsable();
      const fork = options.forks.get(repo) ?? null;
      if (!options.shipBranchCiIsolated) throw new AdapterError(fork ? FORK_CI_NOT_ISOLATED : CI_NOT_ISOLATED, "invalid", false);
      const branch = shipBranch(req.taskId);
      if (!SHA.test(req.baseSha)) throw new AdapterError("the base is not a commit sha", "invalid", false);
      if (typeof req.baseBranch !== "string" || !BRANCH.test(req.baseBranch) || req.baseBranch.startsWith(SHIP_BRANCH_PREFIX)) throw new AdapterError("the base branch is not a branch a ship change can target", "invalid", false);
      if (typeof req.message !== "string" || req.message.trim() === "" || req.message.length > MAX_MESSAGE) throw new AdapterError("the commit message is empty or too long", "invalid", false);
      assertCommittable(req.files);

      // Everything from here is written where the branch lives: the target, or its fork.
      const side = fork ? forkSide(fork) : target(repo);
      if (fork) await ensureBaseInFork(repo, fork, req.baseBranch, req.baseSha);
      const base = await commitShape(side, req.baseSha);
      const entries: TreeEntry[] = [];
      for (const file of req.files) {
        if (file.change === "deleted") {
          entries.push({ path: file.path, mode: "100644", type: "blob", sha: null });
          continue;
        }
        if (file.change === "renamed" && file.previousPath) entries.push({ path: file.previousPath, mode: "100644", type: "blob", sha: null });
        const content = file.content as { encoding: "utf-8" | "base64"; data: string };
        const blob = await api(side, "POST", "/git/blobs", { content: content.data, encoding: content.encoding === "base64" ? "base64" : "utf-8" });
        const sha = isRecord(blob.data) ? shaOf(blob.data.sha) : null;
        if (blob.status === 422 || !sha) throw new AdapterError("the code host refused a file", "invalid", false);
        entries.push({ path: file.path, mode: file.mode, type: "blob", sha });
      }
      const tree = await api(side, "POST", "/git/trees", { base_tree: base.tree, tree: entries });
      const treeSha = isRecord(tree.data) ? shaOf(tree.data.sha) : null;
      if (tree.status === 422 || !treeSha) throw new AdapterError("the code host refused the tree", "invalid", false);
      if (treeSha === base.tree) throw new AdapterError("the change leaves the tree as it was", "invalid", false);

      const sameChange = async (sha: string): Promise<boolean> => {
        const shape = await commitShape(side, sha);
        return shape.tree === treeSha && shape.parents.length === 1 && shape.parents[0] === req.baseSha;
      };

      const existing = await refHead(side, branch);
      if (existing) {
        if (await sameChange(existing)) return { repo: side.repo, branch, commitSha: existing, treeSha, created: false };
        throw new AdapterError(`${branch} already holds other work; it is never forced`, "invalid", false);
      }

      const dated = options.author ? { ...options.author, date: ctx.now().toISOString() } : null;
      const commit = await api(side, "POST", "/git/commits", { message: req.message, tree: treeSha, parents: [req.baseSha], ...(dated ? { author: dated, committer: dated } : {}) });
      const commitSha = isRecord(commit.data) ? shaOf(commit.data.sha) : null;
      if (commit.status === 422 || !commitSha) throw new AdapterError("the code host refused the commit", "invalid", false);

      const ref = await api(side, "POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: commitSha });
      if (ref.status === 422) {
        // Another attempt created the branch first: accept it only if it holds this same change.
        const raced = await refHead(side, branch);
        if (raced && (raced === commitSha || (await sameChange(raced)))) return { repo: side.repo, branch, commitSha: raced, treeSha, created: false };
        throw new AdapterError(`${branch} already holds other work; it is never forced`, "invalid", false);
      }
      return { repo: side.repo, branch, commitSha, treeSha, created: true };
    },

    async openPullRequest(req): Promise<PullRequestRef> {
      const repo = assertRepo(req.repo);
      assertForksUsable();
      const fork = options.forks.get(repo) ?? null;
      const branch = shipBranch(req.taskId);
      if (!BRANCH.test(req.base) || req.base.startsWith(SHIP_BRANCH_PREFIX)) throw new AdapterError("the base is not a branch a ship change can target", "invalid", false);
      const title = cleanName(req.title, MAX_TITLE);
      if (!title) throw new AdapterError("the pull request needs a title", "invalid", false);
      const body = typeof req.body === "string" ? req.body.slice(0, MAX_BODY) : "";

      const existing = await existingPullRequest(repo, branch, fork);
      if (existing) return existing;
      // Always opened in the target, with GITHUB_TOKEN. From a fork, the head names the fork's owner.
      const head = fork ? `${ownerOf(fork)}:${branch}` : branch;
      const created = await api(target(repo), "POST", "/pulls", { title, head, base: req.base, body, draft: req.draft === true, maintainer_can_modify: false });
      if (created.status === 422) {
        const raced = await existingPullRequest(repo, branch, fork);
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
      const { status, data } = await api(target(r), "GET", `/pulls/${number}`);
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
      const runs = await api(target(r), "GET", `/commits/${sha}/check-runs?per_page=100`);
      const combined = await api(target(r), "GET", `/commits/${sha}/status`);
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

    async contains(repo, ancestorSha, descendantSha): Promise<boolean> {
      const r = assertRepo(repo);
      if (!SHA.test(ancestorSha) || !SHA.test(descendantSha)) throw new AdapterError("not a commit sha", "invalid", false);
      // Compared in the target, whose history deploys come from, whether or not it has a fork.
      // "ahead": the descendant has the ancestor in its history. A failed request throws.
      const found = await relation(target(r), ancestorSha, descendantSha);
      if (found === "unknown") {
        // GitHub answers 404 both for commits with no shared history and for a repository the
        // token can no longer read. Only the first means "not contained"; the second throws, so
        // the delivery is released and the failure is seen instead of every deploy reading as none.
        const readable = await api(target(r), "GET", "");
        if (readable.status !== 200) throw new AdapterError(`${r} could not be read to compare commits (HTTP ${readable.status}); check GITHUB_TOKEN's access`, "auth", false);
      }
      return found === "ahead" || found === "identical";
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
