// GTM-agents: tests for inbox detection: the poll's cursor, the sweep, body repair and the three
// registered jobs, over an in-memory mailbox. Every message and address is synthetic.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { memoryKv, type MemoryKvNamespace } from "../src/agents/testing.ts";
import type { InboxEnv } from "../src/inbox/jobs.ts";
import { INBOX_POLL_JOB, INBOX_SWEEP_JOB, INBOX_WATCH_JOB, createInboxJobs } from "../src/inbox/jobs.ts";
import { cursorKey, pollInbox, readCursor, sweepInbox, type PollDeps } from "../src/inbox/poll.ts";
import { fakeInbox, inboundMessage, type FakeInbox } from "../src/inbox/testing.ts";
import type { JobContext, RegisteredJob } from "../src/jobs/registry.ts";
import { kvFlags } from "../src/sending/flags.ts";
import { NOW, config, failingOn, uid } from "./delivery-fakes.ts";

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

function pollDeps(inbox: FakeInbox, kv: MemoryKvNamespace, overrides: Partial<PollDeps> = {}): PollDeps {
  return { db: env.DB, bucket: env.BUCKET, kv, config, provider: inbox.name, now: NOW, inbox, limit: 10, ...overrides };
}

const from = () => ({ email: `${uid("riley")}@${uid("prospect")}.example` });

/** A database that records every statement prepared on it. */
function watchedDb(): { db: D1Database; statements: string[] } {
  const statements: string[] = [];
  const db = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          statements.push(sql);
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db, statements };
}

async function count(provider: string): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM inbound_emails WHERE provider = ?1").bind(provider).first<{ n: number }>())?.n ?? 0;
}

describe("pollInbox", () => {
  it("records new mail, then stores the cursor; a quiet poll costs one listing and one query", async () => {
    const inbox = fakeInbox({ name: uid("inbox"), messages: [inboundMessage({ from: from() }), inboundMessage({ from: from() })] });
    const kv = memoryKv();
    const first = await pollInbox(pollDeps(inbox, kv));
    expect(first.intake.recorded).toBe(2);
    expect(first.cursorStored).toBe(true);
    expect((await readCursor(kv, inbox.name))?.cursor).toBe("n:2");
    expect(inbox.listCalls[0]).toMatchObject({ since: new Date(NOW.getTime() - 86_400_000).toISOString() });
    expect(inbox.listCalls[0]?.cursor).toBeUndefined();

    const watched = watchedDb();
    const quiet = await pollInbox(pollDeps(inbox, kv, { db: watched.db }));
    expect(quiet.intake.received).toBe(0);
    expect(quiet.cursorStored).toBe(false);
    expect(inbox.listCalls.at(-1)?.cursor).toBe("n:2");
    expect(watched.statements.length).toBeLessThanOrEqual(1);

    inbox.mailbox.push(inboundMessage({ from: from() }));
    const next = await pollInbox(pollDeps(inbox, kv));
    expect(next.intake.recorded).toBe(1);
    expect((await readCursor(kv, inbox.name))?.cursor).toBe("n:3");
    expect(await count(inbox.name)).toBe(3);
  });

  it("keeps the cursor where it was when a message cannot be recorded, so the next poll lists it again", async () => {
    const inbox = fakeInbox({ name: uid("inbox"), messages: [inboundMessage({ from: from() })] });
    const kv = memoryKv({ [cursorKey(inbox.name)]: JSON.stringify({ cursor: "n:0", at: NOW.toISOString() }) });
    const broken = await pollInbox(pollDeps(inbox, kv, { db: failingOn(env.DB, /INSERT INTO inbound_emails/) }));
    expect(broken.intake.failed).toBe(1);
    expect(broken.cursorStored).toBe(false);
    expect((await readCursor(kv, inbox.name))?.cursor).toBe("n:0");
    const healed = await pollInbox(pollDeps(inbox, kv));
    expect(healed.intake.recorded).toBe(1);
    expect((await readCursor(kv, inbox.name))?.cursor).toBe("n:1");
  });

  it("falls back to the window when the cursor has expired, and replaces it", async () => {
    const inbox = fakeInbox({ name: uid("inbox"), messages: [inboundMessage({ from: from() })] });
    const kv = memoryKv({ [cursorKey(inbox.name)]: JSON.stringify({ cursor: "n:expired", at: NOW.toISOString() }) });
    const result = await pollInbox(pollDeps(inbox, kv));
    expect(result).toMatchObject({ reset: true, cursorStored: true });
    expect(result.intake.recorded).toBe(1);
    expect((await readCursor(kv, inbox.name))?.cursor).toBe("n:1");
  });

  it("follows `more` for a bounded number of pages, and resumes after them next time", async () => {
    const inbox = fakeInbox({ name: uid("inbox"), messages: [1, 2, 3].map(() => inboundMessage({ from: from() })) });
    const kv = memoryKv({ [cursorKey(inbox.name)]: JSON.stringify({ cursor: "n:0", at: NOW.toISOString() }) });
    const result = await pollInbox(pollDeps(inbox, kv, { limit: 1, maxPages: 2 }));
    expect(result.pages).toBe(2);
    expect(result.intake.recorded).toBe(2);
    expect((await readCursor(kv, inbox.name))?.cursor).toBe("n:2");
    expect((await pollInbox(pollDeps(inbox, kv, { limit: 1, maxPages: 2 }))).intake.recorded).toBe(1);
  });

  it("treats an inbound-only provider as not listing, and still runs the pending pass", async () => {
    const inbox = fakeInbox({ name: uid("routing"), listing: false });
    const result = await pollInbox(pollDeps(inbox, memoryKv()));
    expect(result.unsupported).toBe(true);
    expect(result.pending.attempted).toBeGreaterThanOrEqual(0);
  });

  it("works with no KV at all, listing the window each time", async () => {
    const inbox = fakeInbox({ name: uid("inbox"), messages: [inboundMessage({ from: from() })] });
    const result = await pollInbox({ ...pollDeps(inbox, memoryKv()), kv: null });
    expect(result.intake.recorded).toBe(1);
    expect(result.cursorStored).toBe(false);
  });
});

