// GTM-agents: the ship loop's path policy: what a change built by the coding agent may touch, and
// how risky it is. Pure and deterministic: no clock, no network, no database. The gatekeeper runs it
// on the exact files it is about to commit, so what the policy judged is what lands in the pull
// request.
//
// A change is refused, whatever else it does, when:
//   - the repository is not on the allowlist (owner/name, compared without case);
//   - a path is not a plain repository-relative path: empty, absolute (a leading slash, a drive
//     letter or a backslash), with "." or ".." segments, empty segments, a leading "-" or "~", a
//     colon, control, zero-width or direction characters, characters that change under Unicode
//     normalization, a ".git" segment in any spelling (".GIT", ".git.", "git~1"), a reserved
//     device name, or over the length limits;
//   - a path, or a rename's previous path, matches a denied glob (DEFAULT_DENIED_PATHS always
//     apply; config.deniedPaths adds to them), or two paths differ only by case;
//   - a file is a symlink (mode 120000), a submodule (160000 or .gitmodules), or has any mode other
//     than 100644 or 100755 (or 000000 for a deletion);
//   - a file's content contradicts its change (content on a deletion, none on an addition), a rename
//     has no previous path, or its line counts are not whole numbers;
//   - content looks like a secret: a private key block or a known credential format;
//   - a file is over maxFileBytes, or the change is over maxLines, maxFiles or maxDiffBytes.
// Limits can only be tightened: a hard cap above DEFAULT_LIMITS is read as the default, and limits
// that are not positive whole numbers refuse every change.
//
// Otherwise it is allowed with a risk:
//   - low, unless one of these raises it;
//   - medium above mediumLines lines or mediumFiles files;
//   - high for any binary file or dependency manifest or lock file;
// and needsReview (a person reviews before the pull request opens) above reviewLines or
// reviewFiles, or at high risk. Every finding is a reason, in order.
import type { ChangedFile, EvaluatePathPolicy, PathPolicyConfig, PathPolicyLimits, PathPolicyVerdict, Risk } from "./contract.ts";

/** The limits the policy enforces when the deployment sets none. Hard caps can only be lowered. */
export const DEFAULT_LIMITS: Readonly<PathPolicyLimits> = Object.freeze({
  mediumLines: 120,
  mediumFiles: 5,
  reviewLines: 400,
  reviewFiles: 15,
  maxLines: 2_000,
  maxFiles: 60,
  maxDiffBytes: 2 * 1024 * 1024,
  maxFileBytes: 512 * 1024,
});

/**
 * Paths the loop never changes. Matching ignores case, and a pattern also matches every file under
 * a directory it matches, so "**\/*auth*" covers both src/auth.ts and src/auth/session.ts. `**`
 * spans any number of directories (none included), `*` any characters within one segment, `?` one.
 * Broad on purpose: a change refused here is a pull request a person writes instead.
 */
