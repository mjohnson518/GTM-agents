// GTM-agents: ports for the build side of the optional ship module (docs/SHIP.md): the code host,
// which holds the repositories, takes one commit per task and carries pull requests, checks and
// their webhooks, and the coding sandbox, a container with no credentials in which a coding agent
// edits a read-only clone. docs/INTERFACES.md is the reference for both.
//
// Neither port can merge. Merging code is permanently human (merge_code), so no method here does
// it, and an adapter must not add one.

/** Every ship branch starts with this; the rest is the task id. */
export const SHIP_BRANCH_PREFIX = "ship/";

/** Task ids the build side accepts: they become a branch name, a sandbox name and a Workflow instance id. */
export const SHIP_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The branch a task's commit lands on: deterministic, so a retry finds the branch it already made. */
export function shipBranch(taskId: string): string {
  if (!SHIP_TASK_ID.test(taskId)) throw new RangeError("a ship task id is 1 to 64 letters, digits, '-' or '_', starting with a letter or digit");
  return `${SHIP_BRANCH_PREFIX}${taskId}`;
}

/**
 * One changed file exactly as it would be committed. The ship module's contract declares the same
 * shape, and the module checks at compile time that the two stay identical.
 */
export interface ChangedFile {
  /** Repository-relative, forward slashes, no `.` or `..` segments. */
  path: string;
  change: "added" | "modified" | "deleted" | "renamed";
  /** For a rename, the path it had before. */
  previousPath?: string;
  additions: number;
  deletions: number;
  /** Git file mode after the change: "100644", "100755", "120000" (symlink), "160000" (submodule). */
  mode: string;
  binary: boolean;
  /** The content after the change; null when deleted. Binary content is base64. */
  content: { encoding: "utf-8" | "base64"; data: string } | null;
}

/** What a path holds at a ref. */
export type PathKind = "missing" | "file" | "symlink" | "directory" | "submodule";

/** A file read from a repository. Repository text is written by other people: full taint. */
export interface RepoFile {
  /** Size in bytes. */
  size: number;
  encoding: "utf-8" | "base64";
  /** The content, or null when the file is larger than the caller's maxBytes. */
  data: string | null;
}

export interface CommitRequest {
  /** owner/name: the repository the pull request will target. */
  repo: string;
  /** The branch is shipBranch(taskId); it is never the base branch. */
  taskId: string;
  /** The commit the change was made against: the new commit's only parent. */
  baseSha: string;
  /**
   * The branch baseSha was read from. It is never written in `repo`. A host that commits through
   * a fork uses it to bring the fork's copy of that branch up to baseSha first.
   */
  baseBranch: string;
  message: string;
  files: readonly ChangedFile[];
}

export interface CommitResult {
  /**
   * The repository the branch is in, lowercase owner/name: the target itself, or the fork a host
   * commits through. The pull request is always opened in the target.
   */
  repo: string;
  branch: string;
  commitSha: string;
  treeSha: string;
  /** False when a retry found the branch already pointing at this exact change. */
  created: boolean;
}

export interface PullRequestRequest {
  repo: string;
  taskId: string;
  /** The branch the pull request asks to merge into. */
  base: string;
  title: string;
  body: string;
  draft?: boolean;
}

export interface PullRequestRef {
  number: number;
  url: string;
  headSha: string;
  /** False when a pull request from the task's branch already existed and was returned instead. */
  created: boolean;
}

export interface PullRequestState {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  mergeCommitSha: string | null;
  headSha: string;
  headBranch: string;
  baseBranch: string;
}

export type ChecksSummary = "pending" | "success" | "failure" | "none";

export interface ChecksState {
  state: ChecksSummary;
  /** Names of failing checks, at most 20, each at most 100 characters. Third-party text: metadata taint. */
  failing: string[];
}

export type CheckConclusion = "success" | "failure" | "pending" | "neutral";
export type DeploymentState = "success" | "failure" | "pending" | "inactive" | "other";

/**
 * A verified code host webhook, normalized. Repositories are lowercase owner/name. Every event
 * carries the vendor's delivery id, so a redelivery can be recognized.
 */
export type CodeHostEvent = CodeHostEventBody & {
  /**
   * A digest of what the signature covered (the event name and the signed body), set by adapters
   * whose vendor signs the body but not the delivery id. Deduplicate on it when present: a captured
   * payload sent again under a new delivery id is then the same delivery.
   */
  digest?: string;
};

export type CodeHostEventBody =
  | { type: "ping"; deliveryId: string }
  | {
      type: "pull_request";
      deliveryId: string;
      repo: string;
      number: number;
      action: "opened" | "closed" | "reopened" | "synchronize" | "other";
      merged: boolean;
      mergeCommitSha: string | null;
      headSha: string;
      headBranch: string;
      baseBranch: string;
    }
  | { type: "check"; deliveryId: string; repo: string; headSha: string; name: string; conclusion: CheckConclusion; pullRequests: number[] }
  | {
      type: "deployment";
      deliveryId: string;
      repo: string;
      sha: string;
      environment: string;
      /** The vendor's own production marker when the payload carries one, else null. */
      productionEnvironment: boolean | null;
      state: DeploymentState;
    }
  | { type: "ignored"; deliveryId: string; reason: string };

/**
 * Repositories, one commit per task, pull requests and checks. Every method refuses a repository
 * outside allowedRepos() with a non-retryable "invalid" AdapterError, before any request.
 */
