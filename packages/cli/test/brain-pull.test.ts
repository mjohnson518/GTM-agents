// GTM-agents: tests for `gtm brain pull` and the upload guard: a component approved in the deployment
// (the dashboard's Product and ICP page, an approved brain proposal) is never silently undone by an
// upload from stale local files, and pull brings it into the local folder. Everything is synthetic.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BRAIN_LOCK_KEY, brainFileKey, computeLock, parseLock, serializeLock } from "@gtm-agents/core/brain";
import { describe, expect, it } from "vitest";
import { brainCommand } from "../src/commands/brain.ts";
import { setUpDeployment } from "./deployment.ts";
import { FakeAccount } from "./fake-wrangler.ts";
import { captureIo } from "./helpers.ts";

async function brain(dir: string, account: FakeAccount, args: string[]) {
  const io = captureIo(dir);
  const code = await brainCommand(args, io, { runner: account.runner });
  return { code, text: io.text() };
}

const PRODUCT_V2 = `---
component: product
status: approved
version: 2
updated: 2026-11-15
owner: Head of Sales
---

# Product

## summary
- kind: summary
- text: Acme Quarantine keeps flaky tests from blocking merges, approved on the Product and ICP page.
`;

/** What the dashboard does when a person approves a product proposal: the file, then the lock. */
async function approveInDeployment(account: FakeAccount): Promise<void> {
  const store = account.store();
  const lock = parseLock(store.get(BRAIN_LOCK_KEY) ?? null);
  if (!lock) throw new Error("nothing uploaded yet");
  const files = Object.keys(lock.files).map((name) => ({ name, content: name === "product.md" ? PRODUCT_V2 : (store.get(brainFileKey(name.replace(/\.md$/, "") as never)) ?? "") }));
  store.set(brainFileKey("product"), PRODUCT_V2);
  store.set(BRAIN_LOCK_KEY, serializeLock(await computeLock(files)));
}

const puts = (account: FakeAccount) => account.callsTo("kv", "bulk", "put").length;

describe("the upload guard", () => {
  it("stops an upload that would undo a newer component in the deployment, unless forced", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account, { brain: true });
    expect((await brain(dir, account, ["upload", "--yes"])).code).toBe(0);
    await approveInDeployment(account);
    const before = puts(account);
    const stale = await brain(dir, account, ["upload", "--yes"]);
    expect(stale.code).toBe(1);
    expect(stale.text).toContain("product.md: the deployment serves version 2, the local file is version 1");
    expect(stale.text).toContain("Run gtm brain pull first");
    expect(puts(account)).toBe(before);
    expect(account.store().get(brainFileKey("product"))).toBe(PRODUCT_V2);

    const forced = await brain(dir, account, ["upload", "--yes", "--force"]);
    expect(forced.code).toBe(0);
    expect(forced.text).toContain("--force: replacing 1 component(s)");
    expect(account.store().get(brainFileKey("product"))).not.toBe(PRODUCT_V2);
  });

  it("stops when the deployment serves a component the local folder does not have", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account, { brain: true });
    expect((await brain(dir, account, ["upload", "--yes"])).code).toBe(0);
    rmSync(join(dir, "brain/product.md"));
    expect((await brain(dir, account, ["validate", "brain", "--write-lock"])).code).toBe(0);
    const result = await brain(dir, account, ["upload", "--yes"]);
    expect(result.code).toBe(1);
    expect(result.text).toContain("product.md: the deployment serves version 1, and the local folder has no such file");
  });

  it("stops when the deployed brain cannot be read, unless forced", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account, { brain: true });
    account.intercept = (args) => (args[0] === "kv" && args[2] === "get" ? { code: 1, stdout: "", stderr: "X [ERROR] Authentication error [code: 10000]" } : undefined);
    const result = await brain(dir, account, ["upload", "--yes"]);
    expect(result.code).toBe(1);
    expect(result.text).toContain("cannot be checked for newer components");
    expect(puts(account)).toBe(0);
    expect((await brain(dir, account, ["upload", "--yes", "--force"])).code).toBe(0);
  });
});

describe("the upload guard, continued", () => {
  it("stops on the same version with other content, and on a deployed file that does not match its lock", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account, { brain: true });
    expect((await brain(dir, account, ["upload", "--yes"])).code).toBe(0);
    const store = account.store();
    const served = store.get(brainFileKey("product")) ?? "";
    await approveInDeployment(account);
    store.set(brainFileKey("product"), PRODUCT_V2.replace("version: 2", "version: 1"));
    const settling = await brain(dir, account, ["upload", "--yes"]);
    expect(settling.code).toBe(1);
    expect(settling.text).toContain("do not match the deployed lock");
    expect((await brain(dir, account, ["pull", "--yes"])).code).toBe(1);
    // Same version, other content: what a local edit that reused the served number looks like.
    const files = (parseLock(store.get(BRAIN_LOCK_KEY) ?? null)?.files ?? {});
    const content = served.replace("Acme Quarantine", "Acme Quarantine (edited in the deployment)");
    store.set(brainFileKey("product"), content);
    const lockFiles = Object.keys(files).map((name) => ({ name, content: name === "product.md" ? content : (store.get(brainFileKey(name.replace(/\.md$/, "") as never)) ?? "") }));
    store.set(BRAIN_LOCK_KEY, serializeLock(await computeLock(lockFiles)));
    const same = await brain(dir, account, ["upload", "--yes"]);
    expect(same.code).toBe(1);
    expect(same.text).toContain("the same version with other content");
  });
});

describe("gtm brain pull", () => {
  it("writes what the deployment serves, asking before it replaces a local file, and makes the next upload safe", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account, { brain: true });
    expect((await brain(dir, account, ["upload", "--yes"])).code).toBe(0);
    await approveInDeployment(account);

    const asked = await brain(dir, account, ["pull"]);
    expect(asked.code).toBe(1);
    expect(asked.text).toContain("product.md differs from the deployed version 2");
    expect(readFileSync(join(dir, "brain/product.md"), "utf8")).not.toBe(PRODUCT_V2);

    const pulled = await brain(dir, account, ["pull", "--yes"]);
    expect(pulled.code).toBe(0);
    expect(pulled.text).toContain("wrote 1 changed file(s) and the lock");
    expect(readFileSync(join(dir, "brain/product.md"), "utf8")).toBe(PRODUCT_V2);
    expect(JSON.parse(readFileSync(join(dir, "brain/brain.lock.json"), "utf8"))).toEqual(JSON.parse(account.store().get(BRAIN_LOCK_KEY) ?? "{}"));
    expect((await brain(dir, account, ["validate", "brain"])).code).toBe(0);
    expect((await brain(dir, account, ["upload", "--yes"])).code).toBe(0);
    expect(account.store().get(brainFileKey("product"))).toBe(PRODUCT_V2);
  });

  it("writes nothing when the deployment serves no brain yet", async () => {
    const account = new FakeAccount();
    const dir = await setUpDeployment(account, { brain: true });
    const before = readFileSync(join(dir, "brain/brain.lock.json"), "utf8");
    const result = await brain(dir, account, ["pull"]);
    expect(result.code).toBe(0);
    expect(result.text).toContain("serves no brain yet");
    expect(readFileSync(join(dir, "brain/brain.lock.json"), "utf8")).toBe(before);
  });
});