export const DEFAULT_DENIED_PATHS: readonly string[] = Object.freeze([
  // Authentication, sessions and permissions.
  "**/*auth*",
  "**/*login*",
  "**/*logout*",
  "**/*signin*",
  "**/*signup*",
  "**/*session*",
  "**/*passw*",
  "**/*credential*",
  "**/*passport*",
  "**/*permission*",
  "**/*saml*",
  "**/*oidc*",
  "**/*jwt*",
  "**/sso",
  "**/sso.*",
  "**/rbac*",
  "**/acl",
  "**/acl.*",
  // Middleware.
  "**/*middleware*",
  // Billing and pricing.
  "**/*billing*",
  "**/*payment*",
  "**/*invoice*",
  "**/*checkout*",
  "**/*subscription*",
  "**/*stripe*",
  "**/*pricing*",
  "**/*prices*",
  "**/*coupon*",
  "**/*discount*",
  // Privacy and legal.
  "**/*privacy*",
  "**/*gdpr*",
  "**/*consent*",
  "**/*legal*",
  "**/terms*",
  // Security.
  "**/*security*",
  "**/*crypto*",
  "**/*encrypt*",
  "**/*secret*",
  "**/*sanitiz*",
  "**/*csrf*",
  "**/*cors*",
  // CI, hooks, build and deploy configuration.
  ".github",
  ".gitlab",
  ".gitlab-ci.yml",
  ".circleci",
  ".buildkite",
  ".travis.yml",
  ".drone.yml",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
  "**/Jenkinsfile",
  ".githooks",
  ".husky",
  "**/CODEOWNERS",
  "**/.gitattributes",
  "**/.gitignore",
  "**/Dockerfile*",
  "**/docker-compose*",
  "**/*.tf",
  "**/wrangler.toml",
  "**/wrangler.json",
  "**/wrangler.jsonc",
  "**/vercel.json",
  "**/netlify.toml",
  "**/fly.toml",
  // API keys, environment and credentials files.
  "**/.env",
  "**/.env.*",
  "**/.dev.vars",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/*.keystore",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/*apikey*",
  "**/*api_key*",
  "**/*api-key*",
  "**/.npmrc",
  "**/.yarnrc*",
  "**/.pypirc",
  "**/.netrc",
  // Internal APIs and admin surfaces.
  "**/internal",
  "**/admin",
  "**/*webhook*",
  "**/api/private",
]);

/** Dependency manifests and lock files: a change to any of them is high risk. Compared by file name, without case. */
export const DEPENDENCY_MANIFESTS: readonly string[] = Object.freeze([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "bun.lock",
  "bun.lockb",
  "deno.json",
  "deno.jsonc",
  "deno.lock",
  "requirements.txt",
  "pipfile",
  "pipfile.lock",
  "poetry.lock",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "uv.lock",
  "go.mod",
  "go.sum",
  "go.work",
  "cargo.toml",
  "cargo.lock",
  "gemfile",
  "gemfile.lock",
  "composer.json",
  "composer.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.lockfile",
  "packages.config",
  "directory.packages.props",
  "mix.exs",
  "mix.lock",
  "package.swift",
  "package.resolved",
  "podfile",
  "podfile.lock",
  "pubspec.yaml",
  "pubspec.lock",
]);

const MANIFESTS: ReadonlySet<string> = new Set(DEPENDENCY_MANIFESTS);
const MANIFEST_PATTERNS = [/^requirements[-_.][a-z0-9_.-]*\.txt$/, /\.csproj$/, /\.fsproj$/, /\.vbproj$/, /\.gemspec$/, /\.nuspec$/];

/** True when the file name (the last segment) is a dependency manifest or lock file. Pure. */
export function isDependencyManifest(path: string): boolean {
  const name = (path.split("/").pop() ?? "").toLowerCase();
  return MANIFESTS.has(name) || MANIFEST_PATTERNS.some((re) => re.test(name));
}

/** Modes a committed file may have: a regular file or an executable one. */
export const ALLOWED_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);
const SYMLINK_MODE = "120000";
const SUBMODULE_MODE = "160000";
const DELETED_MODE = "000000";
const CHANGE_KINDS: ReadonlySet<string> = new Set(["added", "modified", "deleted", "renamed"]);

export const MAX_PATH_CHARS = 400;
export const MAX_PATH_SEGMENTS = 32;

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
const RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

/**
 * Why a path is not a plain repository-relative path, or null when it is one. Pure.
 */
