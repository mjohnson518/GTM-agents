// GTM-agents: a CodeHost for the ship build's tests: an in-memory repository at one base commit,
// commits and pull requests that are idempotent per task the way the port requires, a commit
// history that contains() answers from, an optional fork the ship branches go to, and webhooks
// "signed" with a shared secret in a header. No vendor is involved, and every repository, commit
// and pull request is invented.
import { AdapterError, shipBranch, type ChecksState, type CodeHost, type CodeHostEvent, type CommitRequest, type CommitResult, type PathKind, type PullRequestRef, type PullRequestRequest, type PullRequestState } from "@gtm-agents/core/ports";

export const FAKE_SIGNATURE_HEADER = "x-fake-code-signature";
export const FAKE_BASE_SHA = "b".repeat(40);

export interface FakeCodeHostOptions {
  /** The allowlisted repository, lowercase owner/name. */
  repo: string;
  webhookSecret: string;
  /** The files at the base commit: path to text. */
  files?: Record<string, string>;
  /** What pushRefusal answers; null (the default) means pushing is allowed. */
  pushRefusal?: string | null;
  /** Paths that are a symlink or submodule (or anything else) at the base commit, overriding what files implies. */
  kinds?: Record<string, PathKind>;
  baseSha?: string;
  /** Commit the ship branches to this fork (lowercase owner/name) instead of the repository. */
  fork?: string;
}

export interface FakeCodeHost extends CodeHost {
  /** The files at the base commit. */
  files: Map<string, string>;
  kinds?: Map<string, PathKind>;
  commits: CommitRequest[];
  pulls: PullRequestRequest[];
  /** Every method call, by name, in order. Nothing in the port merges, so "merge" can never appear. */
  calls: string[];
  /** Webhook bodies read: stays put for a request refused on its signature. */
  bodiesRead: number;
  /** Make the next commit throw, to test a failing step. */
  failCommit: Error | null;
  /** The history contains() answers from: a commit to the commits it has in its history. */
  history: Map<string, Set<string>>;
  /** Every contains() call, as [ancestor, descendant]. */
  compared: Array<[string, string]>;
  /** Make contains() throw this, to test a comparison that fails. */
  failContains: Error | null;
}

const sha = (n: number) => n.toString(16).padStart(40, "0");

