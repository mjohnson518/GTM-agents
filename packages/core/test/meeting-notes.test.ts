// GTM-agents: tests for meeting notes (docs/MEETING-NOTES.md): matching a recording to a known
// contact, storing its transcript, extracting verbatim items, the briefs, the recap, the digest,
// retention and erasure. Every company, person, recording and transcript is invented.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryKv } from "../src/agents/testing.ts";
import { BRAIN_LOCK_KEY, brainFileKey } from "../src/brain/load.ts";
import { computeLock } from "../src/brain/lock.ts";
import { loadContactBrief, renderPrepBrief } from "../src/convert/brief.ts";
import { createConvertDraft } from "../src/convert/drafts.ts";
import { eraseContact } from "../src/data/erasure.ts";
import { FLAGS } from "../src/flags/registry.ts";
import type { MeetingRecording, TranscriptSegment } from "../src/ports/business.ts";
import { AdapterError } from "../src/ports/types.ts";
import { NOTES_FLAGS, createMeetingNotesJobs, keepQuote, runNotesExtract, runNotesIngest, runTranscriptRetention } from "../src/notes/index.ts";
import { fakeAnsweringModel, fakeNotesProvider } from "../src/notes/testing.ts";
import { seedContact } from "../src/outreach/testing.ts";
import { replyTestConfig } from "../src/replies/testing.ts";
import { loadFunnelDigest, renderFunnelDigest } from "../src/reports/funnel.ts";
import { addSuppression } from "../src/sending/suppression.ts";
import { createSpendGate } from "../src/sourcing/spend.ts";
import { brainFile } from "./fixtures.ts";
import { resetSignalTables } from "./signals-fakes.ts";
import { flagsOf, silentLog } from "./sourcing-fakes.ts";

const db = env.DB;
const bucket = env.BUCKET;
const NOW = new Date("2026-11-10T12:00:00.000Z");
const MODEL = "test-worker-model";
const config = replyTestConfig({ models: { roles: { worker: MODEL }, pricing: { [MODEL]: { inputCentsPerMTok: 1, outputCentsPerMTok: 1 } } } });

const TRANSCRIPT: TranscriptSegment[] = [
  { side: "us", speaker: "Avery", text: "Thanks for making the time today." },
  { side: "them", speaker: "Jane Doe", text: "Our biggest problem is that flaky tests block every release." },
  { side: "us", speaker: "Avery", text: "We could run a two week pilot on your main repository." },
  { side: "them", speaker: "Jane Doe", text: "Honestly the price worries me a bit." },
  { side: "them", speaker: "Jane Doe", text: "We also looked at Globex Test Insights last quarter." },
  { side: "us", speaker: "Avery", text: "I will send over the pilot plan on Friday." },
  { side: "them", speaker: "Jane Doe", text: "I'll loop in our VP of Engineering next week." },
];

const ANSWER = JSON.stringify({
  // Kept: the first. Dropped: words not in the transcript, and words only we said.
  pain_points: ["flaky tests block every release", "our CI bill doubled this year", "We could run a two week pilot on your main repository"],
  objections: ["the price worries me a bit", "We could run a two week pilot on your main repository"],
  next_steps: [
    { quote: "I will send over the pilot plan on Friday", owner: "us" },
    { quote: "I'll loop in our VP of Engineering next week", owner: "them" },
  ],
  // Kept: the first. Dropped: a name not in the brain, and a brain competitor nobody mentioned.
  competitors: ["Globex Test Insights", "Contoso Flaky Finder", "Initech CI Analytics"],
  sentiment: "positive",
});

function recording(id: string, startedAt: string, invitees: MeetingRecording["invitees"], transcriptAvailable = true): MeetingRecording {
  return { externalId: id, startedAt, endedAt: new Date(Date.parse(startedAt) + 30 * 60_000).toISOString(), title: "Acme intro call", invitees, transcriptAvailable };
}

