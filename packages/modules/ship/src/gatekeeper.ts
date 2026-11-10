// GTM-agents: the ship build's gatekeeper. Between the sandbox and the code host, it decides what
// is committed, on the exact files that will be committed:
//
//   - the collected files are stored once, in canonical JSON, under a key that carries their
//     SHA-256, so every later step (the policy, the risk approval, the commit) works from the same
//     bytes and can prove it;
//   - normalizeChanges recomputes what the container reported against the base commit read from the
//     code host: whether each file is added, changed or deleted, whether it is binary, and an upper
//     bound on its added and deleted lines (common leading and trailing lines trimmed, the rest
//     counted). The container is untrusted, so its own counts are never used, and a base file too
//     large to read counts every byte as a line, which only raises the risk;
//   - gatekeep re-runs the path policy on the normalized files, refuses unless it allows them,
//     refuses a change that needs a person's review unless the approval names this exact digest,
//     then makes one commit on ship/<task> and opens (or finds) the pull request. It never merges:
//     merging code is permanently human.
import { canonicalJson } from "@gtm-agents/core/security";
import type { CodeHost, CommitResult, PathKind, PullRequestRef, RepoFile } from "@gtm-agents/core/ports";
import type { ChangedFile as PortChangedFile } from "@gtm-agents/core/ports";
import type { ChangedFile, EvaluatePathPolicy, PathPolicyConfig, PathPolicyVerdict, Risk, ShipSpec } from "./contract.ts";

// The contract's ChangedFile and the core port's must stay the same shape: these fail to compile otherwise.
const _toPort = (file: ChangedFile): PortChangedFile => file;
const _toContract = (file: PortChangedFile): ChangedFile => file;
void _toPort;
void _toContract;