describe("sweepInbox", () => {
  it("records only what the database does not hold, from the last three days, and leaves the cursor alone", async () => {
    const known = inboundMessage({ from: from() });
    const missed = inboundMessage({ from: from(), receivedAt: "2026-11-02T09:00:00.000Z" });
    const old = inboundMessage({ from: from(), receivedAt: "2026-10-20T09:00:00.000Z" });
    const inbox = fakeInbox({ name: uid("inbox"), messages: [old, known, missed] });
    const kv = memoryKv({ [cursorKey(inbox.name)]: JSON.stringify({ cursor: "n:1", at: NOW.toISOString() }) });
    await pollInbox(pollDeps(inbox, kv));
    inbox.fetched.length = 0;
    // The poll from n:1 recorded `known` and `missed`; forget `missed` to model a message the poll never saw.
    await env.DB.prepare("DELETE FROM inbound_emails WHERE provider = ?1 AND provider_message_id = ?2").bind(inbox.name, missed.providerMessageId).run();
    const before = await readCursor(kv, inbox.name);
    const result = await sweepInbox({ ...pollDeps(inbox, kv), limit: 25 });
    expect(result.intake.recorded).toBe(1);
    expect(inbox.fetched).toEqual([missed.providerMessageId]);
    expect(await readCursor(kv, inbox.name)).toEqual(before);
    expect(inbox.listCalls.at(-1)?.since).toBe(new Date(NOW.getTime() - 3 * 86_400_000).toISOString());
    expect(inbox.listCalls.at(-1)?.cursor).toBeUndefined();
  });

  it("fetches again a body that could not be stored, and gives up on one the mailbox no longer has", async () => {
    const message = inboundMessage({ from: from(), text: "The full text." });
    const gone = inboundMessage({ from: from() });
    const inbox = fakeInbox({ name: uid("inbox"), messages: [message] });
    const failing = { put: () => Promise.reject(new Error("R2 unavailable")), get: env.BUCKET.get.bind(env.BUCKET), delete: env.BUCKET.delete.bind(env.BUCKET) } as unknown as R2Bucket;
    await pollInbox(pollDeps(inbox, memoryKv(), { bucket: failing }));
    await pollInbox(pollDeps(fakeInbox({ name: inbox.name, messages: [gone] }), memoryKv(), { bucket: failing }));
    const result = await sweepInbox({ ...pollDeps(inbox, memoryKv()), limit: 25 });
    expect(result.repaired).toBe(1);
    const repaired = await env.DB.prepare("SELECT body_key, notes FROM inbound_emails WHERE provider = ?1 AND provider_message_id = ?2").bind(inbox.name, message.providerMessageId).first<{ body_key: string | null; notes: string | null }>();
    expect(repaired?.body_key).not.toBeNull();
    expect(repaired?.notes ?? "").not.toContain("[body_not_stored]");
    expect(await (await env.BUCKET.get(repaired?.body_key ?? ""))?.text()).toBe("The full text.");
    const lost = await env.DB.prepare("SELECT body_key, notes FROM inbound_emails WHERE provider = ?1 AND provider_message_id = ?2").bind(inbox.name, gone.providerMessageId).first<{ body_key: string | null; notes: string | null }>();
    expect(lost?.body_key).toBeNull();
    expect(lost?.notes).toContain("[body_unrecoverable]");
  });
});

