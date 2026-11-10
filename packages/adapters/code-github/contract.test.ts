// GTM-agents: contract and behavior tests for the code-github adapter, against locally signed,
// synthetic webhooks and recorded, synthetic API responses. Every repository, commit, pull request
// and secret is invented; nothing reaches the network.
import { AdapterError } from "@gtm-agents/core/ports";
import { describe, expect, it } from "vitest";
import { runCodeHostContract, type WebhookSignOptions } from "../_contract/code-host.ts";
import { testContext } from "../_contract/context.ts";
import { json, recordedFetch, type RecordedRoute } from "../_contract/fetch.ts";
import {
  CI_NOT_ISOLATED,
  FORK_CI_NOT_ISOLATED,
  FORK_TOKEN_NAME,
  TOKEN_NAME,
  WEBHOOK_SECRET_NAME,
  assertCommittable,
  classifyStatus,
  cleanName,
  createAdapter,
  encodeContent,
  mapGithubEvent,
  normalizeRepo,
  pushRefusalFor,
  readOptions,
  safeRepoPath,
} from "./index.ts";
import manifest from "./manifest.json";

// Low-entropy on purpose, so no scanner mistakes them for real credentials.
const WEBHOOK_SECRET = "k".repeat(48);
const TOKEN = "t".repeat(48);
const FORK_TOKEN = "f".repeat(48);
const SECRETS = { [WEBHOOK_SECRET_NAME]: WEBHOOK_SECRET, [TOKEN_NAME]: TOKEN };
const FORK_SECRETS = { ...SECRETS, [FORK_TOKEN_NAME]: FORK_TOKEN };
const NOW = new Date("2026-11-04T12:00:00.000Z");
const API = "https://api.github.com";
const REPO = "acme/app";
const FORK = "acme-ship-bot/app";
const sha = (c: string) => c.repeat(40);
const BASE_SHA = sha("1");
const BASE_TREE = sha("2");
const BLOB = sha("3");
const TREE = sha("4");
const COMMIT = sha("5");
const OTHER_TREE = sha("6");
const MERGE = sha("7");
const FORK_HEAD = sha("9");
const OLD_FORK_HEAD = sha("a");
const FORK_OWN = sha("b");
const DIVERGED = sha("c");
const DEPLOY = sha("d");
const OLDER = sha("e");
const UNRELATED = sha("f");
const OPTIONS = { repos: ["Acme/App"], author: { name: "Acme ship loop", email: "ship@acme.example" }, shipBranchCiIsolated: true };
const FORK_OPTIONS = { ...OPTIONS, forks: { "Acme/App": "Acme-Ship-Bot/App" } };

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function webhook(event: string, body: string, options: WebhookSignOptions = {}): Promise<Request> {
  const signature = `sha256=${await hmacHex(options.secret ?? WEBHOOK_SECRET, body)}`;
  const sent = options.tamper ? `${body} ` : body;
  return new Request("https://agent.acme.example/api/webhooks/code", {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": options.deliveryId ?? "delivery-0001", ...(options.unsigned ? {} : { "x-hub-signature-256": signature }) },
    body: sent,
  });
}

const repository = { full_name: "acme/app" };
const pr = (overrides: Record<string, unknown> = {}) => ({ number: 7, merged: false, merge_commit_sha: null, html_url: "https://github.com/acme/app/pull/7", head: { ref: "ship/task-0001", sha: COMMIT }, base: { ref: "main" }, ...overrides });

const branchRef = `${API}/repos/acme/app/git/ref/heads/ship/task-0001`;
const baseCommit: RecordedRoute = { method: "GET", url: `${API}/repos/acme/app/git/commits/${BASE_SHA}`, respond: json({ sha: BASE_SHA, tree: { sha: BASE_TREE }, parents: [{ sha: sha("0") }] }) };
const blob: RecordedRoute = { method: "POST", url: `${API}/repos/acme/app/git/blobs`, respond: json({ sha: BLOB }, { status: 201 }) };
const tree: RecordedRoute = { method: "POST", url: `${API}/repos/acme/app/git/trees`, respond: json({ sha: TREE }, { status: 201 }) };
const ourCommit: RecordedRoute = { method: "GET", url: `${API}/repos/acme/app/git/commits/${COMMIT}`, respond: json({ sha: COMMIT, tree: { sha: TREE }, parents: [{ sha: BASE_SHA }] }) };
const otherCommit: RecordedRoute = { method: "GET", url: `${API}/repos/acme/app/git/commits/${COMMIT}`, respond: json({ sha: COMMIT, tree: { sha: OTHER_TREE }, parents: [{ sha: BASE_SHA }] }) };
const noBranch: RecordedRoute = { method: "GET", url: branchRef, respond: json({ message: "Not Found" }, { status: 404 }) };
const branchAtCommit: RecordedRoute = { method: "GET", url: branchRef, respond: json({ ref: "refs/heads/ship/task-0001", object: { sha: COMMIT, type: "commit" } }) };
const createCommit: RecordedRoute = { method: "POST", url: `${API}/repos/acme/app/git/commits`, respond: json({ sha: COMMIT }, { status: 201 }) };
const createRef: RecordedRoute = { method: "POST", url: `${API}/repos/acme/app/git/refs`, respond: json({ ref: "refs/heads/ship/task-0001", object: { sha: COMMIT } }, { status: 201 }) };
const prList = (items: unknown[]): RecordedRoute => ({ method: "GET", url: `${API}/repos/acme/app/pulls?head=acme%3Aship%2Ftask-0001&state=all&per_page=5`, respond: json(items) });
const createPr: RecordedRoute = { method: "POST", url: `${API}/repos/acme/app/pulls`, respond: json(pr(), { status: 201 }) };

