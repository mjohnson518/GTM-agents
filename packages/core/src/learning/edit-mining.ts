// GTM-agents: edit mining: what the operator changes in drafts before sending them, turned into
// proposed writing rules. Weekly, no model call.
//
// recordDraftEdit keeps each draft the operator changed (what the system wrote, and what was sent
// with quoted history and the signature stripped). mineDraftEdits diffs each pair sentence by
// sentence over the last MINING_WINDOW_DAYS and counts patterns:
//   - shortening (the sent text has at most 80% of the words, from drafts of 20 words or more);
//   - removed links, removed questions, a removed opening or closing sentence;
//   - the same sentence removed, or the same sentence added, in more than one draft.
// A pattern seen in MIN_DRAFTS (2) or more drafts, with at least one draft not mined before,
// becomes a proposed rule for the learnings section writing_rules, at most MAX_RULES_PER_WEEK (3)
// in any 7 days, and never the same pattern twice in a window. Examples are kept as data only:
// defanged (links broken, addresses and the contact's first name replaced) and capped. Nothing is
// applied; a person approves each rule.
import { stripQuotedReply, stripSignature, normalizeForComparison } from "../replies/text.ts";
import { DAY_MS } from "../metrics/window.ts";
import { createLearningProposal, proposalsSince } from "./proposals.ts";
import { defang, foldSentence, hasLink, splitSentences, wordsIn } from "./text.ts";

export const MINING_WINDOW_DAYS = 28;
export const MIN_DRAFTS = 2;
export const MAX_RULES_PER_WEEK = 3;
export const EDIT_MINING_SOURCE = "edit_mining";
const MAX_EDIT_CHARS = 8000;

export interface DraftEditInput {
  draftId: string;
  /** The contact the reply went to. Without one nothing is kept, so erasure always reaches it. */
  contactId: string | null;
  kind: string;
  actionClass: string | null;
  generatedBody: string;
  /** What went out, as the mailbox returned it. Quoted history and the signature are stripped here. */
  sentText: string;
  now: Date;
}

/** Keep a draft the operator changed. Bookkeeping: never throws; true when a row was written. */
export async function recordDraftEdit(db: D1Database, input: DraftEditInput): Promise<boolean> {
  // An edit with no contact could not be erased with the person, so it is not kept.
  if (!input.contactId) return false;
  try {
    const sent = stripSignature(stripQuotedReply(input.sentText)).trim().slice(0, MAX_EDIT_CHARS);
    const generated = stripSignature(input.generatedBody).trim().slice(0, MAX_EDIT_CHARS);
    if (!sent || !generated || normalizeForComparison(sent) === normalizeForComparison(generated)) return false;
    const r = await db
      .prepare(
        `INSERT OR IGNORE INTO draft_edits (id, draft_id, contact_id, kind, action_class, generated_body, sent_body, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(`de_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, input.draftId, input.contactId, input.kind.slice(0, 32), input.actionClass, generated, sent, input.now.toISOString())
      .run();
    return (r.meta.changes ?? 0) === 1;
  } catch {
    return false;
  }
}

export interface EditDiff {
  removed: string[];
  added: string[];
  shortened: boolean;
  wordsBefore: number;
  wordsAfter: number;
  removedLink: boolean;
  removedQuestion: boolean;
  removedOpening: boolean;
  removedClosing: boolean;
}

/** The sentence-level difference between a draft and what was sent. Pure. */
export function diffEdit(generated: string, sent: string): EditDiff {
  const g = splitSentences(generated);
  const s = splitSentences(sent);
  const gFold = g.map(foldSentence);
  const sFold = new Set(s.map(foldSentence));
  const gSet = new Set(gFold);
  const removed = g.filter((_, i) => !sFold.has(gFold[i] ?? ""));
  const added = s.filter((x) => !gSet.has(foldSentence(x)));
  const wordsBefore = wordsIn(generated);
  const wordsAfter = wordsIn(sent);
  const questions = (t: string) => (t.match(/\?/g) ?? []).length;
  return {
    removed,
    added,
    shortened: wordsBefore >= 20 && wordsAfter <= wordsBefore * 0.8,
    wordsBefore,
    wordsAfter,
    removedLink: hasLink(generated) && !hasLink(sent),
    removedQuestion: questions(sent) < questions(generated),
    removedOpening: g.length > 1 && !sFold.has(gFold[0] ?? ""),
    removedClosing: g.length > 1 && !sFold.has(gFold[gFold.length - 1] ?? ""),
  };
}

export interface EditPattern {
  key: string;
  rule: string;
  drafts: number;
  /** Drafts in this pattern not mined in an earlier run. */
  fresh: number;
  examples: string[];
}

interface Edit {
  draftId: string;
  fresh: boolean;
  firstName: string | null;
  diff: EditDiff;
}

