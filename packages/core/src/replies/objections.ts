// GTM-agents: objections in reply handling: matching a sender's concern to approved answers, and
// filing real objections for curation.
//
// Two sources of approved answers, both written by people:
//   - the brain's `objections` component (objection and response), served in the `replies` slice;
//   - rows in the objections table whose approved_digest matches objectionAnswerDigest of their
//     current pattern and response. An edit to either invalidates the approval, as with drafts.
// Matching is deterministic word overlap with the sender's text; the sender's words are only
// compared, never copied into a prompt. A drafted reply may use at most two matched answers, the
// best by success rate.
//
// An objection triage finds is filed into the objections table unapproved (approved_digest NULL,
// an empty response) for a person to curate, keyed by the inbound message. Its example is the
// sender's own sentence, so an AFTER DELETE trigger on inbound_emails (migration 0018) clears it
// when the message is erased.
import { canonicalJson } from "../security/approval-digest.ts";
import { sha256Hex } from "../shared/hash.ts";

export interface BrainObjection {
  id: string;
  objection: string;
  response: string;
}

export interface ApprovedAnswer {
  /** "brain:<item id>" or "db:<row id>". */
  id: string;
  response: string;
}

/** The digest a person's approval of a stored objection answer binds to. */
export function objectionAnswerDigest(answer: { pattern: string; response: string }): Promise<string> {
  return sha256Hex(canonicalJson({ kind: "objection_answer", v: 1, pattern: answer.pattern, response: answer.response }));
}

const field = (line: string, key: string, keys: readonly string[]): string | null => {
  const start = line.indexOf(`${key}: `);
  if (start < 0) return null;
  const from = start + key.length + 2;
  let end = line.length;
  for (const other of keys) {
    if (other === key) continue;
    const at = line.indexOf(`; ${other}: `, from);
    if (at >= 0 && at < end) end = at;
  }
  return line.slice(from, end).trim();
};

/** The objection items in a rendered brain slice (the `### objections` block). */
export function brainObjections(sliceText: string): BrainObjection[] {
  const out: BrainObjection[] = [];
  let inBlock = false;
  for (const line of sliceText.split("\n")) {
    const heading = /^### ([a-z-]+) \(v\d+\)$/.exec(line);
    if (heading) {
      inBlock = heading[1] === "objections";
      continue;
    }
    if (!inBlock || !line.startsWith("- ")) continue;
    const item = /^- ([a-z0-9-]+): (.*)$/.exec(line);
    if (!item) continue;
    const rest = item[2] ?? "";
    const keys = ["objection", "response", "personas"];
    const objection = field(rest, "objection", keys);
    const response = field(rest, "response", keys);
    if (objection && response) out.push({ id: item[1] ?? "", objection, response });
  }
  return out;
}

const STOP = new Set(
  "about after again also because been before being could does doing from have having here into just like more most much only other over same some such than that their them then there these they this those through very what when where which while will with would your yours ours".split(" "),
);

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOP.has(w)),
  );
}

/** How many significant words two texts share. */
export function overlap(a: string, b: string): number {
  const words = significantWords(b);
  let n = 0;
  for (const w of significantWords(a)) if (words.has(w)) n += 1;
  return n;
}

/** Brain objections whose objection shares at least two significant words with the sender's text, best first. */
export function matchBrainObjections(sender: string, items: readonly BrainObjection[], limit = 2): BrainObjection[] {
  return items
    .map((item) => ({ item, score: overlap(sender, item.objection) }))
    .filter((m) => m.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((m) => m.item);
}

interface StoredObjection {
  id: string;
  pattern: string;
  response_template: string;
  approved_digest: string | null;
  success_count: number;
  attempt_count: number;
}

/**
 * Approved stored answers that fit the sender's text: approved (digest verified), with a pattern
 * that names a matched brain objection or shares at least two significant words with the text.
 * At most `limit`, by success rate. Empty on a database error.
 */
export async function matchStoredAnswers(db: D1Database, sender: string, brainMatches: readonly BrainObjection[], limit = 2): Promise<ApprovedAnswer[]> {
  let rows: StoredObjection[];
  try {
    ({ results: rows } = await db
      .prepare(
        `SELECT id, pattern, response_template, approved_digest, success_count, attempt_count FROM objections
          WHERE approved_digest IS NOT NULL AND trim(response_template) <> '' ORDER BY updated_at DESC LIMIT 100`,
      )
      .all<StoredObjection>());
  } catch {
    return [];
  }
  const matchedIds = new Set(brainMatches.map((m) => m.id));
  const fits: Array<{ row: StoredObjection; rate: number }> = [];
  for (const row of rows) {
    if (row.approved_digest !== (await objectionAnswerDigest({ pattern: row.pattern, response: row.response_template }))) continue;
    if (!matchedIds.has(row.pattern) && overlap(sender, row.pattern.replace(/[-_]/g, " ")) < 2) continue;
    const rate = row.attempt_count > 0 ? row.success_count / row.attempt_count : 0.5;
    fits.push({ row, rate });
  }
  return fits
    .sort((a, b) => b.rate - a.rate || b.row.attempt_count - a.row.attempt_count)
    .slice(0, limit)
    .map(({ row }) => ({ id: `db:${row.id}`, response: row.response_template.trim().slice(0, 600) }));
}

/** True when the contact raised an objection in an earlier message: one answer per contact. */
export async function hadEarlierObjection(db: D1Database, contactId: string, inbound: { id: string; received_at: string }): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM inbound_emails
        WHERE contact_id = ?1 AND id <> ?2 AND intent = 'objection' AND (received_at < ?3 OR (received_at = ?3 AND id < ?2)) LIMIT 1`,
    )
    .bind(contactId, inbound.id, inbound.received_at)
    .first<{ hit: number }>();
  return row !== null;
}

/** File an objection for curation: unapproved, with an empty response. Throws on a database error. */
export async function fileObjection(db: D1Database, input: { inboundId: string; pattern: string; example: string | null; now: Date }): Promise<void> {
  const at = input.now.toISOString();
  await db
    .prepare(
      `INSERT INTO objections (id, pattern, verbatim_example, response_template, author, created_at, updated_at)
       SELECT ?1, ?2, ?3, '', ?4, ?5, ?5 WHERE NOT EXISTS (SELECT 1 FROM objections WHERE author = ?4)`,
    )
    .bind(`obj_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`, input.pattern.slice(0, 80), input.example ? input.example.slice(0, 300) : null, `inbound:${input.inboundId}`, at)
    .run();
}
