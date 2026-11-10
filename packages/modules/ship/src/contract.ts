// GTM-agents: the ship module's internal contract. The planning side (themes, specs, approval,
// path policy, "it is live" notes) and the build side (the sandbox workflow, the gatekeeper, pull
// requests, deploy detection) meet only here, so either can change without the other.
//
// The flow: feedback becomes themes; a theme with enough demand gets a spec; a person (or, at
// earned autonomy, the ship_spec class) approves the spec; the planning side queues a ship task and
// calls StartShipBuild. The build side runs the coding agent in a sandbox with no credentials,
// evaluates the exact files with EvaluatePathPolicy, opens a pull request and never merges
// (merge_code is permanently human). When a production deploy carries the merge commit, the build
// side calls AnnounceShipped.
//
// Raw feedback text never crosses this boundary. The build side sees only the approved ShipSpec.

/** The spec a theme is built from: the only description of the request the coding agent ever sees. */
export interface ShipSpec {
  title: string;
  problem: string;
  approach: string;
  acceptanceCriteria: string[];
  /** Repository-relative paths the change is expected to touch. */
  files: string[];
  tests: string[];
  outOfScope: string[];
  risk: Risk;
  /** The product event that shows the change is used, or null when there is none. */
  adoptionEvent: string | null;
  feasible: boolean;
}

export type Risk = "low" | "medium" | "high";

/** One changed file exactly as the gatekeeper would commit it. */
export interface ChangedFile {
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

export interface PathPolicyLimits {
  /** Above either, the risk is at least medium. */
  mediumLines: number;
  mediumFiles: number;
  /** Above either, the change needs a person's review before the pull request opens. */
  reviewLines: number;
  reviewFiles: number;
  /** Above either, the change is refused. */
  maxLines: number;
  maxFiles: number;
  maxDiffBytes: number;
  maxFileBytes: number;
}

export interface PathPolicyConfig {
  repo: string;
  /** Repositories the loop may open pull requests against, as owner/name. Anything else is refused. */
  allowedRepos: readonly string[];
  /** Path globs that are never changed (auth, billing, CI config and the like). */
  deniedPaths: readonly string[];
  limits: PathPolicyLimits;
}

export type PathPolicyVerdict =
  | { decision: "refuse"; reasons: string[]; filesChanged: number; linesChanged: number }
  | { decision: "allow"; risk: Risk; needsReview: boolean; reasons: string[]; filesChanged: number; linesChanged: number };

/**
 * Pure and deterministic. The gatekeeper runs it on the exact files it is about to commit, so what
 * the policy judged is what lands in the pull request.
 */
export type EvaluatePathPolicy = (files: readonly ChangedFile[], config: PathPolicyConfig) => PathPolicyVerdict;

/**
 * Build side. Starts the durable build for a queued ship task. Idempotent per task: calling it
 * twice for one task starts one build. Fails closed: without the bindings it needs, or with
 * ship:enabled off or unreadable, it starts nothing and says why.
 */
export type StartShipBuild<E> = (env: E, taskId: string, now: Date) => Promise<{ started: boolean; reason?: string }>;

/**
 * Planning side. Called once a production deploy carries a task's merge commit: marks the theme
 * shipped and drafts the "you asked, it is live" notes. Idempotent per theme; a failure here is
 * logged and never fails the webhook that called it.
 */
export type AnnounceShipped<E> = (env: E, taskId: string, now: Date) => Promise<void>;
