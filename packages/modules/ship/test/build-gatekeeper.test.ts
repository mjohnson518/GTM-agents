// GTM-agents: the ship build's gatekeeper: collected files are normalized against the base commit
// before anything is judged; a change is stored and approved by the digest of its exact bytes; the
// policy runs again on the exact files before the one commit; a retry makes no second commit; and a
// change that needs a person is never committed without an approval of that digest. Every
// repository and file is invented.
import { describe, expect, it } from "vitest";
import type { PathKind, RepoFile } from "@gtm-agents/core/ports";
import { fakeCodeHost, FAKE_BASE_SHA } from "../src/code-host-testing.ts";
import type { ChangedFile, PathPolicyVerdict, ShipSpec } from "../src/contract.ts";
import { changesKey, commitMessage, decodeChanges, digestOfKey, encodeChanges, gatekeep, lineDelta, maxRisk, normalizeChanges, pullRequestText, riskCode, type GatekeepInput } from "../src/gatekeeper.ts";
import { evaluatePathPolicy, pathPolicyConfig } from "../src/path-policy.ts";
import { SHIP_TEST_REPO, specAnswer } from "../src/planning-testing.ts";
import { collectedFile } from "../src/sandbox-testing.ts";
import { parseSpec } from "../src/spec.ts";

const spec = parseSpec(specAnswer()) as ShipSpec;
const policy = pathPolicyConfig({ repo: SHIP_TEST_REPO, allowedRepos: [SHIP_TEST_REPO] });
const reader = (files: Record<string, string | RepoFile>) => (path: string) => {
  const value = files[path];
  if (value === undefined) return Promise.resolve(null);
  return Promise.resolve(typeof value === "string" ? { size: value.length, encoding: "utf-8" as const, data: value } : value);
};
/** What each path is at the base, from the same file map: a file, the directory above one, or nothing. */
const kinds =
  (files: Record<string, string | RepoFile>, extra: Record<string, PathKind> = {}) =>
  (path: string): Promise<PathKind> =>
    Promise.resolve(extra[path] ?? (path in files ? "file" : Object.keys(files).some((f) => f.startsWith(`${path}/`)) ? "directory" : "missing"));

async function input(files: ChangedFile[], overrides: Partial<GatekeepInput> = {}, baseFiles: Record<string, string> = {}) {
  const host = fakeCodeHost({ repo: SHIP_TEST_REPO, webhookSecret: "w".repeat(32), files: baseFiles });
  const { digest } = await encodeChanges(files);
  const full: GatekeepInput = { host, evaluate: evaluatePathPolicy, policy, taskId: "st_0001", repo: SHIP_TEST_REPO, baseBranch: "main", baseSha: FAKE_BASE_SHA, spec, files, digest, approvedDigest: null, draft: false, maxBaseBytes: 1024 * 1024, ...overrides };
  return { host, digest, full };
}