export interface CodeHost {
  readonly name: string;
  /** The repositories this host may touch, lowercase owner/name, from its configuration. */
  allowedRepos(): readonly string[];
  /**
   * Why this host will not push a ship branch with its current configuration, or null when it
   * will. Checked before a build starts, so a build that could never be committed spends nothing.
   * It makes no request. For example, a host whose CI would run the pushed code with secrets until
   * the deployer says it does not, or one configured to commit through a fork without the
   * credential that fork needs. The reason names what the deployer has to do or confirm.
   */
  pushRefusal(): string | null;
  /** The commit a branch points at, or null when there is no such branch. */
  branchHead(repo: string, branch: string): Promise<string | null>;
  /**
   * One file at a ref, or null when nothing exists there. A directory or submodule at that path
   * throws a non-retryable "invalid" AdapterError: it is never mistaken for a missing file.
   */
  readFile(args: { repo: string; path: string; ref: string; maxBytes?: number }): Promise<RepoFile | null>;
  /**
   * What is at a path at a ref: nothing, a file, a symlink, a directory or a submodule. The
   * gatekeeper uses it to tell a directory a change writes into (fine) from a file, symlink or
   * submodule it would write over or under (refused).
   */
  pathKind(args: { repo: string; path: string; ref: string }): Promise<PathKind>;
  /**
   * One commit through the vendor's git data API on shipBranch(taskId), with baseSha as its only
   * parent. Idempotent: when the branch already points at a commit with the same tree and parent,
   * that commit is returned with created false. Never touches the base branch and never forces: a
   * branch that holds anything else is refused with a non-retryable "invalid" AdapterError.
   *
   * A host may commit to the same branch name in a fork of `repo` instead (CommitResult.repo says
   * where). It then writes nothing in `repo`, and in the fork it only fast-forwards the copy of
   * baseBranch until baseSha is reachable, refusing when it cannot.
   */
  commit(req: CommitRequest): Promise<CommitResult>;
  /**
   * Opens a pull request in `repo` from shipBranch(taskId), wherever commit put that branch, or
   * returns the one that already exists from it.
   */
  openPullRequest(req: PullRequestRequest): Promise<PullRequestRef>;
  /** A pull request's state, or null when it does not exist. */
  pullRequest(repo: string, number: number): Promise<PullRequestState | null>;
  /** The combined state of the checks on a commit. */
  checks(repo: string, sha: string): Promise<ChecksState>;
  /**
   * True when descendantSha is ancestorSha or has it in its history, so a deploy of descendantSha
   * carries the change ancestorSha made. False when it does not, including when the two commits
   * share no history or one of them is not in the repository. Throws an AdapterError when the
   * answer cannot be had (the host failed, refused or timed out): a caller never takes a failure
   * for an answer either way.
   */
  contains(repo: string, ancestorSha: string, descendantSha: string): Promise<boolean>;
  /**
   * Verifies the webhook signature in constant time before reading anything else, then maps the
   * payload. Throws an AdapterError: "auth" for a missing or bad signature, "invalid" for a payload
   * it cannot map, "unavailable" when its webhook secret is unset.
   */
  verifyWebhook(request: Request): Promise<CodeHostEvent>;
}

/** What one step of a build runs in the sandbox. */
export type CodingStep =
  /** Start the container, clone the base branch read-only, record its commit and install dependencies. */
  | { kind: "prepare"; repo: string; baseBranch: string; install: readonly string[] | null }
  /** Run the coding agent on the approved spec. The spec is the only description of the request it sees. */
  | { kind: "agent"; spec: string }
  /** Run the repository's checks. */
  | { kind: "checks"; command: readonly string[] }
  /** Run the agent once more on the same spec, told that the checks failed and where their output is. */
  | { kind: "repair"; spec: string };

export type CodingStepKind = CodingStep["kind"];

export type CodingRunState = "idle" | "running" | "succeeded" | "failed" | "lost";

export interface CodingStatus {
  /** The id the current or last step was started with, or null when none has run. */
  stepId: string | null;
  kind: CodingStepKind | null;
  /** lost: the container stopped before the step recorded how it ended. */
  state: CodingRunState;
  exitCode: number | null;
  /** True when the step hit its time limit. */
  timedOut: boolean;
  /** The commit the clone checked out, once prepare has succeeded. */
  baseSha: string | null;
  /** A short, fixed description of a failure. Never output from the container. */
  detail: string | null;
}

export type CodingCollectFailure = "not_ready" | "too_many_files" | "file_too_large" | "diff_too_large" | "invalid_output";

export type CodingCollectResult =
  | { ok: true; files: ChangedFile[]; diffBytes: number; log: string }
  | { ok: false; reason: CodingCollectFailure; detail: string; log: string };

export interface CodingSandboxLimits {
  /** Total bytes of changed content. */
  maxDiffBytes: number;
  maxFileBytes: number;
  maxFiles: number;
  /** Model requests per task, across every agent round. */
  maxModelTurns: number;
}

/**
 * A container per task, driven step by step so a durable caller polls instead of holding a
 * long call open. Everything that comes out of it (files, log) is full taint.
 */
export interface CodingSandbox {
  readonly name: string;
  readonly limits: CodingSandboxLimits;
  /**
   * Starts a step in the background and returns. Idempotent per stepId: starting the step that is
   * already running or finished returns accepted true without running it again. Another step while
   * one runs is refused with reason "busy".
   */
  start(taskId: string, stepId: string, step: CodingStep): Promise<{ accepted: boolean; reason?: string }>;
  status(taskId: string): Promise<CodingStatus>;
  /** The changes against the recorded base commit, within the limits, plus a capped log. */
  collect(taskId: string): Promise<CodingCollectResult>;
  /** Stops the container. Safe to call more than once. */
  destroy(taskId: string): Promise<void>;
}
