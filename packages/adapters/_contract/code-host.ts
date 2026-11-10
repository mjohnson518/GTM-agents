// GTM-agents: the shared contract every CodeHost adapter runs in its contract.test.ts.
//
//   runCodeHostContract(createAdapter, fixtures)
//
// With recorded responses and locally signed webhooks only, it checks that:
//   - the manifest validates, declares the CodeHost port, requires the token and the webhook
//     secret, and declares no tool that merges (merging code is permanently human);
//   - verifyWebhook refuses before reading the body when the secret is unset ("unavailable") or the
//     request is unsigned ("auth"); Request.bodyUsed proves the body was never read. A tampered
//     body, or one signed with another secret, is "auth";
//   - there is a recorded case for every event type (ping, pull_request, check, deployment and
//     ignored), each maps to exactly the expected CodeHostEvent, and a signed body the vendor would
//     never send is "invalid";
//   - every method refuses a repository outside the allowlist with "invalid" before any request,
//     and a missing token fails with "auth" before any request;
//   - commit on a fresh branch creates it; a retry against the branch it already made returns the
//     same commit with created false and writes no ref; a branch holding other work is refused and
//     never moved. No request ever writes the base branch, forces a ref, or merges; unsafe files
//     (a path out of the repository, a .git path, a submodule) are refused before any request;
//   - openPullRequest opens one when none exists and returns the existing one, without writing,
//     when it does;
//   - contains answers true for a commit in another's history and for the same commit, false for
//     one that is not, and throws (never answers) when the comparison fails;
//   - for a host that can commit through a fork (fixtures.fork): the commit lands on the task
//     branch in the fork with exactly one ref write, and no request writes the target; a fork that
//     is behind is brought up to the base commit first; a fork whose base branch has commits of
//     its own is refused with nothing written; a missing fork token fails with "auth" before any
//     request and makes pushRefusal give a reason; the pull request is opened in the target;
//   - readFile answers from recorded responses and null for a missing file;
//   - recorded failures become AdapterErrors with the expected code, and the adapter uses only the
//     injected fetch, never the global one.
import { AdapterError, manifestSchema, type AdapterContext, type AdapterErrorCode, type CodeHost, type CodeHostEvent, type CommitRequest, type PathKind, type PullRequestRequest, type RepoFile } from "@gtm-agents/core/ports";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testContext } from "./context.ts";
import { recordedFetch, type RecordedRoute } from "./fetch.ts";

export const CODE_HOST_EVENT_TYPES = ["ping", "pull_request", "check", "deployment", "ignored"] as const;

export interface WebhookSignOptions {
  /** The delivery id to send (vendors that do not sign it): the same body under another id is a replay. */
  deliveryId?: string;
  /** Sign with this secret instead of the configured one. */
  secret?: string;
  /** Change the body after signing it. */
  tamper?: boolean;
  /** Send no signature at all. */
  unsigned?: boolean;
}