// The same steps in the fork, and what the fork's base branch looks like before and after a sync.
const F = `${API}/repos/acme-ship-bot/app`;
const forkMeta = (overrides: Record<string, unknown> = {}): RecordedRoute => ({ method: "GET", url: F, respond: json({ full_name: FORK, fork: true, parent: { full_name: REPO }, ...overrides }) });
const forkMain = (head: string, times?: number): RecordedRoute => ({ method: "GET", url: `${F}/git/ref/heads/main`, respond: json({ ref: "refs/heads/main", object: { sha: head } }), ...(times ? { times } : {}) });
const compareIn = (base: string, ancestor: string, descendant: string, status: string | number): RecordedRoute => ({
  method: "GET",
  url: `${base}/compare/${ancestor}...${descendant}?per_page=1`,
  respond: typeof status === "number" ? json({ message: "Not Found" }, { status }) : json({ status, ahead_by: 1, behind_by: 0, commits: [] }),
});
const syncFork: RecordedRoute = { method: "POST", url: `${F}/merge-upstream`, respond: json({ message: "Successfully fetched and fast-forwarded from upstream acme:main.", merge_type: "fast-forward", base_branch: "acme:main" }) };
const forkCommitSteps: RecordedRoute[] = [
  { method: "GET", url: `${F}/git/commits/${BASE_SHA}`, respond: json({ sha: BASE_SHA, tree: { sha: BASE_TREE }, parents: [{ sha: sha("0") }] }) },
  { method: "POST", url: `${F}/git/blobs`, respond: json({ sha: BLOB }, { status: 201 }) },
  { method: "POST", url: `${F}/git/trees`, respond: json({ sha: TREE }, { status: 201 }) },
  { method: "GET", url: `${F}/git/ref/heads/ship/task-0001`, respond: json({ message: "Not Found" }, { status: 404 }) },
  { method: "POST", url: `${F}/git/commits`, respond: json({ sha: COMMIT }, { status: 201 }) },
  { method: "POST", url: `${F}/git/refs`, respond: json({ ref: "refs/heads/ship/task-0001", object: { sha: COMMIT } }, { status: 201 }) },
];
const forkPr = (repo = FORK) => pr({ head: { ref: "ship/task-0001", sha: COMMIT, label: `${repo.split("/")[0]}:ship/task-0001`, repo: { full_name: repo } } });
const forkPrList = (items: unknown[]): RecordedRoute => ({ method: "GET", url: `${API}/repos/acme/app/pulls?head=acme-ship-bot%3Aship%2Ftask-0001&state=all&per_page=5`, respond: json(items) });
const createForkPr: RecordedRoute = { method: "POST", url: `${API}/repos/acme/app/pulls`, respond: json(forkPr(), { status: 201 }) };
const isForkRequest = (request: Request) => /^\/repos\/acme-ship-bot\/app(?:\/|$)/.test(new URL(request.url).pathname);
const T = `${API}/repos/acme/app`;

const commitRequest = {
  repo: REPO,
  taskId: "task-0001",
  baseSha: BASE_SHA,
  baseBranch: "main",
  message: "Add CSV export to the reports page\n\nShip-Task: task-0001",
  files: [{ path: "src/reports/export.ts", change: "added" as const, additions: 3, deletions: 0, mode: "100644", binary: false, content: { encoding: "utf-8" as const, data: "export const csv = true;\n" } }],
};

