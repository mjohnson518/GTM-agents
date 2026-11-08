// GTM-agents: tests for loading the brain from KV at runtime.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { computeLock, serializeLock } from "../src/brain/lock.ts";
import { BRAIN_LOCK_KEY, brainFileKey, loadBrain } from "../src/brain/load.ts";
import { brainFile, factsBody, personasBody } from "./fixtures.ts";

const facts = brainFile("facts", factsBody);
const personas = brainFile("personas", personasBody);

async function upload(files: Record<string, string>, lockFiles = files) {
  const lock = await computeLock(Object.entries(lockFiles).map(([c, content]) => ({ name: `${c}.md`, content })));
  await env.KV.put(BRAIN_LOCK_KEY, serializeLock(lock));
  for (const [component, content] of Object.entries(files)) await env.KV.put(brainFileKey(component as "facts"), content);
  return lock;
}

describe("loadBrain", () => {
  beforeEach(async () => {
    for (const key of [BRAIN_LOCK_KEY, brainFileKey("facts"), brainFileKey("personas")]) await env.KV.delete(key);
  });

  it("serves approved, locked components with the lock version in the header", async () => {
    const lock = await upload({ facts, personas });
    const slice = await loadBrain(env, "outreach");
    expect(slice.version).toBe(lock.hash.slice(0, 12));
    expect(slice.included).toEqual(["personas", "facts"]);
    expect(slice.text).toContain(`version ${lock.hash.slice(0, 12)}`);
    expect(slice.missing).toEqual(["message-pillars", "voice"]);
  });

  it("serves no content without a lock, and still names what is missing", async () => {
    await env.KV.put(brainFileKey("facts"), facts);
    const slice = await loadBrain(env, "replies");
    expect(slice.included).toEqual([]);
    expect(slice.version).toBe("unlocked");
    expect(slice.text).not.toContain("median-setup");
    expect(slice.text).toContain("Do not fill these in from memory");
  });

  it("refuses a component whose bytes no longer match the lock", async () => {
    await upload({ facts, personas });
    await env.KV.put(brainFileKey("facts"), facts.replace("under an hour", "instantly"));
    const slice = await loadBrain(env, "outreach");
    expect(slice.included).toEqual(["personas"]);
    expect(slice.missing).toContain("facts");
  });

  it("refuses a draft even when it is locked", async () => {
    const draft = brainFile("facts", factsBody, { status: "draft" });
    await upload({ facts: draft });
    expect((await loadBrain(env, "replies")).included).toEqual([]);
  });

  it("never throws when the store fails; the prompt runs without the brain", async () => {
    const broken = { KV: { get: () => Promise.reject(new Error("KV unavailable")) } };
    const slice = await loadBrain(broken, "fit");
    expect(slice.included).toEqual([]);
    expect(slice.missing).toEqual(["icp"]);
    expect(slice.text).toContain("Missing from the brain for this task: icp.");
  });

  it("never throws for an unknown task", async () => {
    const slice = await loadBrain(env, "no-such-task" as "fit");
    expect(slice.included).toEqual([]);
  });

  it("refuses a locked file whose frontmatter names another component", async () => {
    await upload({ facts: brainFile("voice", "## d\n- kind: do\n- text: Short sentences.") });
    expect((await loadBrain(env, "replies")).included).toEqual([]);
  });

  it("refuses a locked file that breaks the content rules, such as a price outside commercial", async () => {
    const priced = brainFile("facts", "## plans\n- text: Plans start at $49 per seat.");
    await upload({ facts: priced });
    const slice = await loadBrain(env, "outreach");
    expect(slice.included).toEqual([]);
    expect(slice.text).not.toContain("$49");
  });
});