export interface CodeHostFixtures {
  manifest: unknown;
  /** Every secret the adapter needs, set. */
  secrets: Record<string, string>;
  tokenName: string;
  webhookSecretName: string;
  /** Options that allowlist `repo` and not `otherRepo`. */
  options: Record<string, unknown>;
  now: Date;
  repo: string;
  otherRepo: string;
  baseBranch: string;
  /** A webhook request for `event` carrying `body`, signed the vendor's way. */
  webhook(event: string, body: string, options?: WebhookSignOptions): Promise<Request>;
  /** One case per event type at least. */
  events: Array<{ name: string; event: string; body: string; expected: CodeHostEvent }>;
  /** Signed bodies that are not events the vendor sends. */
  invalidBodies: Array<{ event: string; body: string }>;
  /** True for a request that creates, moves or deletes a branch. */
  isRefWrite(request: Request): boolean;
  commit: {
    request: CommitRequest;
    /** The branch does not exist yet. */
    fresh: RecordedRoute[];
    /** The branch already points at a commit with this tree and parent. */
    retry: RecordedRoute[];
    /** The branch already points at something else. */
    conflict: RecordedRoute[];
    /** The result without `created`; its repo is the target. */
    expected: { repo: string; branch: string; commitSha: string; treeSha: string };
  };
  pullRequest: {
    request: PullRequestRequest;
    fresh: RecordedRoute[];
    existing: RecordedRoute[];
    expected: { number: number; url: string };
  };
  /**
   * Recorded comparisons. The cases cover a descendant (true), the same commit (true) and a commit
   * that does not contain the ancestor (false); `failing` is a comparison the host fails.
   */
  contains: {
    routes: RecordedRoute[];
    cases: Array<{ name: string; ancestor: string; descendant: string; expected: boolean }>;
    failing: { routes: RecordedRoute[]; ancestor: string; descendant: string };
  };
  /** For a host that can commit through a fork: options that send `repo`'s ship branches to `forkRepo`. */
  fork?: {
    options: Record<string, unknown>;
    /** Every secret, the fork's token included. */
    secrets: Record<string, string>;
    forkTokenName: string;
    forkRepo: string;
    /** True for a request addressed to the fork rather than the target. */
    isForkRequest(request: Request): boolean;
    commit: {
      /** The fork's copy of the base branch already reaches the base commit. */
      fresh: RecordedRoute[];
      /** The fork's copy is behind the target's, and is brought up to the base commit first. */
      behind: RecordedRoute[];
      /** The fork's copy has commits the target does not have. */
      diverged: RecordedRoute[];
      expected: { branch: string; commitSha: string; treeSha: string };
    };
    pullRequest: { fresh: RecordedRoute[]; existing: RecordedRoute[]; expected: { number: number; url: string } };
  };
  readFile: { path: string; ref: string; routes: RecordedRoute[]; expected: RepoFile; missingPath: string };
  /** A recorded answer for each kind of path: the gatekeeper tells a directory from a file, symlink or submodule with it. */
  pathKinds: { ref: string; routes: RecordedRoute[]; cases: Array<{ path: string; expected: PathKind }> };
  failures: Array<{ name: string; routes: RecordedRoute[]; code: AdapterErrorCode; retryable: boolean }>;
}

async function adapterError(promise: Promise<unknown>): Promise<AdapterError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterError);
    return error as AdapterError;
  }
  throw new Error("expected an AdapterError, but the call succeeded");
}

async function bodyText(request: Request): Promise<string> {
  try {
    return await request.clone().text();
  } catch {
    return "";
  }
}