describe("createInboxJobs", () => {
  function contextFor(job: RegisteredJob<InboxEnv>, kv: MemoryKvNamespace): JobContext<InboxEnv> {
    return { env: { DB: env.DB, KV: kv, BUCKET: env.BUCKET }, config, job: job.name, now: NOW, signal: new AbortController().signal, ceilings: job.ceilings, flags: kvFlags(kv), log: silentLog };
  }

  it("registers the poll, the sweep and the watch renewal behind inbox:enabled, with ceilings", () => {
    const jobs = createInboxJobs<InboxEnv>({ inbox: () => fakeInbox() });
    expect(jobs.map((j) => [j.name, j.schedule, j.flag])).toEqual([
      [INBOX_POLL_JOB, "* * * * *", "inbox:enabled"],
      [INBOX_SWEEP_JOB, "*/15 * * * *", "inbox:enabled"],
      [INBOX_WATCH_JOB, "20 6 * * SUN-SAT", "inbox:enabled"],
    ]);
    for (const job of jobs) {
      expect(job.ceilings.maxDurationMs).toBeGreaterThan(0);
      expect(job.ceilings.maxRows).toBeGreaterThan(0);
    }
    expect(jobs[0]?.ceilings.maxDurationMs).toBeLessThan(60_000);
    expect(() => createInboxJobs<InboxEnv>({ options: { pollLimit: 0 } })).toThrow(/pollLimit/);
  });

  it("does nothing with the flag off or unreadable, even when run directly", async () => {
    const inbox = fakeInbox({ name: uid("inbox"), messages: [inboundMessage({ from: from() })], watch: true });
    const jobs = createInboxJobs<InboxEnv>({ inbox: () => inbox });
    const off = memoryKv();
    const unreadable = memoryKv({ "inbox:enabled": "true" });
    unreadable.failing = true;
    for (const kv of [off, unreadable]) {
      for (const job of jobs) expect(await job.run(contextFor(job, kv))).toEqual({ summary: "flag off" });
    }
    expect(inbox.listCalls).toHaveLength(0);
    expect(inbox.watchCalls).toBe(0);
  });

  it("polls, sweeps and renews the watch with the flag on", async () => {
    const inbox = fakeInbox({ name: uid("inbox"), messages: [inboundMessage({ from: from() })], watch: true, now: () => NOW });
    const kv = memoryKv({ "inbox:enabled": "true" });
    const [poll, sweep, watch] = createInboxJobs<InboxEnv>({ inbox: () => inbox });
    if (!poll || !sweep || !watch) throw new Error("expected three jobs");
    // A poll that listed the mailbox carries the mark the follow-up intake gate looks for.
    expect((await poll.run(contextFor(poll, kv)))?.summary).toMatch(/^listed; .*recorded 1/);
    expect((await sweep.run(contextFor(sweep, kv)))?.summary).toContain("recorded 0");
    expect((await watch.run(contextFor(watch, kv)))?.summary).toBe(`push watch renewed until ${new Date(NOW.getTime() + 7 * 86_400_000).toISOString()}`);
    expect(inbox.watchCalls).toBe(1);
  });

  it("reports push as not configured, and polls only pending rows, when the mailbox lacks them", async () => {
    const kv = memoryKv({ "inbox:enabled": "true" });
    const [poll, , watch] = createInboxJobs<InboxEnv>({ inbox: () => fakeInbox({ name: uid("inbox") }) });
    if (!poll || !watch) throw new Error("expected jobs");
    expect(await watch.run(contextFor(watch, kv))).toEqual({ summary: "push not configured" });
    const [bare] = createInboxJobs<InboxEnv>({});
    if (!bare) throw new Error("expected a poll job");
    // Without a mailbox nothing was listed: no mark, so follow-ups stay held.
    expect((await bare.run(contextFor(bare, kv)))?.summary).toMatch(/^no mailbox to poll; pending/);
  });
});