export const CHANGES_KIND = "ship_changes";
export const RISK_CODE_CHARS = 8;
const RISK_ORDER: Readonly<Record<Risk, number>> = { low: 0, medium: 1, high: 2 };

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const byPath = (a: ChangedFile, b: ChangedFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** The stored form of a change and its digest: canonical JSON, files sorted by path. */
export async function encodeChanges(files: readonly ChangedFile[]): Promise<{ text: string; digest: string }> {
  const text = canonicalJson({ kind: CHANGES_KIND, v: 1, files: [...files].sort(byPath) });
  return { text, digest: await sha256Hex(text) };
}

/** The files in a stored change, only when its bytes still have `digest`. Throws otherwise. */
export async function decodeChanges(text: string, digest: string): Promise<ChangedFile[]> {
  if ((await sha256Hex(text)) !== digest) throw new Error("the stored change does not match its digest");
  const doc = JSON.parse(text) as { kind?: unknown; v?: unknown; files?: unknown };
  if (doc.kind !== CHANGES_KIND || doc.v !== 1 || !Array.isArray(doc.files)) throw new Error("the stored change is not a ship change");
  return doc.files as ChangedFile[];
}

/** The R2 key a change is stored under. The digest is part of it, so the key alone names the bytes. */
export const changesKey = (taskId: string, digest: string): string => `ship/${taskId}/changes-${digest}.json`;

/** The digest a changes key names, or null when the key is not one. */
export function digestOfKey(key: string | null | undefined): string | null {
  const match = /\/changes-([0-9a-f]{64})\.json$/.exec(key ?? "");
  return match?.[1] ?? null;
}

/** The code `ship-risk-approve-<task> <code>` carries: bound to the task and the digest of its exact files. */
export async function riskCode(taskId: string, digest: string): Promise<string> {
  return (await sha256Hex(canonicalJson({ kind: "ship_risk", v: 1, task: taskId, digest }))).slice(0, RISK_CODE_CHARS);
}

/** The higher of two risks. Pure. */
export const maxRisk = (a: Risk, b: Risk): Risk => (RISK_ORDER[a] >= RISK_ORDER[b] ? a : b);

function lines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** An upper bound on the lines a change adds and deletes: common leading and trailing lines trimmed. Pure. */
export function lineDelta(before: string, after: string): { additions: number; deletions: number } {
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { additions: endB - start, deletions: endA - start };
}

const isText = (content: ChangedFile["content"] | RepoFile | null): boolean => content !== null && content.encoding === "utf-8" && typeof content.data === "string" && !content.data.includes("\u0000");

/** Reads one file at the base commit. */
export type BaseReader = (path: string) => Promise<RepoFile | null>;

/** What a path holds at the base commit. */
export type BaseKind = (path: string) => Promise<PathKind>;

/**
 * The collected files as the base commit sees them. Pure apart from `read`, which the caller points
 * at the code host at the recorded base commit.
 */
export async function normalizeChanges(files: readonly ChangedFile[], read: BaseReader, kind: BaseKind): Promise<ChangedFile[]> {
  // A blob written where the base has a directory or submodule replaces the whole of it, and a
  // path under a base file, symlink or submodule replaces that: either changes paths the policy
  // never saw, so both are refused. A directory the change writes into is what most changes do.
  const ancestors = new Set<string>();
  const targets = new Set<string>();
  for (const file of files) {
    for (const path of [file.path, ...(file.previousPath ? [file.previousPath] : [])]) {
      targets.add(path);
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) ancestors.add(parts.slice(0, i).join("/"));
    }
  }
  for (const dir of [...ancestors].sort()) {
    const at = await kind(dir);
    if (at !== "directory" && at !== "missing") throw new Error(`${dir} is a ${at} at the base commit, so nothing can be written under it`);
  }
  for (const path of [...targets].sort()) {
    const at = await kind(path);
    if (at === "directory" || at === "submodule") throw new Error(`${path} is a ${at} at the base commit, so a file cannot replace it`);
  }
  const out: ChangedFile[] = [];
  for (const file of [...files].sort(byPath)) {
    const before = file.change === "renamed" && file.previousPath ? await read(file.previousPath) : await read(file.path);
    const beforeText = before && before.data !== null && isText(before) ? (before.data ?? "") : null;
    const beforeLines = (): number => (before === null ? 0 : beforeText !== null ? lines(beforeText).length : before.data === null ? before.size : 0);

    if (file.change === "deleted") {
      // Deleting what the base does not have changes nothing.
      if (before === null) continue;
      out.push({ ...file, content: null, binary: before.data !== null && !isText(before), additions: 0, deletions: beforeLines() });
      continue;
    }
    const after = file.content;
    const binary = after === null || !isText(after);
    const afterText = !binary && after ? after.data : "";
    let change: ChangedFile["change"] = file.change;
    if (file.change === "renamed" && before === null) change = "added";
    else if (file.change !== "renamed") change = before === null ? "added" : "modified";
    const counted: { additions: number; deletions: number } =
      before === null
        ? { additions: binary ? 0 : lines(afterText).length, deletions: 0 }
        : binary || beforeText === null
          ? { additions: binary ? 0 : lines(afterText).length, deletions: beforeLines() }
          : lineDelta(beforeText, afterText);
    if (change === "renamed") {
      // A rename onto a path the base already has also replaces that file: count its lines too.
      const overwritten = await read(file.path);
      if (overwritten) counted.deletions += overwritten.data === null ? overwritten.size : isText(overwritten) ? lines(overwritten.data ?? "").length : 0;
    }
    const next: ChangedFile = { path: file.path, change, additions: counted.additions, deletions: counted.deletions, mode: file.mode, binary, content: after };
    if (change === "renamed" && file.previousPath) next.previousPath = file.previousPath;
    out.push(next);
  }
  return out;
}

