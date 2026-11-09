// GTM-agents: the voice profile: how the operator writes, built only from threads the operator
// picks, and proposed as an edit to the brain's voice component. No model call.
//
// buildVoiceProposal reads the picked threads from the mailbox, keeps only messages the mailbox sent
// (never drafts, never what anyone else wrote), strips quoted history and the signature, and
// measures length, sentence length, questions, greetings, contractions, exclamation marks and the
// sign-off. The profile is rendered as the voice component, one version above the served one, and
// proposed with the exact diff; applying it re-locks the brain (apply.ts). Each rebuild is a new
// version, so the brain's history is the profile's history.
//
// The weekly drift check (voiceDrift) reads reply decisions from autonomy evidence: when the
// operator edited DRIFT_EDIT_RATE (40%) or more of the last DRIFT_MIN_DECISIONS (10) or more, it
// suggests a rebuild. It changes nothing.
import { sha256Hex } from "../brain/lock.ts";
import type { InboxProvider } from "../ports/email.ts";
import { stripQuotedReply, stripSignature } from "../replies/text.ts";
import { DAY_MS } from "../metrics/window.ts";
import { fileMeta, readServedBrain, renderBrainFile, type BrainItemInput, type BrainKv } from "./brain-edit.ts";
import { createLearningProposal, type CreateResult } from "./proposals.ts";
import { splitSentences, wordsIn } from "./text.ts";

export const VOICE_MIN_MESSAGES = 3;
export const VOICE_MAX_THREADS = 20;
export const VOICE_MAX_MESSAGES = 50;
export const DRIFT_EDIT_RATE = 0.4;
export const DRIFT_MIN_DECISIONS = 10;
export const VOICE_SOURCE = "voice";

const CLOSING = /^(best|best regards|kind regards|regards|warm regards|warmly|thanks|thank you|many thanks|cheers|all the best)[,.!]?$/i;
const GREETING = /^(hi|hey|hello|dear)\b/i;
const CONTRACTION = /\b\w+(?:'s|'re|'ll|'ve|n't|'m|'d)\b/gi;

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
};

/** The sign-off a message closes with ("Thanks", "Best"), read before the signature is stripped. */
export function closingOf(text: string): string | null {
  const lines = stripQuotedReply(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i--) {
    const line = lines[i] ?? "";
    if (CLOSING.test(line)) return line.replace(/[,.!]$/, "");
  }
  return null;
}

export interface VoiceStats {
  messages: number;
  medianWords: number;
  medianSentenceWords: number;
  questionShare: number;
  greetingShare: number;
  greeting: string | null;
  contractionsPer100: number;
  exclamationShare: number;
  closing: string | null;
}

/** Style measurements over the operator's own sent messages. Pure. */
export function voiceStats(raw: readonly string[]): VoiceStats {
  const bodies = raw.map((t) => stripSignature(stripQuotedReply(t)).trim()).filter((t) => t.length > 0);
  const share = (pred: (t: string) => boolean) => (bodies.length ? bodies.filter(pred).length / bodies.length : 0);
  const greetings = new Map<string, number>();
  for (const b of bodies) {
    const first = (b.split(/\r?\n/)[0] ?? "").trim();
    const m = GREETING.exec(first);
    if (m) {
      const word = (m[1] ?? "hi").toLowerCase().replace(/^./, (c) => c.toUpperCase());
      greetings.set(word, (greetings.get(word) ?? 0) + 1);
    }
  }
  const closings = new Map<string, number>();
  for (const t of raw) {
    const c = closingOf(t);
    if (c) closings.set(c, (closings.get(c) ?? 0) + 1);
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;
  const words = bodies.reduce((n, b) => n + wordsIn(b), 0);
  const contractions = bodies.reduce((n, b) => n + (b.match(CONTRACTION) ?? []).length, 0);
  return {
    messages: bodies.length,
    medianWords: median(bodies.map(wordsIn)),
    medianSentenceWords: median(bodies.flatMap((b) => splitSentences(b).map(wordsIn))),
    questionShare: share((b) => b.includes("?")),
    greetingShare: share((b) => GREETING.test((b.split(/\r?\n/)[0] ?? "").trim())),
    greeting: top(greetings),
    contractionsPer100: words ? (contractions / words) * 100 : 0,
    exclamationShare: share((b) => b.includes("!")),
    closing: raw.length && closings.size && [...closings.values()].reduce((a, b) => a + b, 0) >= raw.length / 2 ? top(closings) : null,
  };
}

/** The voice component's items for a set of measurements. Pure. */
export function voiceItems(s: VoiceStats): BrainItemInput[] {
  const items: BrainItemInput[] = [
    { id: "length", fields: { kind: "do", text: `Keep a message to about ${s.medianWords} words, the length of a typical sent message.` } },
    { id: "sentences", fields: { kind: "do", text: `Write sentences of about ${Math.max(4, s.medianSentenceWords)} words.` } },
    s.questionShare >= 0.5
      ? { id: "questions", fields: { kind: "do", text: "End with one question the reader can answer quickly." } }
      : { id: "questions", fields: { kind: "dont", text: "Do not end every message with a question; most sent messages make the point and stop." } },
    s.greetingShare >= 0.5 && s.greeting
      ? { id: "greeting", fields: { kind: "phrase", text: `Open with "${s.greeting} {first_name}," on its own line.` } }
      : { id: "greeting", fields: { kind: "do", text: "Open with the point, without a greeting line." } },
    s.contractionsPer100 >= 1
      ? { id: "contractions", fields: { kind: "do", text: "Use contractions such as it's and we're." } }
      : { id: "contractions", fields: { kind: "dont", text: "Spell words out instead of using contractions." } },
  ];
  if (s.exclamationShare < 0.2) items.push({ id: "exclamations", fields: { kind: "dont", text: "Do not use exclamation marks." } });
  items.push({ id: "signoff", fields: { kind: "signoff", text: s.closing ? `Close with "${s.closing}," and the first name only.` : "Sign with the first name only." } });
  return items;
}

/** The operator's sent messages in the picked threads: sent by the mailbox, never drafts. Throws on a mailbox error. */
export async function sentMessagesIn(inbox: InboxProvider, threadIds: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const threadId of threadIds.slice(0, VOICE_MAX_THREADS)) {
    const thread = await inbox.getThread(threadId);
    for (const m of thread) {
      if (m.isFromUs && m.isDraft === false && typeof m.text === "string" && m.text.trim()) out.push(m.text);
      if (out.length >= VOICE_MAX_MESSAGES) return out;
    }
  }
  return out;
}

