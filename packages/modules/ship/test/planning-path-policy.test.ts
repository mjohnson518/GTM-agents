// GTM-agents: the ship loop's path policy, which the gatekeeper runs on the exact files of a change:
// the repository allowlist, every kind of path a change may not carry (traversal, absolute paths,
// .git, invisible characters and the rest), the denied globs, file modes, secrets, the per-file,
// line, file and byte limits, and how risk and review are decided. Pure: no bindings. Every path
// and repository name is invented.
import { describe, expect, it } from "vitest";
import type { ChangedFile, PathPolicyConfig } from "../src/contract.ts";
import { DEFAULT_DENIED_PATHS, DEFAULT_LIMITS, deniedBy, evaluatePathPolicy, globToRegExp, isDependencyManifest, pathPolicyConfig, pathProblem, secretIn } from "../src/path-policy.ts";

const REPO = "acme-example/quarantine";
const config = (over: Partial<PathPolicyConfig> = {}): PathPolicyConfig => ({ repo: REPO, allowedRepos: [REPO], deniedPaths: [], limits: { ...DEFAULT_LIMITS }, ...over });
const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  change: "modified",
  additions: 1,
  deletions: 0,
  mode: "100644",
  binary: false,
  content: { encoding: "utf-8", data: "export const x = 1;\n" },
  ...over,
});
const files = (n: number, lines = 1): ChangedFile[] => Array.from({ length: n }, (_, i) => file(`src/reports/part-${i}.ts`, { additions: lines, deletions: 0 }));
const refused = (verdict: ReturnType<typeof evaluatePathPolicy>) => verdict.decision === "refuse";
const reasons = (verdict: ReturnType<typeof evaluatePathPolicy>) => verdict.reasons.join("\n");

describe("a small, plain change", () => {
  it("is allowed at low risk without review", () => {
    const v = evaluatePathPolicy([file("src/reports/csv.ts", { additions: 20, deletions: 4 })], config());
    expect(v).toEqual({ decision: "allow", risk: "low", needsReview: false, reasons: [], filesChanged: 1, linesChanged: 24 });
  });

  it("is deterministic and leaves its input untouched", () => {
    const input = Object.freeze([Object.freeze(file("src/reports/csv.ts"))]);
    const c = Object.freeze(config());
    expect(evaluatePathPolicy(input, c)).toEqual(evaluatePathPolicy(input, c));
  });

  it("refuses an empty change", () => {
    const v = evaluatePathPolicy([], config());
    expect(refused(v)).toBe(true);
    expect(reasons(v)).toContain("no files");
  });

  it("refuses an entry that is not a file", () => {
    expect(refused(evaluatePathPolicy([null as unknown as ChangedFile], config()))).toBe(true);
  });
});

describe("the repository allowlist", () => {
  it("allows a listed repository, compared without case", () => {
    expect(evaluatePathPolicy([file("src/a.ts")], config({ repo: "Acme-Example/Quarantine" })).decision).toBe("allow");
  });

  it.each([
    ["another repository", "acme-example/other"],
    ["a name without an owner", "quarantine"],
    ["a traversal in the name", "acme-example/.."],
    ["an extra segment", "acme-example/quarantine/extra"],
    ["an empty name", ""],
    ["a host in front", "github.example/acme-example/quarantine"],
  ])("refuses %s", (_label, repo) => {
    const v = evaluatePathPolicy([file("src/a.ts")], config({ repo }));
    expect(refused(v)).toBe(true);
    expect(reasons(v)).toContain("not on the allowlist");
  });

  it("refuses everything when the allowlist is empty", () => {
    expect(refused(evaluatePathPolicy([file("src/a.ts")], config({ allowedRepos: [] })))).toBe(true);
  });
});