function clean(text: string, max: number): string {
  const out = text.replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === "\n" ? "\n" : " ")).replace(/[ \t]+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max - 3).trimEnd()}...` : out;
}

const bullet = (items: readonly string[], max: number) => (items.length === 0 ? "- (none)" : items.slice(0, max).map((i) => `- ${clean(i, 300)}`).join("\n"));

/** The commit message: the spec's title and the task trailer. Pure. */
export function commitMessage(spec: ShipSpec, taskId: string): string {
  return `${clean(spec.title, 72).replace(/\n/g, " ")}\n\nShip-Task: ${taskId}`;
}

/** The pull request's title and body, from the approved spec and the gatekeeper's verdict. Pure. */
export function pullRequestText(spec: ShipSpec, taskId: string, verdict: Extract<PathPolicyVerdict, { decision: "allow" }>, risk: Risk): { title: string; body: string } {
  const body = [
    "## Problem",
    clean(spec.problem, 2000),
    "",
    "## Approach",
    clean(spec.approach, 3000),
    "",
    "## Acceptance criteria",
    bullet(spec.acceptanceCriteria, 20),
    "",
    "## Tests",
    bullet(spec.tests, 20),
    "",
    "## Out of scope",
    bullet(spec.outOfScope, 20),
    "",
    "## Gatekeeper",
    `Risk ${risk}: ${verdict.filesChanged} files, ${verdict.linesChanged} lines changed (an upper bound).`,
    bullet(verdict.reasons, 20),
    "",
    "Opened by the GTM-agents ship loop from an approved spec. It never merges its own pull requests: review and merge this yourself.",
    "",
    `Ship-Task: ${taskId}`,
  ].join("\n");
  return { title: clean(spec.title, 120).replace(/\n/g, " "), body };
}

export interface GatekeepInput {
  host: CodeHost;
  evaluate: EvaluatePathPolicy;
  policy: PathPolicyConfig;
  taskId: string;
  repo: string;
  baseBranch: string;
  baseSha: string;
  spec: ShipSpec;
  /** The stored files and the digest they were evaluated under. */
  files: readonly ChangedFile[];
  digest: string;
  /** The digest a person approved, for a change that needs review; null when there is none. */
  approvedDigest: string | null;
  draft: boolean;
  maxBaseBytes: number;
}

export type GatekeepResult =
  | { ok: true; commit: CommitResult; pr: PullRequestRef; risk: Risk; filesChanged: number; linesChanged: number }
  | { ok: false; reason: string; refused: boolean };

/** The verdict on the exact files, normalized against the base commit. */
export async function judge(input: Pick<GatekeepInput, "host" | "evaluate" | "policy" | "repo" | "baseSha" | "files" | "maxBaseBytes" | "spec">): Promise<{ files: ChangedFile[]; verdict: PathPolicyVerdict; risk: Risk | null; needsApproval: boolean }> {
  const files = await normalizeChanges(
    input.files,
    (path) => input.host.readFile({ repo: input.repo, path, ref: input.baseSha, maxBytes: input.maxBaseBytes }),
    (path) => input.host.pathKind({ repo: input.repo, path, ref: input.baseSha }),
  );
  const verdict = input.evaluate(files, { ...input.policy, repo: input.repo });
  if (verdict.decision !== "allow") return { files, verdict, risk: null, needsApproval: false };
  const risk = maxRisk(verdict.risk, input.spec.risk);
  return { files, verdict, risk, needsApproval: risk === "high" || verdict.needsReview };
}

/** Re-runs the policy on the exact files and, when it allows them, commits once and opens the pull request. */
export async function gatekeep(input: GatekeepInput): Promise<GatekeepResult> {
  const { digest } = await encodeChanges(input.files);
  if (digest !== input.digest) return { ok: false, reason: "the files differ from the ones that were evaluated", refused: true };
  const judged = await judge(input);
  if (judged.verdict.decision !== "allow" || judged.risk === null) return { ok: false, reason: `the path policy refused the change: ${judged.verdict.reasons.slice(0, 5).join("; ")}`, refused: true };
  if (judged.needsApproval && input.approvedDigest !== digest) return { ok: false, reason: "the change needs a person's approval of these exact files", refused: true };
  const commit = await input.host.commit({ repo: input.repo, taskId: input.taskId, baseSha: input.baseSha, message: commitMessage(input.spec, input.taskId), files: judged.files });
  const text = pullRequestText(input.spec, input.taskId, judged.verdict, judged.risk);
  const pr = await input.host.openPullRequest({ repo: input.repo, taskId: input.taskId, base: input.baseBranch, title: text.title, body: text.body, draft: input.draft });
  return { ok: true, commit, pr, risk: judged.risk, filesChanged: judged.verdict.filesChanged, linesChanged: judged.verdict.linesChanged };
}