runCodeHostContract(createAdapter, {
  manifest,
  secrets: SECRETS,
  tokenName: TOKEN_NAME,
  webhookSecretName: WEBHOOK_SECRET_NAME,
  options: OPTIONS,
  now: NOW,
  repo: REPO,
  otherRepo: "initech/app",
  baseBranch: "main",
  webhook,
  events: [
    { name: "ping", event: "ping", body: JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 }), expected: { type: "ping", deliveryId: "delivery-0001" } },
    {
      name: "a merged pull request",
      event: "pull_request",
      body: JSON.stringify({ action: "closed", number: 7, repository, pull_request: pr({ merged: true, merge_commit_sha: MERGE }) }),
      expected: { type: "pull_request", deliveryId: "delivery-0001", repo: REPO, number: 7, action: "closed", merged: true, mergeCommitSha: MERGE, headSha: COMMIT, headBranch: "ship/task-0001", baseBranch: "main" },
    },
    {
      name: "a pull request closed without merging",
      event: "pull_request",
      body: JSON.stringify({ action: "closed", number: 7, repository, pull_request: pr({ merge_commit_sha: MERGE }) }),
      expected: { type: "pull_request", deliveryId: "delivery-0001", repo: REPO, number: 7, action: "closed", merged: false, mergeCommitSha: null, headSha: COMMIT, headBranch: "ship/task-0001", baseBranch: "main" },
    },
    {
      name: "a failed check run",
      event: "check_run",
      body: JSON.stringify({ action: "completed", repository, check_run: { name: "test\u0007 (unit)", status: "completed", conclusion: "timed_out", head_sha: COMMIT, pull_requests: [{ number: 7 }] } }),
      expected: { type: "check", deliveryId: "delivery-0001", repo: REPO, headSha: COMMIT, name: "test (unit)", conclusion: "failure", pullRequests: [7] },
    },
    {
      name: "a failed commit status",
      event: "status",
      body: JSON.stringify({ repository, sha: COMMIT, state: "error", context: "ci/build" }),
      expected: { type: "check", deliveryId: "delivery-0001", repo: REPO, headSha: COMMIT, name: "ci/build", conclusion: "failure", pullRequests: [] },
    },
    {
      name: "a successful production deployment",
      event: "deployment_status",
      body: JSON.stringify({ repository, deployment: { sha: MERGE, environment: "production", production_environment: true }, deployment_status: { state: "success", environment: "production" } }),
      expected: { type: "deployment", deliveryId: "delivery-0001", repo: REPO, sha: MERGE, environment: "production", productionEnvironment: true, state: "success" },
    },
    {
      name: "an event it does not handle",
      event: "issues",
      body: JSON.stringify({ action: "opened", repository, issue: { number: 3 } }),
      expected: { type: "ignored", deliveryId: "delivery-0001", reason: "not handled: issues" },
    },
    {
      name: "an event for a repository outside the allowlist",
      event: "pull_request",
      body: JSON.stringify({ action: "closed", repository: { full_name: "initech/app" }, pull_request: pr() }),
      expected: { type: "ignored", deliveryId: "delivery-0001", reason: "the repository is not in options.repos" },
    },
  ],
  invalidBodies: [
    { event: "pull_request", body: "not json" },
    { event: "pull_request", body: JSON.stringify({ action: "closed", repository }) },
    { event: "check_run", body: JSON.stringify({ action: "completed", repository, check_run: { name: "x" } }) },
    { event: "deployment_status", body: JSON.stringify({ repository, deployment: { environment: "production" }, deployment_status: { state: "success" } }) },
    { event: "status", body: JSON.stringify({ sha: COMMIT, state: "success" }) },
  ],
  isRefWrite: (request) => request.method !== "GET" && /\/git\/refs(?:\/|$)/.test(new URL(request.url).pathname),
  commit: {
    request: commitRequest,
    fresh: [baseCommit, blob, tree, noBranch, createCommit, createRef],
    retry: [baseCommit, blob, tree, branchAtCommit, ourCommit],
    conflict: [baseCommit, blob, tree, branchAtCommit, otherCommit],
    expected: { repo: REPO, branch: "ship/task-0001", commitSha: COMMIT, treeSha: TREE },
  },
  pullRequest: {
    request: { repo: REPO, taskId: "task-0001", base: "main", title: "Add CSV export to the reports page", body: "Opened by the ship loop." },
    fresh: [prList([]), createPr],
    existing: [prList([pr()])],
    expected: { number: 7, url: "https://github.com/acme/app/pull/7" },
  },
  contains: {
    routes: [
      compareIn(T, MERGE, DEPLOY, "ahead"),
      compareIn(T, MERGE, OLDER, "behind"),
      compareIn(T, MERGE, DIVERGED, "diverged"),
      compareIn(T, MERGE, UNRELATED, 404),
      // A compare 404 is "no shared history" only while the repository itself can be read.
      { method: "GET", url: T, respond: json({ full_name: "acme/app" }) },
    ],
    cases: [
      { name: "a later deploy that carries the merge commit", ancestor: MERGE, descendant: DEPLOY, expected: true },
      { name: "a deploy of the merge commit itself", ancestor: MERGE, descendant: MERGE, expected: true },
      { name: "an older deploy", ancestor: MERGE, descendant: OLDER, expected: false },
      { name: "a deploy from another line of history", ancestor: MERGE, descendant: DIVERGED, expected: false },
      { name: "a commit the repository does not share history with", ancestor: MERGE, descendant: UNRELATED, expected: false },
    ],
    failing: { routes: [{ method: "GET", url: /\/compare\//, respond: json({}, { status: 502 }) }], ancestor: MERGE, descendant: DEPLOY },
  },
  fork: {
    options: FORK_OPTIONS,
    secrets: FORK_SECRETS,
    forkTokenName: FORK_TOKEN_NAME,
    forkRepo: FORK,
    isForkRequest,
    commit: {
      fresh: [forkMeta(), forkMain(FORK_HEAD), compareIn(F, BASE_SHA, FORK_HEAD, "ahead"), ...forkCommitSteps],
      behind: [forkMeta(), forkMain(OLD_FORK_HEAD, 1), compareIn(F, BASE_SHA, OLD_FORK_HEAD, "behind"), syncFork, forkMain(BASE_SHA), ...forkCommitSteps],
      diverged: [forkMeta(), forkMain(FORK_OWN), compareIn(F, BASE_SHA, FORK_OWN, "diverged"), syncFork, ...forkCommitSteps],
      expected: { branch: "ship/task-0001", commitSha: COMMIT, treeSha: TREE },
    },
    pullRequest: {
      fresh: [forkPrList([]), createForkPr],
      existing: [forkPrList([forkPr()])],
      expected: { number: 7, url: "https://github.com/acme/app/pull/7" },
    },
  },
  readFile: {
    path: "CLAUDE.md",
    ref: "main",
    routes: [
      { method: "GET", url: `${API}/repos/acme/app/contents/CLAUDE.md?ref=main`, respond: json({ type: "file", size: 18, encoding: "base64", content: btoa("# Acme engineering") }) },
      { method: "GET", url: `${API}/repos/acme/app/contents/AGENTS.md?ref=main`, respond: json({ message: "Not Found" }, { status: 404 }) },
    ],
    expected: { size: 18, encoding: "utf-8", data: "# Acme engineering" },
    missingPath: "AGENTS.md",
  },
  pathKinds: {
    ref: BASE_SHA,
    routes: [
      { method: "GET", url: `${API}/repos/acme/app/contents/src?ref=${BASE_SHA}`, respond: json([{ type: "file", name: "main.ts", path: "src/main.ts" }]) },
      { method: "GET", url: `${API}/repos/acme/app/contents/README.md?ref=${BASE_SHA}`, respond: json({ type: "file", size: 4, encoding: "base64", content: btoa("acme") }) },
      { method: "GET", url: `${API}/repos/acme/app/contents/current?ref=${BASE_SHA}`, respond: json({ type: "symlink", target: "releases/v1" }) },
      { method: "GET", url: `${API}/repos/acme/app/contents/vendor/lib?ref=${BASE_SHA}`, respond: json({ type: "submodule", submodule_git_url: "https://github.com/acme/lib.git" }) },
      { method: "GET", url: `${API}/repos/acme/app/contents/nothing?ref=${BASE_SHA}`, respond: json({ message: "Not Found" }, { status: 404 }) },
    ],
    cases: [
      { path: "src", expected: "directory" },
      { path: "README.md", expected: "file" },
      { path: "current", expected: "symlink" },
      { path: "vendor/lib", expected: "submodule" },
      { path: "nothing", expected: "missing" },
    ],
  },
  failures: [
    { name: "401 is auth", routes: [{ url: /\/git\/ref\//, respond: json({}, { status: 401 }) }], code: "auth", retryable: false },
    { name: "403 with no rate limit left is rate limited", routes: [{ url: /\/git\/ref\//, respond: json({}, { status: 403, headers: { "x-ratelimit-remaining": "0" } }) }], code: "rate_limited", retryable: true },
    { name: "429 is rate limited", routes: [{ url: /\/git\/ref\//, respond: json({}, { status: 429 }) }], code: "rate_limited", retryable: true },
    { name: "502 is unavailable", routes: [{ url: /\/git\/ref\//, respond: json({}, { status: 502 }) }], code: "unavailable", retryable: true },
    { name: "a dropped connection is a time-out", routes: [{ url: /\/git\/ref\//, respond: () => Promise.reject(new Error("connection reset")) }], code: "timeout", retryable: true },
  ],
});

describe("code-github before CI isolation is confirmed", () => {
  const unconfirmed = (options: Record<string, unknown>, secrets: Record<string, string> = FORK_SECRETS) => {
    const recorded = recordedFetch([]);
    return { recorded, adapter: createAdapter(testContext({ secrets, fetch: recorded.fetch, now: NOW, options: { ...options, shipBranchCiIsolated: undefined } })) };
  };

  it("refuses to push a ship branch, before any request, until shipBranchCiIsolated is true", async () => {
    const { recorded, adapter } = unconfirmed(OPTIONS, SECRETS);
    const refused = await adapter.commit({ repo: "acme/app", taskId: "task-0001", baseSha: BASE_SHA, baseBranch: "main", message: "Add the thing", files: [] }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ name: "AdapterError", code: "invalid", retryable: false });
    expect(String((refused as Error).message)).toBe(CI_NOT_ISOLATED);
    expect(adapter.pushRefusal()).toBe(CI_NOT_ISOLATED);
    expect(recorded.calls).toHaveLength(0);
  });

  it("refuses to push to a fork, before any request, naming what to confirm for fork pull requests", async () => {
    const { recorded, adapter } = unconfirmed(FORK_OPTIONS);
    const refused = await adapter.commit(commitRequest).catch((e: unknown) => e);
    expect(refused).toMatchObject({ name: "AdapterError", code: "invalid", retryable: false });
    expect(String((refused as Error).message)).toBe(FORK_CI_NOT_ISOLATED);
    expect(adapter.pushRefusal()).toBe(FORK_CI_NOT_ISOLATED);
    expect(FORK_CI_NOT_ISOLATED).toMatch(/pull_request_target/);
    expect(FORK_CI_NOT_ISOLATED).toMatch(/no secrets/);
    expect(FORK_CI_NOT_ISOLATED).toMatch(/shipBranchCiIsolated: true/);
    expect(recorded.calls).toHaveLength(0);
  });

  it("names both confirmations, each with its repositories, when only some repositories commit through a fork", () => {
    const mixed = readOptions({ repos: ["acme/app", "acme/docs"], forks: { "acme/app": FORK } });
    const refusal = pushRefusalFor(mixed, true) ?? "";
    expect(refusal).toContain(`for acme/docs: ${CI_NOT_ISOLATED}`);
    expect(refusal).toContain(`For acme/app, through a fork: ${FORK_CI_NOT_ISOLATED}`);
    expect(pushRefusalFor({ ...mixed, shipBranchCiIsolated: true }, true)).toBeNull();
  });
});

describe("code-github fork configuration", () => {
  it("normalizes the forks it can use and refuses every push for one it cannot, rather than push to the target", () => {
    expect([...readOptions(FORK_OPTIONS).forks]).toEqual([[REPO, FORK]]);
    expect(readOptions(FORK_OPTIONS).forkProblems).toEqual([]);
    const broken: Array<[string, unknown, RegExp]> = [
      ["not a map", ["acme-ship-bot/app"], /must map each repository/],
      ["a repository not in repos", { "acme/other": FORK }, /acme\/other, which is not in options.repos/],
      ["a malformed fork", { "acme/app": "acme-ship-bot" }, /not owner\/name/],
      ["a fork under the same owner", { "acme/app": "acme/app-fork" }, /another owner/],
    ];
    for (const [name, forks, reason] of broken) {
      const options = readOptions({ ...OPTIONS, forks });
      expect(options.forks.size, name).toBe(0);
      expect(pushRefusalFor(options, true), name).toMatch(reason);
    }
    const twoOwners = readOptions({ repos: ["acme/app", "acme/docs"], forks: { "acme/app": FORK, "acme/docs": "acme-docs-bot/docs" }, shipBranchCiIsolated: true });
    expect(pushRefusalFor(twoOwners, true)).toMatch(/one GITHUB_FORK_TOKEN can only reach one owner/);
    expect(pushRefusalFor(readOptions(FORK_OPTIONS), false)).toMatch(/GITHUB_FORK_TOKEN is not set/);
    expect(pushRefusalFor(readOptions(FORK_OPTIONS), true)).toBeNull();
  });

  it("refuses to commit or open a pull request, before any request, while a fork entry cannot be used", async () => {
    const recorded = recordedFetch([]);
    const adapter = createAdapter(testContext({ secrets: FORK_SECRETS, fetch: recorded.fetch, now: NOW, options: { ...OPTIONS, forks: { "acme/app": "acme/app-fork" } } }));
    expect(await adapter.commit(commitRequest).catch((e: unknown) => (e as AdapterError).code)).toBe("invalid");
    expect(await adapter.openPullRequest({ repo: REPO, taskId: "task-0001", base: "main", title: "x", body: "" }).catch((e: unknown) => (e as AdapterError).code)).toBe("invalid");
    expect(recorded.calls).toHaveLength(0);
  });
});

describe("code-github through a fork", () => {
  const forkAdapter = (routes: RecordedRoute[]) => {
    const recorded = recordedFetch(routes);
    return { recorded, adapter: createAdapter(testContext({ secrets: FORK_SECRETS, fetch: recorded.fetch, now: NOW, options: FORK_OPTIONS })) };
  };
  const writes = (calls: Request[]) => calls.filter((c) => c.method !== "GET");

  it("sends the fork's token only to the fork and the target's token only to the target", async () => {
    const routes = [forkMeta(), forkMain(OLD_FORK_HEAD, 1), compareIn(F, BASE_SHA, OLD_FORK_HEAD, 404), compareIn(T, OLD_FORK_HEAD, BASE_SHA, "ahead"), syncFork, forkMain(BASE_SHA), ...forkCommitSteps, forkPrList([]), createForkPr];
    const { recorded, adapter } = forkAdapter(routes);
    await adapter.commit(commitRequest);
    await adapter.openPullRequest({ repo: REPO, taskId: "task-0001", base: "main", title: "Add CSV export", body: "" });
    expect(recorded.calls.some((c) => !isForkRequest(c))).toBe(true);
    for (const call of recorded.calls) expect(call.headers.get("authorization"), `${call.method} ${call.url}`).toBe(`Bearer ${isForkRequest(call) ? FORK_TOKEN : TOKEN}`);
  });

  it("opens the pull request in the target with the fork's owner in its head and maintainer edits off", async () => {
    const { recorded, adapter } = forkAdapter([forkPrList([]), createForkPr]);
    expect(await adapter.openPullRequest({ repo: REPO, taskId: "task-0001", base: "main", title: "Add CSV export", body: "Opened by the ship loop." })).toEqual({ number: 7, url: "https://github.com/acme/app/pull/7", headSha: COMMIT, created: true });
    const created = writes(recorded.calls)[0];
    expect(created?.url).toBe(`${API}/repos/acme/app/pulls`);
    expect(await created?.json()).toMatchObject({ head: "acme-ship-bot:ship/task-0001", base: "main", maintainer_can_modify: false });
  });

  it("does not take a pull request from another repository's branch of the same name for the fork's", async () => {
    const { recorded, adapter } = forkAdapter([forkPrList([forkPr("initech/app")]), createForkPr]);
    expect(await adapter.openPullRequest({ repo: REPO, taskId: "task-0001", base: "main", title: "Add CSV export", body: "" })).toMatchObject({ created: true });
    expect(writes(recorded.calls)).toHaveLength(1);
  });

  it("syncs a fork that does not know the base commit only when the fork's head is in the target's history of it", async () => {
    const lagging = forkAdapter([forkMeta(), forkMain(OLD_FORK_HEAD, 1), compareIn(F, BASE_SHA, OLD_FORK_HEAD, 404), compareIn(T, OLD_FORK_HEAD, BASE_SHA, "ahead"), syncFork, forkMain(BASE_SHA), ...forkCommitSteps]);
    expect(await lagging.adapter.commit(commitRequest)).toMatchObject({ repo: FORK, created: true });
    expect(writes(lagging.recorded.calls).map((c) => new URL(c.url).pathname)[0]).toBe("/repos/acme-ship-bot/app/merge-upstream");
    expect(await writes(lagging.recorded.calls)[0]?.json()).toEqual({ branch: "main" });

    const ownCommits = forkAdapter([forkMeta(), forkMain(FORK_OWN), compareIn(F, BASE_SHA, FORK_OWN, 404), compareIn(T, FORK_OWN, BASE_SHA, 404), syncFork, ...forkCommitSteps]);
    const refused = (await ownCommits.adapter.commit(commitRequest).catch((e: unknown) => e)) as AdapterError;
    expect(refused).toMatchObject({ code: "invalid", retryable: false });
    expect(String(refused.message)).toMatch(/has commits acme\/app does not have/);
    expect(writes(ownCommits.recorded.calls)).toHaveLength(0);
  });

  it("refuses a sync that GitHub answered with a merge commit instead of a fast-forward", async () => {
    const merged: RecordedRoute = { method: "POST", url: `${F}/merge-upstream`, respond: json({ message: "Successfully fetched and merged from upstream acme:main.", merge_type: "merge", base_branch: "acme:main" }) };
    const raced = forkAdapter([forkMeta(), forkMain(OLD_FORK_HEAD, 1), compareIn(F, BASE_SHA, OLD_FORK_HEAD, "behind"), merged]);
    const refused = (await raced.adapter.commit(commitRequest).catch((e: unknown) => e)) as AdapterError;
    expect(refused).toMatchObject({ code: "invalid", retryable: false });
    expect(String(refused.message)).toMatch(/not a fast-forward \(merge\)/);
  });

  it("throws, rather than answer not contained, when the repository itself can no longer be read", async () => {
    const lost = createAdapter(testContext({ secrets: SECRETS, now: NOW, options: OPTIONS, fetch: recordedFetch([compareIn(T, MERGE, DEPLOY, 404), { method: "GET", url: T, respond: json({ message: "Not Found" }, { status: 404 }) }]).fetch }));
    expect(await lost.contains("acme/app", MERGE, DEPLOY).catch((e: unknown) => e)).toMatchObject({ name: "AdapterError", code: "auth" });
  });

  it("refuses a sync the code host reports as a conflict, and says whether a base commit still missing after a sync is worth retrying", async () => {
    const conflict: RecordedRoute = { method: "POST", url: `${F}/merge-upstream`, respond: json({ message: "There are merge conflicts" }, { status: 409 }) };
    const conflicted = forkAdapter([forkMeta(), forkMain(OLD_FORK_HEAD), compareIn(F, BASE_SHA, OLD_FORK_HEAD, "behind"), conflict]);
    expect(await conflicted.adapter.commit(commitRequest).catch((e: unknown) => e)).toMatchObject({ code: "invalid", retryable: false });

    const lag = forkAdapter([forkMeta(), forkMain(OLD_FORK_HEAD, 1), compareIn(F, BASE_SHA, OLD_FORK_HEAD, "behind"), syncFork, forkMain(FORK_HEAD), compareIn(F, BASE_SHA, FORK_HEAD, 404)]);
    expect(await lag.adapter.commit(commitRequest).catch((e: unknown) => e)).toMatchObject({ code: "unavailable", retryable: true });

    const rewritten = forkAdapter([forkMeta(), forkMain(OLD_FORK_HEAD, 1), compareIn(F, BASE_SHA, OLD_FORK_HEAD, "behind"), syncFork, forkMain(FORK_HEAD), compareIn(F, BASE_SHA, FORK_HEAD, "diverged")]);
    const gone = (await rewritten.adapter.commit(commitRequest).catch((e: unknown) => e)) as AdapterError;
    expect(gone).toMatchObject({ code: "invalid", retryable: false });
    expect(String(gone.message)).toMatch(/no longer on acme\/app's main/);
    for (const run of [conflicted, lag, rewritten]) expect(run.recorded.calls.filter((c) => /\/git\//.test(c.url) && c.method !== "GET")).toHaveLength(0);
  });

  it("refuses a fork that is not a fork of the target, or that the fork's token cannot read, writing nothing", async () => {
    const cases: RecordedRoute[] = [forkMeta({ fork: false, parent: undefined }), forkMeta({ parent: { full_name: "initech/app" } }), { method: "GET", url: F, respond: json({ message: "Not Found" }, { status: 404 }) }];
    for (const meta of cases) {
      const { recorded, adapter } = forkAdapter([meta, forkMain(FORK_HEAD), compareIn(F, BASE_SHA, FORK_HEAD, "ahead"), ...forkCommitSteps]);
      expect(await adapter.commit(commitRequest).catch((e: unknown) => e)).toMatchObject({ code: "invalid", retryable: false });
      expect(writes(recorded.calls)).toHaveLength(0);
    }
  });

  it("refuses a base branch a ship change cannot target before any request", async () => {
    const { recorded, adapter } = forkAdapter([]);
    for (const baseBranch of ["ship/other", "", "-x"]) expect(await adapter.commit({ ...commitRequest, baseBranch }).catch((e: unknown) => (e as AdapterError).code), baseBranch).toBe("invalid");
    expect(recorded.calls).toHaveLength(0);
  });
});

describe("code-github comparing commits", () => {
  it("compares in the target, asks for one commit of the comparison, and answers the same commit without a request", async () => {
    const recorded = recordedFetch([compareIn(T, MERGE, DEPLOY, "ahead")]);
    const adapter = createAdapter(testContext({ secrets: FORK_SECRETS, fetch: recorded.fetch, now: NOW, options: FORK_OPTIONS }));
    expect(await adapter.contains(REPO, MERGE, MERGE)).toBe(true);
    expect(recorded.calls).toHaveLength(0);
    expect(await adapter.contains(REPO, MERGE, DEPLOY)).toBe(true);
    expect(recorded.calls.map((c) => [c.url, c.headers.get("authorization")])).toEqual([[`${T}/compare/${MERGE}...${DEPLOY}?per_page=1`, `Bearer ${TOKEN}`]]);
  });

  it("refuses something that is not a commit sha before any request, and throws for a comparison it cannot read", async () => {
    const recorded = recordedFetch([{ method: "GET", url: /\/compare\//, respond: json({ status: "sideways" }) }]);
    const adapter = createAdapter(testContext({ secrets: SECRETS, fetch: recorded.fetch, now: NOW, options: OPTIONS }));
    for (const bad of ["main", "HEAD~1", MERGE.slice(1), DEPLOY.toUpperCase()]) expect(await adapter.contains(REPO, bad, MERGE).catch((e: unknown) => (e as AdapterError).code), bad).toBe("invalid");
    expect(recorded.calls).toHaveLength(0);
    expect(await adapter.contains(REPO, MERGE, DEPLOY).catch((e: unknown) => (e as AdapterError).code)).toBe("unknown");
  });
});

describe("code-github specifics", () => {
  const adapterWith = (routes: RecordedRoute[]) => {
    const recorded = recordedFetch(routes);
    return { recorded, adapter: createAdapter(testContext({ secrets: SECRETS, fetch: recorded.fetch, now: NOW, options: OPTIONS })) };
  };

  it("builds one tree on the base tree, deleting the old side of a rename and every deleted path", async () => {
    const { recorded, adapter } = adapterWith([baseCommit, blob, tree, noBranch, createCommit, createRef]);
    await adapter.commit({
      ...commitRequest,
      files: [
        { path: "docs/new.md", previousPath: "docs/old.md", change: "renamed", additions: 1, deletions: 1, mode: "100644", binary: false, content: { encoding: "utf-8", data: "new\n" } },
        { path: "src/legacy.ts", change: "deleted", additions: 0, deletions: 4, mode: "100644", binary: false, content: null },
        { path: "bin/run", change: "modified", additions: 1, deletions: 0, mode: "100755", binary: false, content: { encoding: "utf-8", data: "#!/bin/sh\n" } },
      ],
    });
    const treeCall = recorded.calls.find((c) => c.url.endsWith("/git/trees"));
    const body = (await treeCall?.json()) as { base_tree: string; tree: Array<{ path: string; mode: string; sha: string | null }> };
    expect(body.base_tree).toBe(BASE_TREE);
    expect(body.tree).toEqual([
      { path: "docs/old.md", mode: "100644", type: "blob", sha: null },
      { path: "docs/new.md", mode: "100644", type: "blob", sha: BLOB },
      { path: "src/legacy.ts", mode: "100644", type: "blob", sha: null },
      { path: "bin/run", mode: "100755", type: "blob", sha: BLOB },
    ]);
    const commitCall = recorded.calls.find((c) => c.method === "POST" && c.url.endsWith("/git/commits"));
    const commitBody = (await commitCall?.json()) as { parents: string[]; author: { name: string; email: string; date: string } };
    expect(commitBody.parents).toEqual([BASE_SHA]);
    expect(commitBody.author).toEqual({ name: "Acme ship loop", email: "ship@acme.example", date: NOW.toISOString() });
    const refCall = recorded.calls.find((c) => c.url.endsWith("/git/refs"));
    expect(await refCall?.json()).toEqual({ ref: "refs/heads/ship/task-0001", sha: COMMIT });
  });

  it("accepts a branch another attempt created first only when it holds this same change", async () => {
    const refTaken: RecordedRoute = { method: "POST", url: `${API}/repos/acme/app/git/refs`, respond: json({ message: "Reference already exists" }, { status: 422 }) };
    const raced = adapterWith([baseCommit, blob, tree, { ...noBranch, times: 1 }, createCommit, refTaken, branchAtCommit]);
    expect(await raced.adapter.commit(commitRequest)).toEqual({ repo: REPO, branch: "ship/task-0001", commitSha: COMMIT, treeSha: TREE, created: false });
    const elsewhere: RecordedRoute = { method: "GET", url: branchRef, respond: json({ object: { sha: sha("8") } }) };
    const foreign: RecordedRoute = { method: "GET", url: `${API}/repos/acme/app/git/commits/${sha("8")}`, respond: json({ tree: { sha: OTHER_TREE }, parents: [{ sha: BASE_SHA }] }) };
    const lost = adapterWith([baseCommit, blob, tree, { ...noBranch, times: 1 }, createCommit, refTaken, elsewhere, foreign]);
    expect(await lost.adapter.commit(commitRequest).catch((e: unknown) => (e as AdapterError).code)).toBe("invalid");
  });

  it("refuses a change that leaves the tree as it was", async () => {
    const same: RecordedRoute = { method: "POST", url: `${API}/repos/acme/app/git/trees`, respond: json({ sha: BASE_TREE }, { status: 201 }) };
    const { adapter } = adapterWith([baseCommit, blob, same]);
    expect(await adapter.commit(commitRequest).catch((e: unknown) => (e as AdapterError).code)).toBe("invalid");
  });

  it("refuses a pull request into a ship branch", async () => {
    const { recorded, adapter } = adapterWith([]);
    expect(await adapter.openPullRequest({ repo: REPO, taskId: "task-0001", base: "ship/other", title: "x", body: "" }).catch((e: unknown) => (e as AdapterError).code)).toBe("invalid");
    expect(recorded.calls).toHaveLength(0);
  });

  it("combines check runs and commit statuses, naming the failing ones", async () => {
    const { adapter } = adapterWith([
      { method: "GET", url: `${API}/repos/acme/app/commits/${COMMIT}/check-runs?per_page=100`, respond: json({ check_runs: [{ name: "lint", status: "completed", conclusion: "success" }, { name: "test", status: "completed", conclusion: "failure" }, { name: "e2e", status: "in_progress", conclusion: null }] }) },
      { method: "GET", url: `${API}/repos/acme/app/commits/${COMMIT}/status`, respond: json({ state: "failure", statuses: [{ context: "deploy/preview", state: "error" }] }) },
    ]);
    expect(await adapter.checks(REPO, COMMIT)).toEqual({ state: "failure", failing: ["test", "deploy/preview"] });
  });

  it("reads a pull request's state, with the merge commit only once it merged", async () => {
    const { adapter } = adapterWith([
      { method: "GET", url: `${API}/repos/acme/app/pulls/7`, respond: json(pr({ state: "closed", merged: true, merge_commit_sha: MERGE })) },
      { method: "GET", url: `${API}/repos/acme/app/pulls/8`, respond: json({ message: "Not Found" }, { status: 404 }) },
    ]);
    expect(await adapter.pullRequest(REPO, 7)).toEqual({ number: 7, url: "https://github.com/acme/app/pull/7", state: "closed", merged: true, mergeCommitSha: MERGE, headSha: COMMIT, headBranch: "ship/task-0001", baseBranch: "main" });
    expect(await adapter.pullRequest(REPO, 8)).toBeNull();
  });

  it("reads a large file's size without its content, and binary content as base64", async () => {
    const { adapter } = adapterWith([
      { method: "GET", url: `${API}/repos/acme/app/contents/assets/logo.png?ref=${BASE_SHA}`, respond: json({ type: "file", size: 4, encoding: "base64", content: btoa("\u0089PN\u0000") }) },
      { method: "GET", url: `${API}/repos/acme/app/contents/data/big.json?ref=${BASE_SHA}`, respond: json({ type: "file", size: 5_000_000, encoding: "none", content: "" }) },
    ]);
    expect(await adapter.readFile({ repo: REPO, path: "assets/logo.png", ref: BASE_SHA })).toEqual({ size: 4, encoding: "base64", data: btoa("\u0089PN\u0000") });
    expect(await adapter.readFile({ repo: REPO, path: "data/big.json", ref: BASE_SHA, maxBytes: 1_000_000 })).toEqual({ size: 5_000_000, encoding: "base64", data: null });
  });

  it("refuses to read a directory as if it were a missing file", async () => {
    const { adapter } = adapterWith([{ method: "GET", url: `${API}/repos/acme/app/contents/src?ref=main`, respond: json([{ type: "file", name: "a.ts" }]) }]);
    expect(await adapter.readFile({ repo: REPO, path: "src", ref: "main" }).catch((e: unknown) => (e as AdapterError).code)).toBe("invalid");
  });

  it("refuses a chunked webhook body past the size cap without buffering it", async () => {
    const big = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(512 * 1024).fill(32)); } });
    const request = new Request("https://agent.acme.example/api/webhooks/code", { method: "POST", headers: { "x-hub-signature-256": `sha256=${"0".repeat(64)}`, "x-github-event": "ping", "x-github-delivery": "d-1" }, body: big, duplex: "half" } as RequestInit);
    expect(await adapterWith([]).adapter.verifyWebhook(request).catch((e: unknown) => (e as AdapterError).code)).toBe("invalid");
  });

  it("keeps repository paths inside the work tree", () => {
    expect(safeRepoPath("src/index.ts")).toBe(true);
    for (const bad of ["", "/abs", "a/../b", "./a", "a//b", ".git/HEAD", "sub/.GIT/config", "a\\b", "a\u0000b", "a\nb"]) expect(safeRepoPath(bad), bad).toBe(false);
    expect(() => assertCommittable([{ ...commitRequest.files[0]!, path: "a.txt" }, { ...commitRequest.files[0]!, path: "a.txt" }])).toThrow(AdapterError);
    expect(() => assertCommittable([{ ...commitRequest.files[0]!, content: { encoding: "base64", data: "%%%" } }])).toThrow(AdapterError);
  });

  it("normalizes repositories, names and content", () => {
    expect(normalizeRepo(" Acme/App ")).toBe("acme/app");
    expect(normalizeRepo("acme/app.git")).toBeNull();
    expect(normalizeRepo("acme")).toBeNull();
    expect(cleanName("a\u202eb\u0000c")).toBe("a b c");
    expect(encodeContent(new TextEncoder().encode("plain"))).toEqual({ encoding: "utf-8", data: "plain" });
    expect(encodeContent(new Uint8Array([0xff, 0xfe]))).toEqual({ encoding: "base64", data: "//4=" });
    expect(classifyStatus(403, new Headers())).toEqual({ code: "auth", retryable: false });
    expect(mapGithubEvent("deployment_status", "d-1", { repository, deployment: { sha: MERGE, environment: "staging" }, deployment_status: { state: "in_progress" } }, [REPO])).toEqual({
      type: "deployment",
      deliveryId: "d-1",
      repo: REPO,
      sha: MERGE,
      environment: "staging",
      productionEnvironment: null,
      state: "pending",
    });
  });
});