describe("paths a change may not carry", () => {
  const ADVERSARIAL: Array<[string, string]> = [
    ["an empty path", ""],
    ["an absolute path", "/etc/passwd"],
    ["a drive letter", "C:/Windows/system.ini"],
    ["a UNC path", "\\\\server\\share\\x.ts"],
    ["a backslash", "src\\reports\\x.ts"],
    ["a parent segment", "../outside.ts"],
    ["a parent segment deeper in", "src/reports/../../../outside.ts"],
    ["a current-directory segment", "./src/a.ts"],
    ["a current-directory segment inside", "src/./a.ts"],
    ["an empty segment", "src//a.ts"],
    ["a trailing slash", "src/reports/"],
    [".git at the root", ".git/config"],
    [".git in upper case", ".GIT/hooks/pre-commit"],
    [".git deeper in", "vendor/lib/.git/config"],
    [".git with a trailing dot", ".git./config"],
    [".git with a trailing space", ".git /config"],
    ["the short name of .git", "GIT~1/config"],
    [".gitmodules", ".gitmodules"],
    ["a colon", "src/a:b.ts"],
    ["an alternate data stream", "src/a.ts::$DATA"],
    ["a leading space", " src/a.ts"],
    ["a trailing space", "src/a.ts "],
    ["a leading dash", "-rf.ts"],
    ["a leading tilde", "~/x.ts"],
    ["a NUL character", "src/a\u0000.ts"],
    ["a line break", "src/a\n.ts"],
    ["a delete character", "src/a\u007f.ts"],
    ["a right-to-left override", "src/a\u202egpj.ts"],
    ["a zero-width space", "src/a\u200b.ts"],
    ["a zero-width joiner inside .git", ".g\u200dit/config"],
    ["a byte order mark", "\ufeffsrc/a.ts"],
    ["a fullwidth letter", "src/\uff41.ts"],
    ["a decomposed accent", "src/cafe\u0301.ts"],
    ["a reserved device name", "src/con.ts"],
    ["a reserved device name without an extension", "src/nul"],
    ["a segment ending in a dot", "src/reports./a.ts"],
    ["an over-long path", `src/${"a".repeat(400)}.ts`],
    ["too many segments", `${Array.from({ length: 33 }, () => "d").join("/")}/a.ts`],
  ];

  it.each(ADVERSARIAL)("refuses %s", (_label, path) => {
    expect(pathProblem(path)).not.toBeNull();
    expect(refused(evaluatePathPolicy([file(path)], config()))).toBe(true);
  });

  it("accepts ordinary repository-relative paths", () => {
    for (const path of ["src/reports/csv.ts", "README.md", "packages/ui/src/QuarantineList.tsx", "docs/guides/export.md", ".editorconfig", "src/a-b_c.d.ts"]) {
      expect(pathProblem(path)).toBeNull();
    }
  });

  it("refuses a path that is not a string", () => {
    expect(refused(evaluatePathPolicy([file(42 as unknown as string)], config()))).toBe(true);
  });

  it("refuses two paths that differ only by case, and the same path twice", () => {
    expect(reasons(evaluatePathPolicy([file("src/Report.ts"), file("src/report.ts")], config()))).toContain("differ only by case");
    expect(reasons(evaluatePathPolicy([file("src/report.ts"), file("src/report.ts")], config()))).toContain("appears twice");
  });
});