describe("normalizing a change against the base commit", () => {
  it("bounds the changed lines from above by trimming only common leading and trailing lines", () => {
    expect(lineDelta("a\nb\nc\n", "a\nB\nc\n")).toEqual({ additions: 1, deletions: 1 });
    expect(lineDelta("", "a\nb\n")).toEqual({ additions: 2, deletions: 0 });
    expect(lineDelta("a\nb\n", "")).toEqual({ additions: 0, deletions: 2 });
    expect(lineDelta("a\nb\nc\nd\n", "a\nx\nc\ny\nd\n")).toEqual({ additions: 3, deletions: 2 });
    expect(lineDelta("same\n", "same\n")).toEqual({ additions: 0, deletions: 0 });
    expect(lineDelta("no newline", "no newline\nmore")).toEqual({ additions: 1, deletions: 0 });
  });

  it("replaces what the container reported with what the base commit shows", async () => {
    // The base already has files under src/, as nearly every repository does.
    const base = { "src/edit.ts": "keep\noriginal\nkeep\n", "src/gone.ts": "1\n2\n3\n", "src/old-name.ts": "moved\n" };
    const out = await normalizeChanges(
      [
        collectedFile("src/new.ts", "one\ntwo\n", { change: "modified", additions: 0, deletions: 0 }),
        collectedFile("src/edit.ts", "keep\nchanged\nkeep\n", { change: "added", additions: 99, deletions: 99 }),
        { path: "src/gone.ts", change: "deleted", additions: 0, deletions: 0, mode: "100644", binary: false, content: null },
        { path: "src/never-existed.ts", change: "deleted", additions: 0, deletions: 0, mode: "100644", binary: false, content: null },
        collectedFile("src/moved.ts", "moved\n", { change: "renamed", previousPath: "src/old-name.ts" }),
        collectedFile("src/fresh.ts", "fresh\n", { change: "renamed", previousPath: "src/not-there.ts" }),
        { path: "assets/logo.png", change: "added", additions: 5, deletions: 0, mode: "100644", binary: false, content: { encoding: "base64", data: "AAEC" } },
      ],
      reader(base),
      kinds(base),
    );
    const by = Object.fromEntries(out.map((f) => [f.path, f]));
    expect(Object.keys(by).sort()).toEqual(["assets/logo.png", "src/edit.ts", "src/fresh.ts", "src/gone.ts", "src/moved.ts", "src/new.ts"]);
    expect(by["src/new.ts"]).toMatchObject({ change: "added", additions: 2, deletions: 0 });
    expect(by["src/edit.ts"]).toMatchObject({ change: "modified", additions: 1, deletions: 1 });
    expect(by["src/gone.ts"]).toMatchObject({ change: "deleted", additions: 0, deletions: 3, content: null });
    expect(by["src/moved.ts"]).toMatchObject({ change: "renamed", previousPath: "src/old-name.ts", additions: 0, deletions: 0 });
    expect(by["src/fresh.ts"]).toMatchObject({ change: "added", additions: 1 });
    expect(by["src/fresh.ts"]).not.toHaveProperty("previousPath");
    expect(by["assets/logo.png"]).toMatchObject({ binary: true, additions: 0 });
  });

  it("counts every byte of a base file too large to read, so an unreadable file only raises the risk", async () => {
    const big = { "data/big.json": { size: 5_000_000, encoding: "base64" as const, data: null } };
    const out = await normalizeChanges([collectedFile("data/big.json", "{}\n", { change: "modified" })], reader(big), kinds(big));
    expect(out[0]).toMatchObject({ change: "modified", additions: 1, deletions: 5_000_000 });
  });

  it("writes into a directory the base has, and refuses to write under a file, symlink or submodule, or over a directory or submodule", async () => {
    const base = { "src/app/main.ts": "x\n", "README": "r\n", "docs/guide.md": "g\n" };
    const ok = await normalizeChanges([collectedFile("src/app/util.ts", "u\n"), collectedFile("src/app/main.ts", "y\n", { change: "modified" })], reader(base), kinds(base));
    expect(ok.map((f) => f.path).sort()).toEqual(["src/app/main.ts", "src/app/util.ts"]);
    await expect(normalizeChanges([collectedFile("README/inner.md", "x\n")], reader(base), kinds(base))).rejects.toThrow(/README is a file/);
    await expect(normalizeChanges([collectedFile("linked/inner.md", "x\n")], reader(base), kinds(base, { linked: "symlink" }))).rejects.toThrow(/linked is a symlink/);
    await expect(normalizeChanges([collectedFile("vendor/lib/x.c", "x\n")], reader(base), kinds(base, { vendor: "submodule" }))).rejects.toThrow(/vendor is a submodule/);
    await expect(normalizeChanges([collectedFile("docs", "now a file\n")], reader(base), kinds(base))).rejects.toThrow(/docs is a directory/);
    await expect(normalizeChanges([collectedFile("vendor", "x\n")], reader(base), kinds(base, { vendor: "submodule" }))).rejects.toThrow(/vendor is a submodule/);
  });
});

describe("a stored change", () => {
  it("has one digest whatever order the files arrive in, and a different one for any other byte", async () => {
    const a = collectedFile("a.ts", "a\n");
    const b = collectedFile("b.ts", "b\n");
    const one = await encodeChanges([a, b]);
    expect((await encodeChanges([b, a])).digest).toBe(one.digest);
    expect((await encodeChanges([a, collectedFile("b.ts", "b \n")])).digest).not.toBe(one.digest);
    expect((await encodeChanges([a, { ...b, mode: "100755" }])).digest).not.toBe(one.digest);
    expect(await decodeChanges(one.text, one.digest)).toEqual([a, b]);
    await expect(decodeChanges(one.text.replace("a\\n", "A\\n"), one.digest)).rejects.toThrow(/does not match its digest/);
    expect(digestOfKey(changesKey("st_0001", one.digest))).toBe(one.digest);
    expect(digestOfKey("ship/st_0001/changes-short.json")).toBeNull();
  });

  it("binds a risk code to both the task and the digest", async () => {
    const digest = (await encodeChanges([collectedFile("a.ts", "a\n")])).digest;
    const code = await riskCode("st_0001", digest);
    expect(code).toMatch(/^[0-9a-f]{8}$/);
    expect(await riskCode("st_0001", digest)).toBe(code);
    expect(await riskCode("st_0002", digest)).not.toBe(code);
    expect(await riskCode("st_0001", "0".repeat(64))).not.toBe(code);
  });
});