async function brainKv(extra: Record<string, string> = {}) {
  const files: Record<string, string> = {
    ...Object.fromEntries(Object.entries(extra).map(([component, body]) => [component, brainFile(component, body)])),
    competitors: brainFile(
      "competitors",
      [
        "## globex",
        "- name: Globex Test Insights",
        "- positioning: A CI analytics dashboard.",
        "- differentiators: Acme quarantines flaky tests.",
        "",
        "## initech",
        "- name: Initech CI Analytics",
        "- positioning: A CI vendor add-on.",
        "- differentiators: Acme works across CI providers.",
        "",
      ].join("\n"),
    ),
  };
  const kv = memoryKv();
  for (const [component, content] of Object.entries(files)) await kv.put(brainFileKey(component as never), content);
  await kv.put(BRAIN_LOCK_KEY, JSON.stringify(await computeLock(Object.entries(files).map(([c, content]) => ({ name: `${c}.md`, content })))));
  return kv;
}

const ingest = (provider: ReturnType<typeof fakeNotesProvider>, now = NOW) => runNotesIngest({ db, bucket, provider, now, log: silentLog });
const extract = async (answer: string, options: { now?: Date; priced?: boolean } = {}) =>
  runNotesExtract({
    db,
    bucket,
    kv: await brainKv(),
    model: fakeAnsweringModel(answer),
    config: options.priced === false ? replyTestConfig() : config,
    spend: createSpendGate({ db, flags: flagsOf(), job: "meeting_notes_extract", jobCapCents: 100, now: () => options.now ?? NOW }),
    now: options.now ?? NOW,
    log: silentLog,
  });

const meetingsOf = (contactId: string) =>
  db.prepare("SELECT id, external_id, transcript_key, pain_points, objections, next_steps, competitors_mentioned, sentiment, processed_at, extract_attempts FROM meetings WHERE contact_id = ?1").bind(contactId).all<Record<string, string | number | null>>();
const recordingRow = (provider: string, id: string) => db.prepare("SELECT status, reason, meeting_id FROM meeting_recordings WHERE provider = ?1 AND external_id = ?2").bind(provider, id).first<Record<string, string | null>>();

beforeEach(async () => {
  await resetSignalTables(db);
  await db.batch([
    db.prepare("DELETE FROM meeting_recordings"),
    db.prepare("DELETE FROM meeting_notes_state"),
    db.prepare("DELETE FROM meetings"),
    db.prepare("DELETE FROM objections"),
    db.prepare("DELETE FROM drafts"),
    db.prepare("DELETE FROM event_effects"),
  ]);
});

describe("meeting notes: the gate", () => {
  it("a recording with a known contact becomes one meeting with a stored transcript, extraction keeps verbatim items, and erasure removes both", async () => {
    const contact = await seedContact(db, { first: "Jane", last: "Doe", email: "jane.doe@brightloop.example", warmth: "engaged" });
    const provider = fakeNotesProvider("notes-fathom", [recording("rec-1", "2026-11-09T15:00:00.000Z", [{ email: "avery@acme.example", external: false }, { email: "jane.doe@brightloop.example", external: true }])], { "rec-1": TRANSCRIPT });
    const stats = await ingest(provider);
    expect(stats).toMatchObject({ matched: 1 });
    const [row] = (await meetingsOf(contact)).results;
    expect(row).toMatchObject({ external_id: "notes-fathom:rec-1", processed_at: null });
    const blob = await bucket.get(String(row?.transcript_key));
    expect(blob).not.toBeNull();
    expect((JSON.parse((await blob?.text()) ?? "{}") as { segments: unknown[] }).segments).toHaveLength(TRANSCRIPT.length);
    expect(await recordingRow("notes-fathom", "rec-1")).toMatchObject({ status: "matched", meeting_id: row?.id });

    const extracted = await extract(ANSWER);
    expect(extracted).toMatchObject({ processed: 1, objectionsFiled: 1 });
    const [done] = (await meetingsOf(contact)).results;
    expect(JSON.parse(String(done?.pain_points))).toEqual(["flaky tests block every release"]);
    expect(JSON.parse(String(done?.objections))).toEqual(["the price worries me a bit"]);
    expect(JSON.parse(String(done?.next_steps))).toEqual([
      { quote: "I will send over the pilot plan on Friday", owner: "us" },
      { quote: "I'll loop in our VP of Engineering next week", owner: "them" },
    ]);
    expect(JSON.parse(String(done?.competitors_mentioned))).toEqual(["Globex Test Insights"]);
    expect(done).toMatchObject({ sentiment: "positive" });
    const objection = await db.prepare("SELECT author, pattern, response_template, approved_digest FROM objections").first<Record<string, string | null>>();
    // The pattern names a brain objection (none matches here), never the speaker's words.
    expect(objection).toEqual({ author: `meeting:${row?.id}:1`, pattern: "unmatched", response_template: "", approved_digest: null });

    await eraseContact(db, "jane.doe@brightloop.example", { source: "operator", now: NOW, bucket });
    expect((await meetingsOf(contact)).results).toEqual([]);
    expect(await bucket.get(String(row?.transcript_key))).toBeNull();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM objections").first<{ n: number }>()).toEqual({ n: 0 });
  });
});