export function pathProblem(path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0) return "an empty path";
  const shown = JSON.stringify(path.slice(0, 80));
  if (path.length > MAX_PATH_CHARS) return `path ${shown}... is over ${MAX_PATH_CHARS} characters`;
  if (CONTROL.test(path)) return `path ${shown} holds a control character`;
  if (INVISIBLE.test(path)) return `path ${shown} holds an invisible or direction character`;
  if (path.normalize("NFKC") !== path || path.normalize("NFC") !== path) return `path ${shown} changes under Unicode normalization`;
  if (path.includes("\\")) return `path ${shown} holds a backslash`;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return `path ${shown} is absolute`;
  if (path.includes(":")) return `path ${shown} holds a colon`;
  if (path !== path.trim()) return `path ${shown} starts or ends with white space`;
  if (path.startsWith("-") || path.startsWith("~")) return `path ${shown} starts with "${path[0] ?? ""}"`;
  const segments = path.split("/");
  if (segments.length > MAX_PATH_SEGMENTS) return `path ${shown} is over ${MAX_PATH_SEGMENTS} segments deep`;
  for (const segment of segments) {
    if (segment === "") return `path ${shown} has an empty segment`;
    if (segment === "." || segment === "..") return `path ${shown} has a "${segment}" segment (path traversal)`;
    const folded = segment.toLowerCase().replace(/[. ]+$/, "");
    if (folded === ".git" || folded === "git~1") return `path ${shown} is inside .git`;
    if (folded === ".gitmodules") return `path ${shown} changes submodules (.gitmodules)`;
    if (/[. ]$/.test(segment)) return `path ${shown} has a segment ending in a dot or a space`;
    if (RESERVED_DEVICE.test(segment)) return `path ${shown} uses a reserved device name`;
  }
  return null;
}

/** A denied glob as a case-insensitive regular expression over a whole path. Pure. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i] ?? "";
    if (ch === "*" && glob[i + 1] === "*") {
      const atStart = i === 0 || glob[i - 1] === "/";
      const slashAfter = glob[i + 2] === "/";
      if (atStart && slashAfter) {
        out += "(?:[^/]+/)*";
        i += 3;
        continue;
      }
      out += ".*";
      i += 2;
      continue;
    }
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  return new RegExp(`^${out}$`, "i");
}

/** The path and every directory above it: "a/b/c.ts" gives a, a/b and a/b/c.ts. */
function selfAndAncestors(path: string): string[] {
  const segments = path.split("/");
  return segments.map((_, i) => segments.slice(0, i + 1).join("/"));
}

/** The first denied glob that matches the path or a directory above it, or null. Pure. */
export function deniedBy(path: string, globs: readonly string[]): string | null {
  const candidates = selfAndAncestors(path);
  for (const glob of globs) {
    if (typeof glob !== "string" || glob.trim() === "") continue;
    const re = globToRegExp(glob.trim());
    if (candidates.some((c) => re.test(c))) return glob;
  }
  return null;
}

/** The denied globs in force: the defaults, plus what the deployment adds. Pure. */
export function deniedGlobs(extra: readonly string[] | undefined): string[] {
  return [...new Set([...DEFAULT_DENIED_PATHS, ...(Array.isArray(extra) ? extra.filter((g): g is string => typeof g === "string" && g.trim() !== "") : [])])];
}