describe("the gatekeeper", () => {
  it("commits the normalized files once and opens the pull request, and a retry makes no second commit", async () => {
    const { host, full } = await input([collectedFile("src/quarantine/csv.ts", "export const csv = 1;\n", { additions: 40, deletions: 40 })]);
    const first = await gatekeep(full);
    expect(first).toMatchObject({ ok: true, risk: "low", filesChanged: 1, linesChanged: 1, commit: { branch: "ship/st_0001", created: true }, pr: { number: 41, created: true } });
    expect(host.commits[0]?.files).toEqual([collectedFile("src/quarantine/csv.ts", "export const csv = 1;\n", { change: "added", additions: 1, deletions: 0 })]);
    const again = await gatekeep(full);
    expect(again).toMatchObject({ ok: true, commit: { created: false }, pr: { number: 41, created: false } });
    expect(host.commits).toHaveLength(1);
    expect(host.pulls).toHaveLength(1);
  });

  it("refuses files that are not the ones evaluated, before reading or writing anything", async () => {
    const { host, full } = await input([collectedFile("src/quarantine/csv.ts", "export const csv = 1;\n")]);
    const result = await gatekeep({ ...full, files: [collectedFile("src/quarantine/csv.ts", "export const csv = 2;\n")] });
    expect(result).toEqual({ ok: false, reason: "the files differ from the ones that were evaluated", refused: true });
    expect(host.calls).toEqual([]);
  });

  it("re-runs the policy on the exact files and refuses what it refuses, whatever was decided earlier", async () => {
    const { host, full } = await input([collectedFile("src/auth/session.ts", "export const open = true;\n")]);
    const result = await gatekeep({ ...full, approvedDigest: full.digest });
    expect(result).toMatchObject({ ok: false, refused: true });
    expect(host.commits).toHaveLength(0);
    const calls: PathPolicyVerdict[] = [];
    const counting = await input([collectedFile("src/quarantine/csv.ts", "x\n")]);
    await gatekeep({ ...counting.full, evaluate: (files, config) => (calls.push(evaluatePathPolicy(files, config)), calls[calls.length - 1] as PathPolicyVerdict) });
    expect(calls).toHaveLength(1);
  });

  it("commits a change that needs a person only with an approval of its exact digest", async () => {
    const dependency = [collectedFile("package.json", '{ "dependencies": { "left-pad": "1.3.0" } }\n', { change: "modified" })];
    const waiting = await input(dependency, {}, { "package.json": "{}\n" });
    expect(await gatekeep(waiting.full)).toEqual({ ok: false, reason: "the change needs a person's approval of these exact files", refused: true });
    expect(await gatekeep({ ...waiting.full, approvedDigest: "0".repeat(64) })).toMatchObject({ ok: false, refused: true });
    expect(waiting.host.commits).toHaveLength(0);
    expect(await gatekeep({ ...waiting.full, approvedDigest: waiting.digest })).toMatchObject({ ok: true, risk: "high" });
    expect(waiting.host.commits).toHaveLength(1);

    // A spec rated high needs the approval too, even for a one-line change.
    const small = await input([collectedFile("src/quarantine/csv.ts", "x\n")], { spec: { ...spec, risk: "high" } });
    expect(await gatekeep(small.full)).toMatchObject({ ok: false, refused: true });
    expect(maxRisk("low", "high")).toBe("high");
    expect(maxRisk("medium", "low")).toBe("medium");
  });

  it("writes the commit message and the pull request from the spec, saying that it never merges", () => {
    const verdict: Extract<PathPolicyVerdict, { decision: "allow" }> = { decision: "allow", risk: "low", needsReview: false, reasons: [], filesChanged: 2, linesChanged: 30 };
    expect(commitMessage(spec, "st_0001")).toBe("Export quarantined tests as CSV\n\nShip-Task: st_0001");
    const text = pullRequestText({ ...spec, problem: "Teams cannot export.\u0000\u202e" }, "st_0001", verdict, "low");
    expect(text.title).toBe("Export quarantined tests as CSV");
    expect(text.body).toContain("## Acceptance criteria\n- The quarantine list has an Export CSV button");
    expect(text.body).toContain("Risk low: 2 files, 30 lines changed");
    expect(text.body).toContain("never merges");
    expect(text.body).toContain("Ship-Task: st_0001");
    expect(text.body.includes("\u0000") || text.body.includes("\u202e")).toBe(false);
  });
});