export function fakeCodeHost(options: FakeCodeHostOptions): FakeCodeHost {
  const repo = options.repo.toLowerCase();
  const baseSha = options.baseSha ?? FAKE_BASE_SHA;
  const committed = new Map<string, { result: CommitResult; fingerprint: string }>();
  const opened = new Map<string, PullRequestRef>();
  let next = 1;
  const assertRepo = (r: string) => {
    if (r.toLowerCase() !== repo) throw new AdapterError("the repository is not in options.repos", "invalid", false);
  };
  const host: FakeCodeHost = {
    name: "fake-code-host",
    files: new Map(Object.entries(options.files ?? {})),
    ...(options.kinds ? { kinds: new Map(Object.entries(options.kinds)) } : {}),
    commits: [],
    pulls: [],
    calls: [],
    bodiesRead: 0,
    failCommit: null,
    history: new Map(),
    compared: [],
    failContains: null,
    allowedRepos: () => [repo],
    pushRefusal: () => options.pushRefusal ?? null,
    branchHead(r, branch) {
      host.calls.push("branchHead");
      assertRepo(r);
      return Promise.resolve(branch === "main" ? baseSha : null);
    },
    readFile(args) {
      host.calls.push("readFile");
      assertRepo(args.repo);
      const text = host.files.get(args.path);
      if (text === undefined) {
        if ([...host.files.keys()].some((k) => k.startsWith(`${args.path}/`))) return Promise.reject(new AdapterError("the path is a directory or submodule at that ref", "invalid", false));
        return Promise.resolve(null);
      }
      const size = new TextEncoder().encode(text).length;
      if (args.maxBytes !== undefined && size > args.maxBytes) return Promise.resolve({ size, encoding: "base64" as const, data: null });
      return Promise.resolve({ size, encoding: "utf-8" as const, data: text });
    },
    pathKind(args) {
      host.calls.push("pathKind");
      assertRepo(args.repo);
      if (host.files.has(args.path)) return Promise.resolve(host.kinds?.get(args.path) ?? ("file" as const));
      if ([...host.files.keys()].some((k) => k.startsWith(`${args.path}/`))) return Promise.resolve(host.kinds?.get(args.path) ?? ("directory" as const));
      return Promise.resolve(host.kinds?.get(args.path) ?? ("missing" as const));
    },
    commit(req) {
      host.calls.push("commit");
      assertRepo(req.repo);
      if (host.failCommit) return Promise.reject(host.failCommit);
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(req.baseBranch) || req.baseBranch.startsWith("ship/")) return Promise.reject(new AdapterError("the base branch is not a branch a ship change can target", "invalid", false));
      const branch = shipBranch(req.taskId);
      const fingerprint = JSON.stringify([req.baseSha, req.files]);
      const existing = committed.get(branch);
      if (existing) {
        if (existing.fingerprint !== fingerprint) return Promise.reject(new AdapterError(`${branch} already holds other work; it is never forced`, "invalid", false));
        return Promise.resolve({ ...existing.result, created: false });
      }
      host.commits.push(req);
      const result: CommitResult = { repo: options.fork?.toLowerCase() ?? repo, branch, commitSha: sha(0xc0 + next), treeSha: sha(0xd0 + next), created: true };
      next += 1;
      committed.set(branch, { result, fingerprint });
      return Promise.resolve(result);
    },
    openPullRequest(req) {
      host.calls.push("openPullRequest");
      assertRepo(req.repo);
      const branch = shipBranch(req.taskId);
      const commit = committed.get(branch);
      if (!commit) return Promise.reject(new AdapterError("the branch does not exist", "invalid", false));
      const existing = opened.get(branch);
      if (existing) return Promise.resolve({ ...existing, created: false });
      host.pulls.push(req);
      const number = 40 + host.pulls.length;
      const ref: PullRequestRef = { number, url: `https://code.example/${repo}/pull/${number}`, headSha: commit.result.commitSha, created: true };
      opened.set(branch, ref);
      return Promise.resolve(ref);
    },
    pullRequest(r, number): Promise<PullRequestState | null> {
      host.calls.push("pullRequest");
      assertRepo(r);
      for (const [branch, ref] of opened) if (ref.number === number) return Promise.resolve({ number, url: ref.url, state: "open", merged: false, mergeCommitSha: null, headSha: ref.headSha, headBranch: branch, baseBranch: "main" });
      return Promise.resolve(null);
    },
    checks(r): Promise<ChecksState> {
      host.calls.push("checks");
      assertRepo(r);
      return Promise.resolve({ state: "none", failing: [] });
    },
    contains(r, ancestorSha, descendantSha) {
      host.calls.push("contains");
      assertRepo(r);
      host.compared.push([ancestorSha, descendantSha]);
      if (host.failContains) return Promise.reject(host.failContains);
      return Promise.resolve(ancestorSha === descendantSha || (host.history.get(descendantSha)?.has(ancestorSha) ?? false));
    },
    async verifyWebhook(request) {
      host.calls.push("verifyWebhook");
      if (!options.webhookSecret) throw new AdapterError("the webhook secret is not set", "unavailable", false);
      if (request.headers.get(FAKE_SIGNATURE_HEADER) !== options.webhookSecret) throw new AdapterError("the webhook signature does not match", "auth", false);
      const body = await request.text();
      host.bodiesRead += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new AdapterError("the webhook body is not JSON", "invalid", false);
      }
      const event = (parsed as { event?: CodeHostEvent }).event;
      if (!event || typeof event.type !== "string" || typeof event.deliveryId !== "string") throw new AdapterError("the webhook body is not an event", "invalid", false);
      return event;
    },
  };
  return host;
}

/**
 * A webhook request the fake host accepts. `extra` adds fields beside the event, the way a real
 * payload carries fields the handler must never trust.
 */
export function fakeCodeWebhook(event: CodeHostEvent, options: { secret: string; unsigned?: boolean; extra?: Record<string, unknown>; url?: string }): Request {
  return new Request(options.url ?? "https://agent.acme.example/api/webhooks/code", {
    method: "POST",
    headers: { "content-type": "application/json", ...(options.unsigned ? {} : { [FAKE_SIGNATURE_HEADER]: options.secret }) },
    body: JSON.stringify({ ...(options.extra ?? {}), event }),
  });
}