export interface VoiceBuildDeps {
  db: D1Database;
  kv: BrainKv | undefined;
  inbox: InboxProvider | undefined;
  now: Date;
  /** Who asked for the rebuild: operator:<user id>. */
  actor: string;
}

export type VoiceBuildResult = CreateResult | { ok: false; problems: string[] };

/** Build the profile from the picked threads and propose it. Nothing is applied. */
export async function buildVoiceProposal(deps: VoiceBuildDeps, threadIds: readonly string[]): Promise<VoiceBuildResult> {
  if (!deps.inbox) return { ok: false, problems: ["no mailbox is connected, so your sent messages cannot be read"] };
  if (deps.inbox.capabilities?.threads === false) return { ok: false, problems: ["this mailbox cannot read threads"] };
  if (!deps.kv) return { ok: false, problems: ["the brain's KV namespace is not bound"] };
  if (threadIds.length === 0) return { ok: false, problems: ["name at least one thread"] };
  let messages: string[];
  try {
    messages = await sentMessagesIn(deps.inbox, threadIds);
  } catch {
    return { ok: false, problems: ["the mailbox could not read those threads"] };
  }
  const stats = voiceStats(messages);
  if (stats.messages < VOICE_MIN_MESSAGES) return { ok: false, problems: [`those threads hold ${stats.messages} sent messages of yours; at least ${VOICE_MIN_MESSAGES} are needed`] };
  const served = await readServedBrain(deps.kv);
  const current = served.files.get("voice.md") ?? null;
  const meta = fileMeta(current, "voice");
  const content = renderBrainFile({ component: "voice", version: meta.version + 1, updated: deps.now.toISOString().slice(0, 10), owner: meta.owner, items: voiceItems(stats) });
  return createLearningProposal(
    deps.db,
    {
      kind: "voice",
      payload: { component: "voice", baseSha256: current === null ? null : await sha256Hex(current), content, previousContent: current, sources: stats.messages },
      rationale: `Rebuilt from ${threadIds.length} thread(s) you picked.`,
      proposedBy: deps.actor.startsWith("operator:") ? deps.actor : VOICE_SOURCE,
    },
    deps.now,
  );
}

export interface DriftReading {
  decisions: number;
  edited: number;
  rate: number | null;
  suggest: boolean;
}

/** The edit rate over the last decisions on reply drafts (the writer that reads the voice). Throws on a database error. */
export async function voiceDrift(db: D1Database, now: Date, windowDays = 30): Promise<DriftReading> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS decisions, SUM(CASE WHEN outcome = 'approved_edited' THEN 1 ELSE 0 END) AS edited FROM autonomy_events
        WHERE action_class IN ('reply_send', 'reply_demo_link', 'reply_question') AND outcome IN ('approved_unchanged', 'approved_edited') AND created_at >= ?1`,
    )
    .bind(new Date(now.getTime() - windowDays * DAY_MS).toISOString())
    .first<{ decisions: number | null; edited: number | null }>();
  const decisions = Number(row?.decisions ?? 0);
  const edited = Number(row?.edited ?? 0);
  const rate = decisions > 0 ? edited / decisions : null;
  return { decisions, edited, rate, suggest: decisions >= DRIFT_MIN_DECISIONS && rate !== null && rate >= DRIFT_EDIT_RATE };
}