describe("denied paths", () => {
  it.each([
    "src/auth/login.ts",
    "src/Auth/Session.ts",
    "lib/oauth-client.ts",
    "app/middleware.ts",
    "src/http/middleware/cors.ts",
    "lib/billing/invoice.ts",
    "src/pricing.tsx",
    "src/checkout/cart.ts",
    "src/subscriptions/renew.ts",
    "docs/privacy.md",
    "src/consent-banner.tsx",
    "src/security/headers.ts",
    "src/crypto/hash.ts",
    ".github/workflows/ci.yml",
    ".gitlab-ci.yml",
    ".circleci/config.yml",
    "Jenkinsfile",
    ".githooks/pre-commit",
    "CODEOWNERS",
    ".gitattributes",
    "Dockerfile",
    "infra/main.tf",
    "wrangler.jsonc",
    ".env",
    "config/.env.production",
    ".dev.vars",
    "keys/server.pem",
    "deploy/id_rsa",
    "src/config/api_keys.ts",
    "src/apiKey.ts",
    ".npmrc",
    "src/internal/flags.ts",
    "src/admin/users.ts",
    "packages/api/src/webhooks/github.ts",
    "src/api/private/export.ts",
  ])("refuses %s by default", (path) => {
    const v = evaluatePathPolicy([file(path)], config());
    expect(refused(v)).toBe(true);
    expect(reasons(v)).toContain("denied path");
  });

  it("keeps the defaults even when the deployment lists no denied paths", () => {
    expect(refused(evaluatePathPolicy([file("src/auth.ts")], config({ deniedPaths: [] })))).toBe(true);
  });

  it("adds the deployment's own globs to the defaults", () => {
    const c = config({ deniedPaths: ["migrations/**", "**/*.sql"] });
    expect(refused(evaluatePathPolicy([file("migrations/0001_init.ts")], c))).toBe(true);
    expect(refused(evaluatePathPolicy([file("db/schema.sql")], c))).toBe(true);
    expect(evaluatePathPolicy([file("src/reports/csv.ts")], c).decision).toBe("allow");
  });

  it("refuses a rename out of a denied path", () => {
    const v = evaluatePathPolicy([file("src/reports/moved.ts", { change: "renamed", previousPath: "src/auth/token.ts" })], config());
    expect(reasons(v)).toContain("renamed from a denied path");
  });

  it("matches globs the way the policy documents", () => {
    expect(globToRegExp("**/*auth*").test("auth.ts")).toBe(true);
    expect(globToRegExp("**/*auth*").test("a/b/OAuth.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("src/**").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("a?c").test("abc")).toBe(true);
    expect(globToRegExp("a.b").test("aXb")).toBe(false);
    expect(deniedBy("src/billing/x/y.ts", ["**/*billing*"])).toBe("**/*billing*");
    expect(deniedBy("src/reports/csv.ts", DEFAULT_DENIED_PATHS)).toBeNull();
  });
});

describe("renames, modes and content", () => {
  it("refuses a rename without its previous path, and a previous path on anything else", () => {
    expect(reasons(evaluatePathPolicy([file("src/b.ts", { change: "renamed" })], config()))).toContain("previous path");
    expect(reasons(evaluatePathPolicy([file("src/b.ts", { previousPath: "src/a.ts" })], config()))).toContain("not a rename");
    expect(refused(evaluatePathPolicy([file("src/b.ts", { change: "renamed", previousPath: "../a.ts" })], config()))).toBe(true);
  });

  it("allows a plain rename", () => {
    expect(evaluatePathPolicy([file("src/b.ts", { change: "renamed", previousPath: "src/a.ts" })], config()).decision).toBe("allow");
  });

  it("refuses an unknown change kind", () => {
    expect(refused(evaluatePathPolicy([file("src/a.ts", { change: "copied" as ChangedFile["change"] })], config()))).toBe(true);
  });

  it.each([
    ["a symlink", "120000", "symlink"],
    ["a submodule", "160000", "submodule"],
    ["a group-writable file", "100664", "not allowed"],
    ["a tree", "040000", "not allowed"],
    ["an empty mode", "", "not allowed"],
    ["a removed file's mode on an addition", "000000", "not allowed"],
  ])("refuses %s", (_label, mode, why) => {
    expect(reasons(evaluatePathPolicy([file("src/a.ts", { mode })], config()))).toContain(why);
  });

  it("allows an executable file and a deletion's 000000 mode", () => {
    expect(evaluatePathPolicy([file("scripts/report.sh", { mode: "100755" })], config()).decision).toBe("allow");
    expect(evaluatePathPolicy([file("src/old.ts", { change: "deleted", mode: "000000", content: null, additions: 0, deletions: 12 })], config()).decision).toBe("allow");
  });

  it("refuses a deleted symlink", () => {
    expect(refused(evaluatePathPolicy([file("src/link", { change: "deleted", mode: "120000", content: null })], config()))).toBe(true);
  });

  it("refuses content that contradicts the change", () => {
    expect(reasons(evaluatePathPolicy([file("src/a.ts", { change: "deleted" })], config()))).toContain("deleted but carries content");
    expect(reasons(evaluatePathPolicy([file("src/a.ts", { change: "added", content: null })], config()))).toContain("no content");
    expect(reasons(evaluatePathPolicy([file("src/a.ts", { content: { encoding: "base64", data: "not base64!" }, binary: true })], config()))).toContain("cannot be decoded");
    expect(reasons(evaluatePathPolicy([file("src/a.ts", { content: { encoding: "base64", data: "aGk=" } })], config()))).toContain("not UTF-8");
  });

  it("refuses line counts that are not whole numbers", () => {
    for (const additions of [-1, 1.5, Number.NaN]) expect(reasons(evaluatePathPolicy([file("src/a.ts", { additions })], config()))).toContain("whole numbers");
  });

  it("refuses a file that does not say whether it is binary", () => {
    expect(refused(evaluatePathPolicy([file("src/a.ts", { binary: undefined as unknown as boolean })], config()))).toBe(true);
  });
});

describe("secrets", () => {
  // Built at run time from low-entropy parts, so no credential-shaped literal sits in the source.
  const samples: Array<[string, string]> = [
    ["a private key block", ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ") + "\nAAAA\n"],
    ["an AWS access key id", `const id = "${"AKIA"}${"Q".repeat(16)}";`],
    ["a GitHub token", `token: ${"ghp"}_${"k".repeat(36)}`],
    ["a Stripe live key", `${"sk"}_live_${"k".repeat(24)}`],
    ["a Slack token", `${"xoxb"}-${"1".repeat(12)}-abc`],
    ["a credential in a URL", "postgres://admin:hunter2hunter2@db.acme.example/app"],
    ["a hard-coded credential assignment", `const apiKey = "${"k".repeat(32)}";`],
  ];

  it.each(samples)("refuses %s in a text file", (_label, data) => {
    const v = evaluatePathPolicy([file("src/reports/config.ts", { content: { encoding: "utf-8", data } })], config());
    expect(refused(v)).toBe(true);
    expect(reasons(v)).toContain("looks like");
    expect(reasons(v)).not.toContain(data);
  });

  it("refuses a secret inside binary content", () => {
    const data = btoa(["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" "));
    expect(refused(evaluatePathPolicy([file("assets/blob.bin", { binary: true, content: { encoding: "base64", data } })], config()))).toBe(true);
  });

  it("does not mistake ordinary code for a secret", () => {
    expect(secretIn('const label = "Export quarantined tests";\nconst token = tokenize(input);\n')).toBeNull();
  });
});

describe("limits", () => {
  it("refuses a file over the per-file byte cap, counting UTF-8 bytes", () => {
    const big = "\u00e9".repeat(DEFAULT_LIMITS.maxFileBytes / 2 + 1);
    expect(reasons(evaluatePathPolicy([file("docs/big.md", { content: { encoding: "utf-8", data: big } })], config()))).toContain("limit per file");
    const exact = "a".repeat(DEFAULT_LIMITS.maxFileBytes);
    expect(evaluatePathPolicy([file("docs/exact.md", { content: { encoding: "utf-8", data: exact } })], config()).decision).toBe("allow");
  });

  it("refuses more than 2,000 lines and allows exactly 2,000", () => {
    expect(refused(evaluatePathPolicy([file("src/a.ts", { additions: 2001 })], config()))).toBe(true);
    expect(evaluatePathPolicy([file("src/a.ts", { additions: 2000 })], config()).decision).toBe("allow");
  });

  it("refuses more than 60 files and allows exactly 60", () => {
    expect(refused(evaluatePathPolicy(files(61), config()))).toBe(true);
    expect(evaluatePathPolicy(files(60), config()).decision).toBe("allow");
  });

  it("refuses a change over 2 MB in total", () => {
    const chunk = "a".repeat(DEFAULT_LIMITS.maxFileBytes);
    const many = Array.from({ length: 5 }, (_, i) => file(`docs/part-${i}.md`, { content: { encoding: "utf-8", data: chunk } }));
    expect(reasons(evaluatePathPolicy(many, config()))).toContain("bytes changed");
  });

  it("applies tighter limits the deployment sets", () => {
    expect(refused(evaluatePathPolicy([file("src/a.ts", { additions: 11 })], config({ limits: { ...DEFAULT_LIMITS, maxLines: 10 } })))).toBe(true);
  });

  it("never loosens a hard cap beyond the defaults", () => {
    const loose = config({ limits: { ...DEFAULT_LIMITS, maxLines: 1_000_000, maxFiles: 10_000, maxDiffBytes: 1e9, maxFileBytes: 1e9 } });
    expect(refused(evaluatePathPolicy([file("src/a.ts", { additions: 2001 })], loose))).toBe(true);
    expect(refused(evaluatePathPolicy(files(61), loose))).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses everything when a limit is %s", (bad) => {
    expect(refused(evaluatePathPolicy([file("src/a.ts")], config({ limits: { ...DEFAULT_LIMITS, mediumLines: bad } })))).toBe(true);
  });
});

describe("risk and review", () => {
  it("is low up to 120 lines and 5 files, and medium above either", () => {
    expect(evaluatePathPolicy([file("src/a.ts", { additions: 120 })], config())).toMatchObject({ risk: "low", needsReview: false });
    expect(evaluatePathPolicy([file("src/a.ts", { additions: 121 })], config())).toMatchObject({ risk: "medium", needsReview: false });
    expect(evaluatePathPolicy(files(5), config())).toMatchObject({ risk: "low" });
    expect(evaluatePathPolicy(files(6), config())).toMatchObject({ risk: "medium" });
  });

  it("needs review above 400 lines or 15 files", () => {
    expect(evaluatePathPolicy([file("src/a.ts", { additions: 400 })], config())).toMatchObject({ needsReview: false });
    expect(evaluatePathPolicy([file("src/a.ts", { additions: 401 })], config())).toMatchObject({ risk: "medium", needsReview: true });
    expect(evaluatePathPolicy(files(15), config())).toMatchObject({ needsReview: false });
    expect(evaluatePathPolicy(files(16), config())).toMatchObject({ needsReview: true });
  });

  it("is high, and needs review, for a binary file", () => {
    const v = evaluatePathPolicy([file("assets/logo.png", { binary: true, content: { encoding: "base64", data: "iVBORw0KGgo=" } })], config());
    expect(v).toMatchObject({ decision: "allow", risk: "high", needsReview: true });
  });

  it.each(["package.json", "packages/ui/package-lock.json", "yarn.lock", "pnpm-lock.yaml", "go.sum", "Cargo.toml", "requirements-dev.txt", "app/App.csproj", "Gemfile.lock", "pyproject.toml"])(
    "is high for the dependency manifest %s",
    (path) => {
      expect(isDependencyManifest(path)).toBe(true);
      expect(evaluatePathPolicy([file(path)], config())).toMatchObject({ decision: "allow", risk: "high", needsReview: true });
    },
  );

  it("is high when a lock file is deleted or renamed away", () => {
    expect(evaluatePathPolicy([file("yarn.lock", { change: "deleted", content: null, mode: "000000", additions: 0, deletions: 40 })], config())).toMatchObject({ risk: "high" });
    expect(evaluatePathPolicy([file("old/manifest.txt", { change: "renamed", previousPath: "package.json" })], config())).toMatchObject({ risk: "high" });
  });

  it("reports every refusal, not only the first", () => {
    const v = evaluatePathPolicy([file("../x.ts"), file("src/auth.ts"), file("src/a.ts", { mode: "120000" })], config({ repo: "acme-example/other" }));
    expect(v.reasons.length).toBeGreaterThanOrEqual(4);
  });
});

describe("pathPolicyConfig", () => {
  it("fills in the defaults and keeps the deployment's extra globs", () => {
    const c = pathPolicyConfig({ repo: REPO, allowedRepos: [REPO], deniedPaths: ["legacy/**"] });
    expect(c.limits).toEqual(DEFAULT_LIMITS);
    expect(c.deniedPaths).toEqual(expect.arrayContaining([...DEFAULT_DENIED_PATHS, "legacy/**"]));
  });
});
