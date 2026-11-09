// GTM-agents: curating the objection library: the operator writes and approves answers to real
// objections, and the next inbound message scores each answer that was used. No model call.
//
// Reply triage files real objections into the objections table unanswered (replies/objections.ts).
// Here:
//   - unansweredObjections lists them for the operator;
//   - proposeObjectionAnswer stores the operator's answer as a proposal showing the objection and
//     the exact answer; approving it (apply.ts) writes the answer with approved_digest =
//     objectionAnswerDigest(pattern, response), so editing either later voids the approval. Reply
//     drafting already uses at most the two best approved answers by success rate;
//   - scoreObjectionAnswers runs daily: for each sent reply that used a stored answer, the contact's
//     next inbound message within SCORE_WINDOW_DAYS scores it (an attempt, and a success when its
//     intent is positive by the one definition in packages/core/src/metrics/); no inbound within the
//     window is an attempt without a success. Each answer is scored once per contact, claimed in the
//     effects ledger, so one talkative contact cannot inflate an answer.
import { claimEffect, hasEffect } from "../events/effects.ts";
import { answerOutcome, DAY_MS } from "../metrics/index.ts";
import { createLearningProposal, type CreateResult } from "./proposals.ts";

export const SCORE_WINDOW_DAYS = 30;
/** How long a triage may take before an untriaged reply counts as not positive. */
const TRIAGE_GRACE_DAYS = 3;
export const OBJECTION_SCORE_EFFECT = "learning_objection_score";

export interface UnansweredObjection {
  id: string;
  pattern: string;
  competitor: string | null;
  dealStage: string | null;
  createdAt: string;
}

/** Filed objections with no approved answer, newest first. Throws on a database error. */
export async function unansweredObjections(db: D1Database, limit = 20): Promise<UnansweredObjection[]> {
  const { results } = await db
    .prepare(
      `SELECT id, pattern, competitor, deal_stage, created_at FROM objections
        WHERE approved_digest IS NULL OR trim(response_template) = '' ORDER BY created_at DESC LIMIT ?1`,
    )
    .bind(Math.max(1, Math.min(50, limit)))
    .all<{ id: string; pattern: string; competitor: string | null; deal_stage: string | null; created_at: string }>();
  return results.map((r) => ({ id: r.id, pattern: r.pattern, competitor: r.competitor, dealStage: r.deal_stage, createdAt: r.created_at }));
}

/** Store the operator's answer as a proposal. Nothing changes until it is approved. Throws on a database error. */
export async function proposeObjectionAnswer(db: D1Database, input: { objectionId: string; response: string; actor: string; now: Date }): Promise<CreateResult | { ok: false; problems: string[] }> {
  const row = await db.prepare("SELECT id, pattern FROM objections WHERE id = ?1 OR (length(?1) >= 6 AND id LIKE ?1 || '%') LIMIT 2").bind(input.objectionId.trim()).all<{ id: string; pattern: string }>();
  if (row.results.length !== 1) return { ok: false, problems: [row.results.length ? "that prefix matches more than one objection" : "no such objection"] };
  const objection = row.results[0] as { id: string; pattern: string };
  return createLearningProposal(
    db,
    { kind: "objection_answer", payload: { objectionId: objection.id, pattern: objection.pattern, response: input.response.trim() }, proposedBy: input.actor },
    input.now,
  );
}

export interface ScoreResult {
  scored: number;
  successes: number;
  waiting: number;
}

/** Score answers used in sent replies. Throws on a database error. */
export async function scoreObjectionAnswers(db: D1Database, now: Date, maxRows = 200): Promise<ScoreResult> {
  const since = new Date(now.getTime() - (SCORE_WINDOW_DAYS + 30) * DAY_MS).toISOString();
  const { results } = await db
    .prepare(
      `SELECT id, contact_id, sent_at, notes FROM drafts
        WHERE kind = 'reply' AND status = 'sent' AND contact_id IS NOT NULL AND sent_at IS NOT NULL AND sent_at >= ?1 AND notes LIKE '%db:%'
        ORDER BY sent_at ASC LIMIT ?2`,
    )
    .bind(since, Math.max(1, maxRows))
    .all<{ id: string; contact_id: string; sent_at: string; notes: string | null }>();
  const out: ScoreResult = { scored: 0, successes: 0, waiting: 0 };
  for (const draft of results) {
    let answers: string[];
    try {
      const parsed = JSON.parse(draft.notes ?? "{}") as { answers?: unknown };
      answers = Array.isArray(parsed.answers) ? parsed.answers.filter((a): a is string => typeof a === "string" && a.startsWith("db:")).map((a) => a.slice(3)) : [];
    } catch {
      answers = [];
    }
    if (answers.length === 0) continue;
    const deadline = new Date(new Date(draft.sent_at).getTime() + SCORE_WINDOW_DAYS * DAY_MS).toISOString();
    const outcome = await answerOutcome(db, { contactId: draft.contact_id, sentAt: draft.sent_at, deadline, now, graceMs: TRIAGE_GRACE_DAYS * DAY_MS });
    if (outcome.state === "waiting") {
      out.waiting++;
      continue;
    }
    const success = outcome.state === "positive";
    for (const objectionId of answers) {
      const key = `${objectionId}:${draft.contact_id}`;
      if (await hasEffect(db, key, OBJECTION_SCORE_EFFECT)) continue;
      if (!(await claimEffect(db, key, OBJECTION_SCORE_EFFECT))) continue;
      await db
        .prepare("UPDATE objections SET attempt_count = attempt_count + 1, success_count = success_count + ?2, last_used_at = ?3, updated_at = ?4 WHERE id = ?1")
        .bind(objectionId, success ? 1 : 0, draft.sent_at, now.toISOString())
        .run();
      out.scored++;
      if (success) out.successes++;
    }
  }
  return out;
}