// Credential formats and private key blocks. Each is a strong signal on its own; the scan never
// returns what it matched, only its kind.
const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["a private key block", /-----BEGIN[A-Z ]{0,24}PRIVATE KEY( BLOCK)?-----/],
  ["an Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["an OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ["a GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ["a GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{30,}/],
  ["an AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["a Stripe live key", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/],
  ["a Stripe webhook secret", /\bwhsec_[A-Za-z0-9]{24,}/],
  ["a Telegram bot token", /\b[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}/],
  ["a credential in a URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{6,}@[^\s/]+/i],
  ["a hard-coded credential assignment", /\b(?:api[_-]?key|secret|token|password|passwd|private[_-]?key)["']?\s*[:=]\s*["'][A-Za-z0-9+/_=.-]{24,}["']/i],
];

/** The kind of the first secret-shaped value in the text, or null. Pure. */
export function secretIn(text: string): string | null {
  for (const [kind, re] of SECRET_PATTERNS) if (re.test(text)) return kind;
  return null;
}

/** The bytes of a file's content after the change, or null when it cannot be decoded. Pure. */
export function contentBytes(content: ChangedFile["content"]): number | null {
  if (content === null) return 0;
  if (!content || typeof content.data !== "string") return null;
  if (content.encoding === "utf-8") return new TextEncoder().encode(content.data).length;
  if (content.encoding !== "base64") return null;
  const data = content.data.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) return null;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

/** The text a secret scan reads: UTF-8 as written; base64 decoded byte for byte. */
function scanText(content: NonNullable<ChangedFile["content"]>): string {
  if (content.encoding === "utf-8") return content.data;
  try {
    return atob(content.data.replace(/\s+/g, ""));
  } catch {
    return "";
  }
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;
const isLimit = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;

/** The limits in force: each must be a positive whole number, and hard caps never exceed the defaults. Null when invalid. Pure. */
export function effectiveLimits(limits: PathPolicyLimits | undefined): PathPolicyLimits | null {
  if (!limits || typeof limits !== "object") return null;
  const keys = Object.keys(DEFAULT_LIMITS) as Array<keyof PathPolicyLimits>;
  if (!keys.every((k) => isLimit(limits[k]))) return null;
  const out: PathPolicyLimits = { ...limits };
  for (const k of ["maxLines", "maxFiles", "maxDiffBytes", "maxFileBytes"] as const) out[k] = Math.min(limits[k], DEFAULT_LIMITS[k]);
  return out;
}

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** True when `repo` is exactly one entry of the allowlist (owner/name, without case). Pure. */
export function repoAllowed(repo: unknown, allowed: readonly string[] | undefined): boolean {
  if (typeof repo !== "string" || !REPO.test(repo) || repo.split("/").some((part) => part === "." || part === "..")) return false;
  const key = repo.toLowerCase();
  return Array.isArray(allowed) && allowed.some((r) => typeof r === "string" && r.toLowerCase() === key);
}

const RISK_ORDER: Readonly<Record<Risk, number>> = { low: 0, medium: 1, high: 2 };
const atLeast = (risk: Risk, floor: Risk): Risk => (RISK_ORDER[floor] > RISK_ORDER[risk] ? floor : risk);

/** The path policy. Pure and deterministic; see the header for every rule. */
export const evaluatePathPolicy: EvaluatePathPolicy = (files, config): PathPolicyVerdict => {
  const refusals: string[] = [];
  const notes: string[] = [];
  const list: readonly ChangedFile[] = Array.isArray(files) ? files : [];
  let linesChanged = 0;
  let diffBytes = 0;

  const limits = effectiveLimits((config as PathPolicyConfig | undefined)?.limits);
  if (!limits) refusals.push("the limits are not positive whole numbers, so nothing can be allowed");
  if (!repoAllowed(config?.repo, config?.allowedRepos)) refusals.push(`repository ${JSON.stringify(String(config?.repo ?? "")).slice(0, 120)} is not on the allowlist`);
  if (list.length === 0) refusals.push("the change has no files");
  const globs = deniedGlobs(config?.deniedPaths);

  const seen = new Map<string, string>();
  let risk: Risk = "low";
  for (const file of list) {
    if (!file || typeof file !== "object") {
      refusals.push("a file entry is not an object");
      continue;
    }
    const where = typeof file.path === "string" ? JSON.stringify(file.path.slice(0, 120)) : "(no path)";
    const problem = pathProblem(file.path);
    if (problem) {
      refusals.push(problem);
      continue;
    }
    const folded = file.path.toLowerCase();
    const prior = seen.get(folded);
    if (prior !== undefined) refusals.push(prior === file.path ? `${where} appears twice` : `${where} and ${JSON.stringify(prior)} differ only by case`);
    seen.set(folded, file.path);

    const denied = deniedBy(file.path, globs);
    if (denied) refusals.push(`${where} is a denied path (${denied})`);

    if (!CHANGE_KINDS.has(file.change)) refusals.push(`${where} has an unknown change kind`);
    if (file.change === "renamed") {
      const previous = file.previousPath;
      const previousProblem = pathProblem(previous);
      if (previousProblem) refusals.push(`${where} is a rename whose previous path is not usable: ${previousProblem}`);
      else if (typeof previous === "string") {
        const was = deniedBy(previous, globs);
        if (was) refusals.push(`${where} is renamed from a denied path ${JSON.stringify(previous.slice(0, 120))} (${was})`);
      }
    } else if (file.previousPath !== undefined && file.previousPath !== null) {
      refusals.push(`${where} has a previous path but is not a rename`);
    }

    if (file.mode === SYMLINK_MODE) refusals.push(`${where} is a symlink`);
    else if (file.mode === SUBMODULE_MODE) refusals.push(`${where} is a submodule`);
    else if (file.change === "deleted" && file.mode === DELETED_MODE) {
      // A deletion leaves no file behind, so git reports mode 000000 after it.
    } else if (typeof file.mode !== "string" || !ALLOWED_MODES.has(file.mode)) refusals.push(`${where} has file mode ${JSON.stringify(String(file.mode)).slice(0, 20)}, which is not allowed`);

    if (!isCount(file.additions) || !isCount(file.deletions)) refusals.push(`${where} has line counts that are not whole numbers`);
    else linesChanged += file.additions + file.deletions;

    if (file.change === "deleted") {
      if (file.content !== null) refusals.push(`${where} is deleted but carries content`);
    } else if (file.content === null || file.content === undefined) {
      refusals.push(`${where} carries no content`);
    } else {
      const bytes = contentBytes(file.content);
      if (bytes === null) refusals.push(`${where} has content that cannot be decoded`);
      else {
        diffBytes += bytes;
        if (limits && bytes > limits.maxFileBytes) refusals.push(`${where} is ${bytes} bytes, over the ${limits.maxFileBytes}-byte limit per file`);
        const secret = secretIn(scanText(file.content));
        if (secret) refusals.push(`${where} holds what looks like ${secret}`);
      }
      if (file.binary === false && file.content.encoding !== "utf-8") refusals.push(`${where} is text but its content is not UTF-8`);
    }

    if (file.binary === true) {
      risk = atLeast(risk, "high");
      notes.push(`${where} is binary, so the risk is high`);
    } else if (file.binary !== false) {
      refusals.push(`${where} does not say whether it is binary`);
    }
    if (isDependencyManifest(file.path) || (typeof file.previousPath === "string" && isDependencyManifest(file.previousPath))) {
      risk = atLeast(risk, "high");
      notes.push(`${where} is a dependency manifest or lock file, so the risk is high`);
    }
  }

  const filesChanged = list.length;
  if (limits) {
    if (linesChanged > limits.maxLines) refusals.push(`${linesChanged} lines changed, over the limit of ${limits.maxLines}`);
    if (filesChanged > limits.maxFiles) refusals.push(`${filesChanged} files changed, over the limit of ${limits.maxFiles}`);
    if (diffBytes > limits.maxDiffBytes) refusals.push(`${diffBytes} bytes changed, over the limit of ${limits.maxDiffBytes}`);
  }
  if (refusals.length > 0 || !limits) return { decision: "refuse", reasons: [...refusals, ...notes], filesChanged, linesChanged };

  if (linesChanged > limits.mediumLines || filesChanged > limits.mediumFiles) {
    risk = atLeast(risk, "medium");
    notes.push(`${linesChanged} lines in ${filesChanged} files is above ${limits.mediumLines} lines or ${limits.mediumFiles} files, so the risk is at least medium`);
  }
  const overReview = linesChanged > limits.reviewLines || filesChanged > limits.reviewFiles;
  if (overReview) notes.push(`${linesChanged} lines in ${filesChanged} files is above ${limits.reviewLines} lines or ${limits.reviewFiles} files, so a person reviews it first`);
  if (risk === "high") notes.push("high risk, so a person reviews it first");
  return { decision: "allow", risk, needsReview: overReview || risk === "high", reasons: notes, filesChanged, linesChanged };
};

/** A path policy configuration with the defaults: the default denied paths and limits. Pure. */
export function pathPolicyConfig(input: { repo: string; allowedRepos: readonly string[]; deniedPaths?: readonly string[]; limits?: Partial<PathPolicyLimits> }): PathPolicyConfig {
  return { repo: input.repo, allowedRepos: [...input.allowedRepos], deniedPaths: deniedGlobs(input.deniedPaths), limits: { ...DEFAULT_LIMITS, ...(input.limits ?? {}) } };
}