export function runCodeHostContract(create: (ctx: AdapterContext) => CodeHost, fixtures: CodeHostFixtures): void {
  describe("the CodeHost contract", () => {
    let globalFetch: { mock: { calls: unknown[] }; mockRestore(): void };
    beforeEach(() => {
      globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        throw new Error("adapters use ctx.fetch, never the global fetch");
      });
    });
    afterEach(() => {
      const calls = globalFetch.mock.calls.length;
      globalFetch.mockRestore();
      expect(calls, "the adapter called the global fetch").toBe(0);
    });

    const adapterWith = (routes: RecordedRoute[] = [], secrets = fixtures.secrets, options = fixtures.options) => {
      const recorded = recordedFetch(routes);
      return { recorded, adapter: create(testContext({ secrets, fetch: recorded.fetch, now: fixtures.now, options })) };
    };
    const sample = fixtures.events[0] ?? { event: "ping", body: "{}" };

    /** No request may write the base branch, force a ref, or merge. */
    const assertNoForbiddenWrites = async (calls: Request[]) => {
      for (const call of calls) {
        const url = new URL(call.url);
        expect(url.pathname, `${call.method} ${url.pathname} merges`).not.toMatch(/\/merges?(?:\/|$)/);
        if (call.method === "GET" || call.method === "HEAD") continue;
        const body = await bodyText(call);
        expect(body, "a request forces a ref").not.toMatch(/"force"\s*:\s*true/);
        const baseRef = `heads/${fixtures.baseBranch}`;
        expect(decodeURIComponent(url.pathname).endsWith(baseRef) || body.includes(`"refs/${baseRef}"`), "a request writes the base branch").toBe(false);
      }
    };

    it("has a manifest that validates, declares the port and its secrets, and has no tool that merges", () => {
      const manifest = manifestSchema.parse(fixtures.manifest);
      expect(manifest.ports).toContain("CodeHost");
      expect(manifest.requiredSecrets).toContain(fixtures.tokenName);
      expect(manifest.requiredSecrets).toContain(fixtures.webhookSecretName);
      for (const [name, tool] of Object.entries(manifest.tools)) {
        expect(name, "a code host tool merges").not.toMatch(/merge/);
        if (tool.taint === "none") expect(tool.gate, `${name} writes and must be refused once anything untrusted is read`).toBe("metadata");
      }
    });

    it("refuses a webhook before reading the body when the secret is unset or the request is unsigned", async () => {
      const without = { ...fixtures.secrets };
      delete without[fixtures.webhookSecretName];
      const unset = await fixtures.webhook(sample.event, sample.body);
      expect((await adapterError(adapterWith([], without).adapter.verifyWebhook(unset))).code).toBe("unavailable");
      expect(unset.bodyUsed).toBe(false);
      const unsigned = await fixtures.webhook(sample.event, sample.body, { unsigned: true });
      expect((await adapterError(adapterWith().adapter.verifyWebhook(unsigned))).code).toBe("auth");
      expect(unsigned.bodyUsed).toBe(false);
    });

    it("refuses a tampered webhook and one signed with another secret", async () => {
      expect((await adapterError(adapterWith().adapter.verifyWebhook(await fixtures.webhook(sample.event, sample.body, { tamper: true })))).code).toBe("auth");
      expect((await adapterError(adapterWith().adapter.verifyWebhook(await fixtures.webhook(sample.event, sample.body, { secret: "x".repeat(48) })))).code).toBe("auth");
    });

    it("has a case for every event type", () => {
      const covered = new Set(fixtures.events.map((e) => e.expected.type));
      for (const type of CODE_HOST_EVENT_TYPES) expect(covered.has(type), type).toBe(true);
    });

    for (const event of fixtures.events) {
      it(`maps ${event.name}`, async () => {
        const mapped = await adapterWith().adapter.verifyWebhook(await fixtures.webhook(event.event, event.body));
        const { digest, ...body } = mapped;
        expect(body).toEqual(event.expected);
        // A digest, when the adapter gives one, covers what was signed: the same body sent again
        // under another delivery id has the same digest.
        if (digest !== undefined) {
          expect(typeof digest === "string" && digest.length >= 16).toBe(true);
          const again = await adapterWith().adapter.verifyWebhook(await fixtures.webhook(event.event, event.body, { deliveryId: "replayed-delivery-0001" }));
          expect(again.digest).toBe(digest);
        }
        expect(mapped.deliveryId.length).toBeGreaterThan(0);
      });
    }

    it("refuses a signed body that is not an event the vendor sends", async () => {
      for (const bad of fixtures.invalidBodies) expect((await adapterError(adapterWith().adapter.verifyWebhook(await fixtures.webhook(bad.event, bad.body)))).code, bad.body).toBe("invalid");
    });

    it("refuses a repository outside the allowlist before any request", async () => {
      const { recorded, adapter } = adapterWith();
      expect(adapter.allowedRepos()).toContain(fixtures.repo.toLowerCase());
      expect(adapter.allowedRepos()).not.toContain(fixtures.otherRepo.toLowerCase());
      const other = fixtures.otherRepo;
      const calls: Array<Promise<unknown>> = [
        adapter.branchHead(other, fixtures.baseBranch),
        adapter.readFile({ repo: other, path: fixtures.readFile.path, ref: fixtures.readFile.ref }),
        adapter.commit({ ...fixtures.commit.request, repo: other }),
        adapter.openPullRequest({ ...fixtures.pullRequest.request, repo: other }),
        adapter.pullRequest(other, 1),
        adapter.checks(other, fixtures.commit.request.baseSha),
        adapter.contains(other, fixtures.commit.request.baseSha, fixtures.commit.expected.commitSha),
      ];
      for (const call of calls) expect((await adapterError(call)).code).toBe("invalid");
      expect(recorded.calls).toHaveLength(0);
    });

    it("fails before any request when the token is missing", async () => {
      const without = { ...fixtures.secrets };
      delete without[fixtures.tokenName];
      const { recorded, adapter } = adapterWith(fixtures.commit.fresh, without);
      expect((await adapterError(adapter.commit(fixtures.commit.request))).code).toBe("auth");
      expect((await adapterError(adapter.branchHead(fixtures.repo, fixtures.baseBranch))).code).toBe("auth");
      expect(recorded.calls).toHaveLength(0);
    });

    it("commits once to a fresh task branch and never writes the base branch, forces or merges", async () => {
      const { recorded, adapter } = adapterWith(fixtures.commit.fresh);
      const result = await adapter.commit(fixtures.commit.request);
      expect(result).toEqual({ ...fixtures.commit.expected, created: true });
      expect(recorded.calls.filter((c) => fixtures.isRefWrite(c))).toHaveLength(1);
      await assertNoForbiddenWrites(recorded.calls);
    });

    it("returns the same commit on a retry without writing a ref", async () => {
      const { recorded, adapter } = adapterWith(fixtures.commit.retry);
      expect(await adapter.commit(fixtures.commit.request)).toEqual({ ...fixtures.commit.expected, created: false });
      expect(recorded.calls.filter((c) => fixtures.isRefWrite(c))).toHaveLength(0);
      await assertNoForbiddenWrites(recorded.calls);
    });

    it("refuses a task branch that holds other work, and never moves it", async () => {
      const { recorded, adapter } = adapterWith(fixtures.commit.conflict);
      expect((await adapterError(adapter.commit(fixtures.commit.request))).code).toBe("invalid");
      expect(recorded.calls.filter((c) => fixtures.isRefWrite(c))).toHaveLength(0);
      await assertNoForbiddenWrites(recorded.calls);
    });

    it("refuses unsafe files before any request", async () => {
      const file = fixtures.commit.request.files[0];
      if (!file) throw new Error("the commit fixture needs at least one file");
      const unsafe = [
        { ...file, path: "../outside.txt" },
        { ...file, path: ".git/config" },
        { ...file, path: "/etc/passwd" },
        { ...file, mode: "160000" },
      ];
      for (const bad of unsafe) {
        const { recorded, adapter } = adapterWith(fixtures.commit.fresh);
        expect((await adapterError(adapter.commit({ ...fixtures.commit.request, files: [bad] }))).code, bad.path).toBe("invalid");
        expect(recorded.calls, bad.path).toHaveLength(0);
      }
      const { recorded, adapter } = adapterWith(fixtures.commit.fresh);
      expect((await adapterError(adapter.commit({ ...fixtures.commit.request, files: [] }))).code).toBe("invalid");
      expect(recorded.calls).toHaveLength(0);
    });

    it("opens a pull request once, and returns the existing one without writing", async () => {
      const fresh = adapterWith(fixtures.pullRequest.fresh);
      const opened = await fresh.adapter.openPullRequest(fixtures.pullRequest.request);
      expect(opened).toMatchObject({ ...fixtures.pullRequest.expected, created: true });
      await assertNoForbiddenWrites(fresh.recorded.calls);
      const existing = adapterWith(fixtures.pullRequest.existing);
      const found = await existing.adapter.openPullRequest(fixtures.pullRequest.request);
      expect(found).toMatchObject({ ...fixtures.pullRequest.expected, created: false });
      expect(existing.recorded.calls.every((c) => c.method === "GET")).toBe(true);
    });

    it("answers whether one commit contains another, and throws rather than answer when the comparison fails", async () => {
      const answers = new Set(fixtures.contains.cases.map((c) => c.expected));
      expect(answers.has(true) && answers.has(false), "the cases need a commit that contains the ancestor and one that does not").toBe(true);
      expect(fixtures.contains.cases.some((c) => c.ancestor === c.descendant && c.expected), "the cases need the same commit").toBe(true);
      const { adapter, recorded } = adapterWith(fixtures.contains.routes);
      for (const c of fixtures.contains.cases) expect(await adapter.contains(fixtures.repo, c.ancestor, c.descendant), c.name).toBe(c.expected);
      expect(recorded.calls.every((c) => c.method === "GET"), "a comparison writes").toBe(true);
      const failing = adapterWith(fixtures.contains.failing.routes);
      await adapterError(failing.adapter.contains(fixtures.repo, fixtures.contains.failing.ancestor, fixtures.contains.failing.descendant));
    });

    const fork = fixtures.fork;
    if (fork) {
      describe("through a fork", () => {
        const forkAdapter = (routes: RecordedRoute[], secrets = fork.secrets) => adapterWith(routes, secrets, fork.options);
        /** In fork mode nothing but opening the pull request may write the target. */
        const writes = (calls: Request[]) => calls.filter((c) => c.method !== "GET" && c.method !== "HEAD");

        it("declares the fork's token as an optional secret", () => {
          expect(manifestSchema.parse(fixtures.manifest).optionalSecrets).toContain(fork.forkTokenName);
        });

        it("commits once to the task branch in the fork and writes nothing in the target", async () => {
          const { recorded, adapter } = forkAdapter(fork.commit.fresh);
          expect(await adapter.commit(fixtures.commit.request)).toEqual({ ...fork.commit.expected, repo: fork.forkRepo.toLowerCase(), created: true });
          const refWrites = recorded.calls.filter((c) => fixtures.isRefWrite(c));
          expect(refWrites).toHaveLength(1);
          expect(refWrites.every((c) => fork.isForkRequest(c)), "a ref was written outside the fork").toBe(true);
          expect(writes(recorded.calls).every((c) => fork.isForkRequest(c)), "the commit wrote the target").toBe(true);
          await assertNoForbiddenWrites(recorded.calls);
        });

        it("brings a fork that is behind up to the base commit before it commits, forcing nothing", async () => {
          const { recorded, adapter } = forkAdapter(fork.commit.behind);
          expect(await adapter.commit(fixtures.commit.request)).toEqual({ ...fork.commit.expected, repo: fork.forkRepo.toLowerCase(), created: true });
          expect(recorded.calls.filter((c) => fixtures.isRefWrite(c))).toHaveLength(1);
          expect(writes(recorded.calls).every((c) => fork.isForkRequest(c)), "the sync or the commit wrote the target").toBe(true);
          await assertNoForbiddenWrites(recorded.calls);
        });

        it("refuses a fork whose base branch has commits of its own, and writes nothing", async () => {
          const { recorded, adapter } = forkAdapter(fork.commit.diverged);
          expect((await adapterError(adapter.commit(fixtures.commit.request))).code).toBe("invalid");
          expect(writes(recorded.calls)).toHaveLength(0);
        });

        it("fails before any request when the fork's token is missing, and pushRefusal says so", async () => {
          const without = { ...fork.secrets };
          delete without[fork.forkTokenName];
          const { recorded, adapter } = forkAdapter(fork.commit.fresh, without);
          expect(adapter.pushRefusal()).toEqual(expect.stringContaining(fork.forkTokenName));
          expect((await adapterError(adapter.commit(fixtures.commit.request))).code).toBe("auth");
          expect(recorded.calls).toHaveLength(0);
        });

        it("opens the pull request in the target from the fork's branch, once", async () => {
          const fresh = forkAdapter(fork.pullRequest.fresh);
          expect(await fresh.adapter.openPullRequest(fixtures.pullRequest.request)).toMatchObject({ ...fork.pullRequest.expected, created: true });
          const opened = writes(fresh.recorded.calls);
          expect(opened).toHaveLength(1);
          expect(opened.some((c) => fork.isForkRequest(c)), "the pull request was opened in the fork").toBe(false);
          const existing = forkAdapter(fork.pullRequest.existing);
          expect(await existing.adapter.openPullRequest(fixtures.pullRequest.request)).toMatchObject({ ...fork.pullRequest.expected, created: false });
          expect(writes(existing.recorded.calls)).toHaveLength(0);
        });
      });
    }

    it("answers pushRefusal with a reason or null, without a request", () => {
      const { adapter, recorded } = adapterWith([]);
      const refusal = adapter.pushRefusal();
      expect(refusal === null || (typeof refusal === "string" && refusal.length > 0)).toBe(true);
      expect(recorded.calls).toHaveLength(0);
    });

    it("tells a missing path, a file, a symlink, a directory and a submodule apart", async () => {
      const kinds = new Set(fixtures.pathKinds.cases.map((c) => c.expected));
      for (const kind of ["missing", "file", "symlink", "directory", "submodule"] as const) expect(kinds.has(kind), kind).toBe(true);
      const { adapter } = adapterWith(fixtures.pathKinds.routes);
      for (const c of fixtures.pathKinds.cases) expect(await adapter.pathKind({ repo: fixtures.repo, path: c.path, ref: fixtures.pathKinds.ref }), c.path).toBe(c.expected);
    });

    it("reads a file through the injected fetch, and null for a missing one", async () => {
      const { adapter } = adapterWith(fixtures.readFile.routes);
      expect(await adapter.readFile({ repo: fixtures.repo, path: fixtures.readFile.path, ref: fixtures.readFile.ref })).toEqual(fixtures.readFile.expected);
      expect(await adapter.readFile({ repo: fixtures.repo, path: fixtures.readFile.missingPath, ref: fixtures.readFile.ref })).toBeNull();
    });

    for (const failure of fixtures.failures) {
      it(`maps a failure: ${failure.name}`, async () => {
        const error = await adapterError(adapterWith(failure.routes).adapter.branchHead(fixtures.repo, fixtures.baseBranch));
        expect(error.code).toBe(failure.code);
        expect(error.retryable).toBe(failure.retryable);
      });
    }
  });
}