const quoteOf = (sentence: string, firstName: string | null) => {
  let text = sentence;
  if (firstName && firstName.length >= 2) text = text.split(firstName).join("{first_name}");
  return defang(text, 160).replace(/"/g, "'");
};

/** Patterns across a set of edits, seen in at least MIN_DRAFTS drafts, most common first. Pure. */
export function editPatterns(edits: readonly Edit[]): EditPattern[] {
  const buckets = new Map<string, { rule: (n: number) => string; ids: Set<string>; fresh: Set<string>; examples: string[] }>();
  const add = (key: string, rule: (n: number) => string, edit: Edit, example: string | null) => {
    const b = buckets.get(key) ?? { rule, ids: new Set<string>(), fresh: new Set<string>(), examples: [] };
    b.ids.add(edit.draftId);
    if (edit.fresh) b.fresh.add(edit.draftId);
    if (example && b.examples.length < 2) b.examples.push(example);
    buckets.set(key, b);
  };
  for (const e of edits) {
    const d = e.diff;
    if (d.shortened) add("shortens", (n) => `Keep drafts shorter: the operator cut them by a fifth or more in ${n} edited drafts.`, e, `${d.wordsBefore} words cut to ${d.wordsAfter}`);
    if (d.removedLink) add("removes_links", (n) => `Leave links out unless the reader asked for one: the operator removed links in ${n} edited drafts.`, e, null);
    if (d.removedQuestion) add("removes_questions", (n) => `Ask at most one question: the operator removed questions in ${n} edited drafts.`, e, null);
    if (d.removedOpening) add("removes_opening", (n) => `Start with the point: the operator removed the opening sentence in ${n} edited drafts.`, e, d.removed[0] ? `removed: "${quoteOf(d.removed[0], e.firstName)}"` : null);
    if (d.removedClosing) add("removes_closing", (n) => `End on the ask: the operator removed the closing sentence in ${n} edited drafts.`, e, d.removed.at(-1) ? `removed: "${quoteOf(d.removed.at(-1) ?? "", e.firstName)}"` : null);
    for (const sentence of d.removed) {
      const fold = foldSentence(sentence);
      if (fold.split(" ").length < 3) continue;
      const quoted = quoteOf(sentence, e.firstName);
      add(`removes_sentence:${fold.slice(0, 120)}`, (n) => `Do not write "${quoted}": the operator removed it in ${n} edited drafts.`, e, null);
    }
    for (const sentence of d.added) {
      const fold = foldSentence(sentence);
      if (fold.split(" ").length < 3) continue;
      const quoted = quoteOf(sentence, e.firstName);
      add(`adds_sentence:${fold.slice(0, 120)}`, (n) => `Consider writing "${quoted}": the operator added it in ${n} edited drafts.`, e, null);
    }
  }
  return [...buckets.entries()]
    .filter(([, b]) => b.ids.size >= MIN_DRAFTS)
    .map(([key, b]) => ({ key, rule: b.rule(b.ids.size), drafts: b.ids.size, fresh: b.fresh.size, examples: b.examples }))
    .sort((a, b) => b.drafts - a.drafts || (a.key < b.key ? -1 : 1));
}

export interface MiningDeps {
  db: D1Database;
  now: Date;
  /** Edits read per run. */
  maxRows: number;
  runId?: string;
}

export interface MiningResult {
  edits: number;
  patterns: number;
  proposed: string[];
  skipped: string[];
}

/** One weekly mining run. Throws on a database error. */
export async function mineDraftEdits(deps: MiningDeps): Promise<MiningResult> {
  const since = new Date(deps.now.getTime() - MINING_WINDOW_DAYS * DAY_MS).toISOString();
  const { results } = await deps.db
    .prepare(
      `SELECT de.id, de.draft_id, de.generated_body, de.sent_body, de.mined_at, c.first_name
         FROM draft_edits de LEFT JOIN contacts c ON c.id = de.contact_id
        WHERE de.created_at >= ?1 ORDER BY de.created_at DESC LIMIT ?2`,
    )
    .bind(since, Math.max(1, deps.maxRows))
    .all<{ id: string; draft_id: string; generated_body: string; sent_body: string; mined_at: string | null; first_name: string | null }>();
  const edits: Edit[] = results.map((r) => ({ draftId: r.draft_id, fresh: r.mined_at === null, firstName: r.first_name, diff: diffEdit(r.generated_body, r.sent_body) }));
  const patterns = editPatterns(edits).filter((p) => p.fresh > 0);
  const proposed: string[] = [];
  const skipped: string[] = [];
  const recentKeys = new Set(
    (
      await deps.db
        .prepare("SELECT json_extract(payload, '$.pattern') AS pattern FROM learnings_proposals WHERE proposed_by = ?1 AND created_at >= ?2")
        .bind(EDIT_MINING_SOURCE, since)
        .all<{ pattern: string | null }>()
    ).results
      .map((r) => r.pattern)
      .filter((k): k is string => typeof k === "string"),
  );
  let room = MAX_RULES_PER_WEEK - (await proposalsSince(deps.db, EDIT_MINING_SOURCE, new Date(deps.now.getTime() - 7 * DAY_MS)));
  for (const pattern of patterns) {
    if (room <= 0) {
      skipped.push(`${pattern.key}: the weekly limit of ${MAX_RULES_PER_WEEK} is reached`);
      continue;
    }
    if (recentKeys.has(pattern.key)) continue;
    const created = await createLearningProposal(
      deps.db,
      {
        kind: "learning",
        payload: { section: "writing_rules", text: pattern.rule, examples: pattern.examples, pattern: pattern.key },
        rationale: `Seen in ${pattern.drafts} drafts you edited in the last ${MINING_WINDOW_DAYS} days.`,
        proposedBy: EDIT_MINING_SOURCE,
        sourceRunId: deps.runId ?? null,
      },
      deps.now,
    );
    if (created.ok) {
      if (created.created) {
        proposed.push(created.proposal.shortId);
        room--;
      }
    } else skipped.push(`${pattern.key}: ${created.problems.join("; ")}`);
  }
  await deps.db.prepare("UPDATE draft_edits SET mined_at = ?1 WHERE mined_at IS NULL AND created_at >= ?2").bind(deps.now.toISOString(), since).run();
  return { edits: edits.length, patterns: patterns.length, proposed, skipped };
}