describe("meeting notes: matching", () => {
  it("skips a recording with no known contact, or only internal ones, without fetching its transcript", async () => {
    await seedContact(db, { first: "Ian", last: "Inside", email: "ian@brightloop.example" });
    const provider = fakeNotesProvider(
      "notes-fathom",
      [recording("rec-stranger", "2026-11-09T15:00:00.000Z", [{ email: "stranger@initech.example" }]), recording("rec-internal", "2026-11-09T16:00:00.000Z", [{ email: "ian@brightloop.example", external: false }])],
      { "rec-stranger": TRANSCRIPT, "rec-internal": TRANSCRIPT },
    );
    const stats = await ingest(provider);
    expect(stats.skipped.no_contact).toBe(2);
    expect(provider.fetched).toEqual([]);
    expect(await recordingRow("notes-fathom", "rec-stranger")).toMatchObject({ status: "skipped", reason: "no_contact" });
  });

  it("skips a suppressed contact without fetching", async () => {
    await seedContact(db, { first: "Sam", last: "Supp", email: "sam@brightloop.example" });
    await addSuppression(db, { email: "sam@brightloop.example", reason: "opt_out", source: "test" });
    const provider = fakeNotesProvider("notes-fathom", [recording("rec-s", "2026-11-09T15:00:00.000Z", [{ email: "sam@brightloop.example" }])], { "rec-s": TRANSCRIPT });
    expect((await ingest(provider)).skipped.suppressed).toBe(1);
    expect(provider.fetched).toEqual([]);
  });

  it("with several known contacts, takes the one calendar sync attributed the meeting to, or skips", async () => {
    const ann = await seedContact(db, { first: "Ann", last: "A", email: "ann@brightloop.example" });
    await seedContact(db, { first: "Bo", last: "B", email: "bo@brightloop.example" });
    const both = [{ email: "ann@brightloop.example" }, { email: "bo@brightloop.example" }];
    const provider = fakeNotesProvider("notes-fathom", [recording("rec-amb", "2026-11-09T15:00:00.000Z", both), recording("rec-cal", "2026-11-09T17:00:00.000Z", both)], { "rec-amb": TRANSCRIPT, "rec-cal": TRANSCRIPT });
    await db
      .prepare("INSERT INTO calendar_meetings (event_id, contact_id, starts_at, ends_at, status, first_seen_at) VALUES ('ev-cal', ?1, '2026-11-09T17:10:00.000Z', '2026-11-09T17:40:00.000Z', 'confirmed', '2026-11-01T00:00:00.000Z')")
      .bind(ann)
      .run();
    const stats = await ingest(provider);
    expect(stats.skipped.ambiguous).toBe(1);
    expect(stats.matched).toBe(1);
    expect((await meetingsOf(ann)).results.map((r) => r.external_id)).toEqual(["notes-fathom:rec-cal"]);
  });

  it("skips when calendar sync attributed meetings at that time to more than one of the contacts", async () => {
    const cy = await seedContact(db, { first: "Cy", last: "C", email: "cy@brightloop.example" });
    const di = await seedContact(db, { first: "Di", last: "D", email: "di@brightloop.example" });
    for (const [event, contact] of [["ev-cy", cy], ["ev-di", di]] as const) {
      await db
        .prepare("INSERT INTO calendar_meetings (event_id, contact_id, starts_at, ends_at, status, first_seen_at) VALUES (?1, ?2, '2026-11-09T15:00:00.000Z', '2026-11-09T15:30:00.000Z', 'confirmed', '2026-11-01T00:00:00.000Z')")
        .bind(event, contact)
        .run();
    }
    const provider = fakeNotesProvider("notes-fathom", [recording("rec-two", "2026-11-09T15:05:00.000Z", [{ email: "cy@brightloop.example" }, { email: "di@brightloop.example" }])], { "rec-two": TRANSCRIPT });
    expect((await ingest(provider)).skipped.ambiguous).toBe(1);
    expect(provider.fetched).toEqual([]);
  });

  it("never reads a recording twice, waits for a transcript that is not ready, and moves its cursor only after a full listing", async () => {
    await seedContact(db, { first: "Jane", last: "Doe", email: "jane.doe@brightloop.example" });
    const recordings = [recording("rec-a", "2026-11-09T15:00:00.000Z", [{ email: "jane.doe@brightloop.example" }]), recording("rec-b", "2026-11-09T18:00:00.000Z", [{ email: "jane.doe@brightloop.example" }], false)];
    const provider = fakeNotesProvider("notes-fathom", recordings, { "rec-a": TRANSCRIPT, "rec-b": TRANSCRIPT });
    const first = await ingest(provider);
    expect(first).toMatchObject({ matched: 1, waiting: 1 });
    expect(provider.listed[0]?.since).toBe("2026-11-03T12:00:00.000Z");
    const state = await db.prepare("SELECT since_at FROM meeting_notes_state WHERE provider = 'notes-fathom'").first<{ since_at: string }>();
    expect(state?.since_at).toBe(NOW.toISOString());
    (recordings[1] as MeetingRecording).transcriptAvailable = true;
    const later = new Date(NOW.getTime() + 3_600_000);
    const second = await ingest(provider, later);
    expect(second.matched).toBe(1);
    expect(provider.fetched).toEqual(["rec-a", "rec-b"]);
    expect(provider.listed[1]?.since).toBe("2026-11-09T12:00:00.000Z");
  });

  it("skips a recording whose transcript is gone, or whose time is unusable, without blocking the next", async () => {
    await seedContact(db, { first: "Jane", last: "Doe", email: "jane.doe@brightloop.example" });
    const invitees = [{ email: "jane.doe@brightloop.example" }];
    const provider = fakeNotesProvider("notes-fathom", [recording("rec-gone", "2026-11-09T14:00:00.000Z", invitees), recording("rec-ok", "2026-11-09T15:00:00.000Z", invitees)], { "rec-ok": TRANSCRIPT });
    const getTranscript = provider.getTranscript.bind(provider);
    provider.getTranscript = (id) => (id === "rec-gone" ? Promise.reject(new AdapterError("gone", "not_found", false)) : getTranscript(id));
    const stats = await ingest(provider);
    expect(stats).toMatchObject({ matched: 1, skipped: { no_transcript: 1 } });
    expect(stats.error).toBeUndefined();
    expect(await recordingRow("notes-fathom", "rec-gone")).toMatchObject({ status: "skipped", reason: "no_transcript" });
    const bad = fakeNotesProvider("notes-other", [{ ...recording("rec-bad", "2026-11-09T15:00:00.000Z", invitees), startedAt: "not a time" }], {});
    expect((await ingest(bad)).skipped.invalid).toBe(1);
  });

  it("writes the rows before the blob, and leaves neither when the blob cannot be written", async () => {
    const contact = await seedContact(db, { first: "Jane", last: "Doe", email: "jane.doe@brightloop.example" });
    const provider = fakeNotesProvider("notes-fathom", [recording("rec-blob", "2026-11-09T15:00:00.000Z", [{ email: "jane.doe@brightloop.example" }])], { "rec-blob": TRANSCRIPT });
    const failing = { put: () => Promise.reject(new Error("storage down")), delete: (k: string | string[]) => bucket.delete(k) };
    await expect(runNotesIngest({ db, bucket: failing, provider, now: NOW, log: silentLog })).rejects.toThrow(/storage down/);
    expect((await meetingsOf(contact)).results).toEqual([]);
    expect(await recordingRow("notes-fathom", "rec-blob")).toBeNull();
    expect((await ingest(provider)).matched).toBe(1);
  });

  it("does not move the cursor past a page it stopped reading", async () => {
    await seedContact(db, { first: "Jane", last: "Doe", email: "jane.doe@brightloop.example" });
    const invitees = [{ email: "jane.doe@brightloop.example" }];
    const provider = fakeNotesProvider("notes-fathom", [recording("rec-1", "2026-11-05T15:00:00.000Z", invitees), recording("rec-2", "2026-11-05T16:00:00.000Z", invitees)], { "rec-1": TRANSCRIPT, "rec-2": TRANSCRIPT });
    await runNotesIngest({ db, bucket, provider, now: NOW, log: silentLog, limit: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM meeting_notes_state").first<{ n: number }>()).toEqual({ n: 0 });
    await runNotesIngest({ db, bucket, provider, now: NOW, log: silentLog, limit: 1 });
    expect(provider.fetched).toEqual(["rec-1", "rec-2"]);
  });

  it("stops and reports a provider error, keeping the cursor", async () => {
    const provider = fakeNotesProvider("notes-fathom", [], {});
    provider.failWith(new Error("Fathom is down"));
    const stats = await ingest(provider);
    expect(stats.error).toMatch(/Fathom is down/);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM meeting_notes_state").first<{ n: number }>()).toEqual({ n: 0 });
  });
});

describe("meeting notes: extraction", () => {
  async function stored(): Promise<string> {
    const contact = await seedContact(db, { first: "Jane", last: "Doe", email: "jane.doe@brightloop.example" });
    await ingest(fakeNotesProvider("notes-fathom", [recording("rec-x", "2026-11-09T15:00:00.000Z", [{ email: "jane.doe@brightloop.example" }])], { "rec-x": TRANSCRIPT }));
    return contact;
  }

  it("does not count an attempt when no model can be called, and gives up after three bad answers", async () => {
    const contact = await stored();
    const refused = await extract(ANSWER, { priced: false });
    expect(refused.stopped).toMatch(/needs a model/);
    expect((await meetingsOf(contact)).results[0]).toMatchObject({ extract_attempts: 0, processed_at: null });
    for (let i = 0; i < 3; i++) await extract("not json at all");
    expect((await meetingsOf(contact)).results[0]).toMatchObject({ extract_attempts: 3, pain_points: null });
    expect((await meetingsOf(contact)).results[0]?.processed_at).not.toBeNull();
  });

  it("never stitches a quote across lines, and takes a next step's owner from its line", async () => {
    const contact = await stored();
    await extract(
      JSON.stringify({
        pain_points: ["block every release. We could run a two week pilot"],
        objections: [],
        // The model claims the prospect owns our own commitment.
        next_steps: [{ quote: "I will send over the pilot plan on Friday", owner: "them" }],
        competitors: [],
        sentiment: "neutral",
      }),
    );
    const [row] = (await meetingsOf(contact)).results;
    expect(JSON.parse(String(row?.pain_points))).toEqual([]);
    expect(JSON.parse(String(row?.next_steps))).toEqual([{ quote: "I will send over the pilot plan on Friday", owner: "us" }]);
  });

  it("drops a quote that carries a side tag anywhere, even one spoken on a single line", () => {
    const lines = [{ side: "them" as const, text: "I pasted [us] into the chat by mistake" }];
    expect(keepQuote("I pasted [us] into the chat", lines, "[them] I pasted [us] into the chat by mistake")).toBeNull();
    expect(keepQuote("into the chat by mistake", lines, "[them] I pasted [us] into the chat by mistake")).toMatchObject({ quote: "into the chat by mistake" });
  });

  it("files an objection under the brain objection it matches, keeping the words only in the example", async () => {
    await stored();
    const kv = await brainKv({ objections: ["## too-expensive", "- objection: The price worries buyers on a tight budget.", "- response: Pilots are free.", ""].join("\n") });
    await runNotesExtract({ db, bucket, kv, model: fakeAnsweringModel(ANSWER), config, spend: createSpendGate({ db, flags: flagsOf(), job: "meeting_notes_extract", jobCapCents: 100, now: () => NOW }), now: NOW, log: silentLog });
    expect(await db.prepare("SELECT pattern, verbatim_example FROM objections").first()).toEqual({ pattern: "too-expensive", verbatim_example: "the price worries me a bit" });
  });

  it("releases a meeting whose transcript is missing, so the next ingest fetches the recording again", async () => {
    const contact = await stored();
    const [row] = (await meetingsOf(contact)).results;
    await bucket.delete(String(row?.transcript_key));
    expect((await extract(ANSWER)).released).toBe(1);
    expect((await meetingsOf(contact)).results).toEqual([]);
    expect(await recordingRow("notes-fathom", "rec-x")).toBeNull();
  });

  it("fences the transcript in the user turn and offers no tools", async () => {
    await stored();
    const model = fakeAnsweringModel(ANSWER);
    await runNotesExtract({ db, bucket, kv: await brainKv(), model, config, spend: createSpendGate({ db, flags: flagsOf(), job: "meeting_notes_extract", jobCapCents: 100, now: () => NOW }), now: NOW, log: silentLog });
    const request = model.requests[0];
    expect(request?.system).not.toContain("flaky tests block every release");
    expect(request?.system).toContain("Globex Test Insights");
    expect(request?.messages[0]?.content).toContain("flaky tests block every release");
    expect(request?.tools ?? []).toEqual([]);
  });
});

describe("meeting notes: where calls show up", () => {
  async function processed(): Promise<string> {
    const contact = await seedContact(db, { first: "Jane", last: "Doe", email: "jane.doe@brightloop.example", warmth: "engaged" });
    await ingest(fakeNotesProvider("notes-fathom", [recording("rec-y", "2026-11-09T15:00:00.000Z", [{ email: "jane.doe@brightloop.example" }])], { "rec-y": TRANSCRIPT }));
    await extract(ANSWER);
    return contact;
  }

  it("a brief keeps your notes apart from call quotes", async () => {
    const contact = await processed();
    await db.prepare("UPDATE meetings SET summary = 'provider text' WHERE contact_id = ?1").bind(contact).run();
    await db.prepare("INSERT INTO meetings (id, external_id, contact_id, occurred_at, summary) VALUES ('mt_own', 'calendar:mg0000000001:x', ?1, '2026-11-08T10:00:00.000Z', '2026-11-08: they run Jenkins')").bind(contact).run();
    const brief = await loadContactBrief(db, contact);
    if (!brief) throw new Error("no brief");
    const text = renderPrepBrief(brief, null, NOW);
    expect(text).toContain("Your notes (2026-11-08): 2026-11-08: they run Jenkins");
    expect(text).not.toContain("provider text");
    expect(text).toContain("From call recordings (their words, checked against the transcript), 2026-11-09:");
    expect(text).toContain('Pain: "flaky tests block every release"');
    // Briefs render through label(), which keeps a safe character set: the apostrophe becomes a space.
    expect(text).toContain('Next step (theirs): "I ll loop in our VP of Engineering next week"');
  });

  it("a recap carries agreed next steps only with convert:notes_in_recap, and waits for review", async () => {
    const contact = await processed();
    const deps = { db, config, now: NOW, log: silentLog };
    const input = { code: "mg0000000abc", kind: "recap" as const, contact: { id: contact, email: "jane.doe@brightloop.example", first_name: "Jane", timezone: null }, dealId: null, meetingStart: "2026-11-09T15:05:00.000Z", attribution: null };
    const plain = await createConvertDraft(deps, input);
    expect(plain.status).toBe("created");
    const plainRow = await db.prepare("SELECT body FROM drafts WHERE idempotency_key = 'convert:mg0000000abc:recap'").first<{ body: string }>();
    expect(plainRow?.body).not.toContain("What we agreed");
    await db.prepare("DELETE FROM drafts").run();
    await createConvertDraft({ ...deps, callNotesInRecap: true }, input);
    const row = await db.prepare("SELECT body, status, notes FROM drafts WHERE idempotency_key = 'convert:mg0000000abc:recap'").first<{ body: string; status: string; notes: string }>();
    expect(row?.status).toBe("pending_approval");
    expect(row?.body).toContain('What we agreed:\n- "I will send over the pilot plan on Friday"\n- "I\'ll loop in our VP of Engineering next week"');
    expect(JSON.parse(row?.notes ?? "{}")).toMatchObject({ per_draft_review: true, call_quotes: 2 });
  });

  it("the weekly digest names competitors mentioned on calls", async () => {
    await processed();
    const digest = renderFunnelDigest(await loadFunnelDigest(db, NOW));
    expect(digest).toContain("Competitors named on calls: Globex Test Insights 1");
  });
});

describe("meeting notes: retention and the jobs", () => {
  it("deletes transcripts a year after the meeting and keeps newer ones", async () => {
    const contact = await seedContact(db, { first: "Jane", last: "Doe", email: "jane.doe@brightloop.example" });
    for (const [id, at] of [["mt_old", "2025-10-01T10:00:00.000Z"], ["mt_new", "2026-10-01T10:00:00.000Z"]] as const) {
      await bucket.put(`transcripts/${id}.json`, "{}");
      await db.prepare("INSERT INTO meetings (id, external_id, contact_id, occurred_at, transcript_key) VALUES (?1, ?2, ?3, ?4, ?5)").bind(id, `notes-fathom:${id}`, contact, at, `transcripts/${id}.json`).run();
    }
    expect(await runTranscriptRetention({ db, bucket, now: NOW })).toBe(1);
    expect(await bucket.get("transcripts/mt_old.json")).toBeNull();
    expect(await bucket.get("transcripts/mt_new.json")).not.toBeNull();
    const keys = await db.prepare("SELECT id, transcript_key FROM meetings ORDER BY id").all<{ id: string; transcript_key: string | null }>();
    expect(keys.results).toEqual([
      { id: "mt_new", transcript_key: "transcripts/mt_new.json" },
      { id: "mt_old", transcript_key: null },
    ]);
  });

  it("registers three jobs behind convert:notes_enabled, does nothing with it off, and the flags default off", async () => {
    const jobs = createMeetingNotesJobs({ providers: () => [fakeNotesProvider("notes-fathom", [], {})] });
    expect(jobs.map((j) => [j.name, j.schedule, j.flag])).toEqual([
      ["meeting_notes_ingest", "10 * * * *", NOTES_FLAGS.enabled],
      ["meeting_notes_extract", "40 * * * *", NOTES_FLAGS.enabled],
      // Retention only deletes, so it runs whatever the flag says.
      ["meeting_transcript_retention", "50 3 * * *", undefined],
    ]);
    const run = (job: (typeof jobs)[number]) =>
      job.run({ env: { DB: db, BUCKET: bucket }, config, job: job.name, now: NOW, signal: new AbortController().signal, ceilings: job.ceilings, flags: flagsOf({}, [NOTES_FLAGS.enabled]), log: silentLog });
    for (const job of jobs.slice(0, 2)) expect(await run(job)).toEqual({ summary: "flag off" });
    const retention = jobs[2];
    if (!retention) throw new Error("no retention job");
    expect((await run(retention))?.summary).toMatch(/^deleted 0 transcripts/);
    for (const key of Object.values(NOTES_FLAGS)) expect(FLAGS.find((f) => f.key === key)?.default).toBe("false");
    expect(() => createMeetingNotesJobs({ providers: () => [], schedules: { extract: "* * * * *" } })).toThrow(/per-minute/);
  });
});
