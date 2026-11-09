// GTM-agents: the one proposal record every self-improvement loop writes (learnings_proposals).
//
// A proposal is what a loop would change, shown to a person before anything changes:
//   learning          a snippet for a section of the learnings document
//   brain             an edit to one brain component, carried as the whole new file and its diff
//   voice             a rebuilt voice profile, a brain edit to the voice component
//   objection_answer  an answer to a real objection, written by the operator
//   template          a candidate template for the copy-change gate (it ships only as an experiment)
//   discovery_query   a discovery query, added inactive
//   playbook_field    one field of a persona playbook
// Each record stores the exact detail a person is shown, rendered from its fields, and the digest of
// that detail. Approving binds to the digest: approveProposal (apply.ts) re-renders the detail from
// the stored fields and refuses when it no longer hashes to the digest shown. Pending proposals
// expire after PROPOSAL_TTL_DAYS. Creating one never changes anything else.
import { isComponentId, type ComponentId } from "../brain/components.ts";
import { lintOutbound } from "../quality/lint.ts";
import { canonicalJson } from "../security/approval-digest.ts";
import { sha256Hex } from "../shared/hash.ts";
import { DAY_MS } from "../metrics/window.ts";
import { NEVER_PROPOSED_COMPONENTS } from "./brain-edit.ts";
import { isLearningSection, type LearningSection } from "./sections.ts";
import { hasLink, lineDiff, snippetProblems } from "./text.ts";

export const PROPOSAL_KINDS = ["learning", "brain", "voice", "objection_answer", "template", "discovery_query", "playbook_field"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];
export const PROPOSAL_STATUSES = ["pending", "approved", "rejected", "applied", "expired"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPOSAL_TTL_DAYS = 14;

/** Playbook fields a proposal may set. value_frame reaches cold copy ({{persona_hint}}). */
export const PLAYBOOK_FIELDS = ["tone", "opener", "value_frame", "cta"] as const;
export type PlaybookField = (typeof PLAYBOOK_FIELDS)[number];
export const PROSPECT_FACING_PLAYBOOK_FIELDS: readonly PlaybookField[] = Object.freeze(["value_frame"]);

export interface ProposalPayloads {
  learning: { section: LearningSection; text: string; replaces?: string | null; examples?: string[]; pattern?: string };
  brain: { component: ComponentId; baseSha256: string | null; content: string; previousContent: string | null; contentSha256?: string };
  voice: { component: "voice"; baseSha256: string | null; content: string; previousContent: string | null; sources: number; contentSha256?: string };
  objection_answer: { objectionId: string; pattern: string; response: string };
  template: { template: string; subject: string; body: string; hypothesis: string };
  discovery_query: { query: string; source: string; category?: string | null };
  playbook_field: { persona: string; field: PlaybookField; value: string; previous: string | null };
}

export type AnyPayload = ProposalPayloads[ProposalKind];

export interface NewProposal<K extends ProposalKind = ProposalKind> {
  kind: K;
  payload: ProposalPayloads[K];
  rationale?: string | null;
  /** The loop that made it (edit_mining, voice, retrospective, evolution, objections) or operator:<user id>. */
  proposedBy: string;
  sourceRunId?: string | null;
}

export interface LearningProposal {
  id: string;
  shortId: string;
  kind: ProposalKind;
  section: string;
  text: string;
  payload: AnyPayload;
  digest: string;
  rationale: string | null;
  proposedBy: string;
  sourceRunId: string | null;
  status: ProposalStatus;
  statusReason: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  appliedAt: string | null;
  createdAt: string;
  expiresAt: string | null;
}

const SOURCE_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const PERSONA_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** What is wrong with a proposal before it is stored. Empty means it may be stored. */
export function proposalProblems(kind: ProposalKind, payload: AnyPayload): string[] {
  switch (kind) {
    case "learning": {
      const p = payload as ProposalPayloads["learning"];
      return [...(isLearningSection(p.section) ? [] : [`unknown section ${String(p.section)}`]), ...snippetProblems(String(p.text ?? ""))];
    }
    case "brain":
    case "voice": {
      const p = payload as ProposalPayloads["brain"];
      const problems: string[] = [];
      if (!isComponentId(p.component)) problems.push(`unknown component ${String(p.component)}`);
      else if (NEVER_PROPOSED_COMPONENTS.includes(p.component)) problems.push(`${p.component} is never edited by a loop`);
      if (kind === "voice" && p.component !== "voice") problems.push("a voice rebuild edits the voice component");
      if (typeof p.content !== "string" || p.content.length === 0 || p.content.length > 16_384) problems.push("the file must be 1 to 16384 characters");
      if (p.baseSha256 !== null && !/^[0-9a-f]{64}$/.test(String(p.baseSha256))) problems.push("the base digest is malformed");
      if (typeof p.content === "string" && p.content.includes("\r")) problems.push("the file holds a carriage return");
      return problems;
    }
    case "objection_answer": {
      const p = payload as ProposalPayloads["objection_answer"];
      return [...(p.objectionId && p.pattern ? [] : ["an answer needs its objection"]), ...snippetProblems(String(p.response ?? ""), 800)];
    }
    case "template": {
      const p = payload as ProposalPayloads["template"];
      const problems: string[] = [];
      if (!TEMPLATE_ID.test(String(p.template))) problems.push("the control template id is malformed");
      if (typeof p.subject !== "string" || p.subject.trim() === "" || p.subject.length > 120) problems.push("the subject must be 1 to 120 characters");
      if (typeof p.body !== "string" || p.body.trim() === "" || p.body.length > 1500) problems.push("the body must be 1 to 1500 characters");
      if (hasLink(`${p.subject ?? ""}\n${p.body ?? ""}`)) problems.push("a template candidate holds no link; use {{booking_url}}");
      if (/[\u2013\u2014]/.test(`${p.subject ?? ""}${p.body ?? ""}${p.hypothesis ?? ""}`)) problems.push("it holds an em or en dash");
      for (const b of lintOutbound({ subject: String(p.subject ?? ""), body: String(p.body ?? "").replace(/\{\{[a-z_]+\}\}/g, "x") }).blocks) {
        if (b.code !== "PLACEHOLDER_LEAK") problems.push(`the content lint blocks it (${b.code})`);
      }
      problems.push(...snippetProblems(String(p.hypothesis ?? "")).map((x) => `hypothesis: ${x}`));
      return [...new Set(problems)];
    }
    case "discovery_query": {
      const p = payload as ProposalPayloads["discovery_query"];
      const problems = snippetProblems(String(p.query ?? ""), 200);
      if (!SOURCE_ID.test(String(p.source))) problems.push("the source id is malformed");
      if (p.category != null && !SOURCE_ID.test(String(p.category))) problems.push("the category is malformed");
      return problems;
    }
    case "playbook_field": {
      const p = payload as ProposalPayloads["playbook_field"];
      const problems = snippetProblems(String(p.value ?? ""), 300);
      if (!PERSONA_ID.test(String(p.persona))) problems.push("the persona id is malformed");
      if (!(PLAYBOOK_FIELDS as readonly string[]).includes(String(p.field))) problems.push(`field must be one of ${PLAYBOOK_FIELDS.join(", ")}`);
      return problems;
    }
  }
}

/** The record's section column: what the proposal is about, by kind. */
function sectionOf(kind: ProposalKind, payload: AnyPayload): string {
  switch (kind) {
    case "learning":
      return (payload as ProposalPayloads["learning"]).section;
    case "brain":
    case "voice":
      return `brain:${(payload as ProposalPayloads["brain"]).component}`;
    case "objection_answer":
      return `objection:${(payload as ProposalPayloads["objection_answer"]).objectionId}`;
    case "template":
      return `template:${(payload as ProposalPayloads["template"]).template}`;
    case "discovery_query":
      return `discovery:${(payload as ProposalPayloads["discovery_query"]).source}`;
    case "playbook_field": {
      const p = payload as ProposalPayloads["playbook_field"];
      return `playbook:${p.persona}.${p.field}`;
    }
  }
}

function textOf(kind: ProposalKind, payload: AnyPayload): string {
  switch (kind) {
    case "learning":
      return (payload as ProposalPayloads["learning"]).text;
    case "brain":
    case "voice":
      return (payload as ProposalPayloads["brain"]).content;
    case "objection_answer":
      return (payload as ProposalPayloads["objection_answer"]).response;
    case "template":
      return (payload as ProposalPayloads["template"]).body;
    case "discovery_query":
      return (payload as ProposalPayloads["discovery_query"]).query;
    case "playbook_field":
      return (payload as ProposalPayloads["playbook_field"]).value;
  }
}

/** A one-line title for lists. */
export function proposalTitle(p: Pick<LearningProposal, "kind" | "payload">): string {
  switch (p.kind) {
    case "learning":
      return `Learnings: add to ${(p.payload as ProposalPayloads["learning"]).section}`;
    case "brain":
      return `Brain: edit ${(p.payload as ProposalPayloads["brain"]).component}`;
    case "voice":
      return "Brain: rebuild the voice profile";
    case "objection_answer":
      return `Objection answer for ${(p.payload as ProposalPayloads["objection_answer"]).objectionId}`;
    case "template":
      return `Template candidate against ${(p.payload as ProposalPayloads["template"]).template}`;
    case "discovery_query":
      return `Discovery query for ${(p.payload as ProposalPayloads["discovery_query"]).source} (added inactive)`;
    case "playbook_field": {
      const x = p.payload as ProposalPayloads["playbook_field"];
      return `Playbook: ${x.persona} ${x.field}`;
    }
  }
}

/** The exact detail a person approves. Deterministic from the stored fields. */
export function renderDetail(kind: ProposalKind, payload: AnyPayload, rationale: string | null): string {
  const lines: string[] = [];
  switch (kind) {
    case "learning": {
      const p = payload as ProposalPayloads["learning"];
      lines.push(`Add to the learnings section ${p.section}${p.replaces ? `, replacing entry ${p.replaces}` : ""}:`, p.text);
      if (p.examples && p.examples.length > 0) lines.push("", "Examples (data, links disabled):", ...p.examples.map((e) => `  ${e}`));
      break;
    }
    case "brain":
    case "voice": {
      const p = payload as ProposalPayloads["brain"];
      lines.push(
        `Replace the brain component ${p.component} and re-lock the brain, only if it still holds ${p.baseSha256 ? `the file with SHA-256 ${p.baseSha256}` : "no served file"}.`,
        `The new file's SHA-256: ${p.contentSha256 ?? "(not recorded)"}. Changes:`,
        lineDiff(p.previousContent ?? "", p.content),
      );
      if (kind === "voice") lines.push("", `Built from ${(payload as ProposalPayloads["voice"]).sources} of your sent messages, quotes and signatures stripped.`);
      break;
    }
    case "objection_answer": {
      const p = payload as ProposalPayloads["objection_answer"];
      lines.push(`Approve this answer to the objection "${p.pattern}" (${p.objectionId}). Reply drafts may use it:`, p.response);
      break;
    }
    case "template": {
      const p = payload as ProposalPayloads["template"];
      lines.push(
        `A candidate to test against the template ${p.template}. Approving changes no template: it gives you the experiment to run through the copy-change gate.`,
        `Hypothesis: ${p.hypothesis}`,
        `Subject: ${p.subject}`,
        "Body:",
        p.body,
      );
      break;
    }
    case "discovery_query": {
      const p = payload as ProposalPayloads["discovery_query"];
      lines.push(`Add this ${p.source} discovery query, inactive until you activate it${p.category ? ` (category ${p.category})` : ""}:`, p.query);
      break;
    }
    case "playbook_field": {
      const p = payload as ProposalPayloads["playbook_field"];
      lines.push(`Set the ${p.field} of the ${p.persona} playbook.`, `Now: ${p.previous ?? "(unset)"}`, `New: ${p.value}`);
      if (PROSPECT_FACING_PLAYBOOK_FIELDS.includes(p.field)) lines.push("This field reaches cold copy through {{persona_hint}}.");
      break;
    }
  }
  if (rationale) lines.push("", `Why: ${rationale}`);
  return lines.join("\n");
}

/** The digest a person's approval binds to: the exact detail shown. */
export function detailDigest(detail: string): Promise<string> {
  return sha256Hex(canonicalJson({ kind: "learning_proposal", v: 1, detail }));
}

interface ProposalRow {
  id: string;
  short_id: string;
  kind: string;
  section: string;
  proposed_text: string;
  proposed_digest: string;
  payload: string | null;
  rationale: string | null;
  source_run_id: string | null;
  proposed_by: string;
  status: string;
  status_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  applied_at: string | null;
  created_at: string;
  expires_at: string | null;
}

export const PROPOSAL_COLUMNS =
  "id, short_id, kind, section, proposed_text, proposed_digest, payload, rationale, source_run_id, proposed_by, status, status_reason, reviewed_by, reviewed_at, applied_at, created_at, expires_at";

function fromRow(r: ProposalRow): LearningProposal | null {
  if (!(PROPOSAL_KINDS as readonly string[]).includes(r.kind)) return null;
  let payload: AnyPayload;
  try {
    payload = JSON.parse(r.payload ?? "null") as AnyPayload;
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  return {
    id: r.id,
    shortId: r.short_id,
    kind: r.kind as ProposalKind,
    section: r.section,
    text: r.proposed_text,
    payload,
    digest: r.proposed_digest,
    rationale: r.rationale,
    proposedBy: r.proposed_by,
    sourceRunId: r.source_run_id,
    status: r.status as ProposalStatus,
    statusReason: r.status_reason,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    appliedAt: r.applied_at,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

/** The detail for a stored proposal, re-rendered from its fields. */
export function detailOf(p: Pick<LearningProposal, "kind" | "payload" | "rationale">): string {
  return renderDetail(p.kind, p.payload, p.rationale);
}

/** True when the stored fields still render to the stored digest. */
export async function intact(p: LearningProposal): Promise<boolean> {
  if ((await detailDigest(detailOf(p))) !== p.digest || textOf(p.kind, p.payload) !== p.text) return false;
  if (p.kind === "brain" || p.kind === "voice") return brainPayloadConsistent(p.payload as ProposalPayloads["brain"]);
  return true;
}

/**
 * A brain edit's diff is shown against previousContent, so previousContent must be exactly the file
 * the base digest names, and the new file must hash to the digest shown.
 */
async function brainPayloadConsistent(p: ProposalPayloads["brain"]): Promise<boolean> {
  if (p.content.includes("\r") || (p.previousContent ?? "").includes("\r")) return false;
  if (p.contentSha256 !== (await sha256Hex(p.content))) return false;
  if (p.baseSha256 === null) return p.previousContent === null;
  return p.previousContent !== null && (await sha256Hex(p.previousContent)) === p.baseSha256;
}

export type CreateResult = { ok: true; proposal: LearningProposal; created: boolean } | { ok: false; problems: string[] };

/** Store a proposal. An identical pending one is returned instead of a second. Throws on a database error. */
export async function createLearningProposal(db: D1Database, input: NewProposal, now: Date): Promise<CreateResult> {
  if (!(PROPOSAL_KINDS as readonly string[]).includes(input.kind)) return { ok: false, problems: [`unknown kind ${String(input.kind)}`] };
  if (input.kind === "brain" || input.kind === "voice") {
    const b = input.payload as ProposalPayloads["brain"];
    if (typeof b.content === "string") input = { ...input, payload: { ...b, contentSha256: await sha256Hex(b.content) } };
  }
  const problems = proposalProblems(input.kind, input.payload);
  if ((input.kind === "brain" || input.kind === "voice") && problems.length === 0 && !(await brainPayloadConsistent(input.payload as ProposalPayloads["brain"]))) {
    problems.push("the previous file does not match the base digest");
  }
  if (problems.length > 0) return { ok: false, problems };
  const rationale = input.rationale ? input.rationale.replace(/\s+/g, " ").trim().slice(0, 400) || null : null;
  const detail = renderDetail(input.kind, input.payload, rationale);
  const digest = await detailDigest(detail);
  const existing = await db
    .prepare(`SELECT ${PROPOSAL_COLUMNS} FROM learnings_proposals WHERE kind = ?1 AND proposed_digest = ?2 AND status = 'pending' LIMIT 1`)
    .bind(input.kind, digest)
    .first<ProposalRow>();
  const prior = existing ? fromRow(existing) : null;
  if (prior) return { ok: true, proposal: prior, created: false };
  const id = `lp_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const shortId = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const at = now.toISOString();
  const expiresAt = new Date(now.getTime() + PROPOSAL_TTL_DAYS * DAY_MS).toISOString();
  await db
    .prepare(
      `INSERT INTO learnings_proposals (id, short_id, kind, section, proposed_text, proposed_digest, payload, rationale, source_run_id, proposed_by, status, expires_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11, ?12, ?12)`,
    )
    .bind(id, shortId, input.kind, sectionOf(input.kind, input.payload), textOf(input.kind, input.payload), digest, JSON.stringify(input.payload), rationale, input.sourceRunId ?? null, input.proposedBy.slice(0, 64), expiresAt, at)
    .run();
  const stored = await loadLearningProposal(db, shortId);
  if (!stored) throw new Error("the proposal was not stored");
  return { ok: true, proposal: stored, created: true };
}

/** A proposal by its short id (or full id). Null when there is none. Throws on a database error. */
export async function loadLearningProposal(db: D1Database, id: string): Promise<LearningProposal | null> {
  const row = await db.prepare(`SELECT ${PROPOSAL_COLUMNS} FROM learnings_proposals WHERE short_id = ?1 OR id = ?1 LIMIT 1`).bind(id.trim().toLowerCase()).first<ProposalRow>();
  return row ? fromRow(row) : null;
}

/** Proposals, newest first. Throws on a database error. */
export async function listLearningProposals(db: D1Database, filter: { status?: ProposalStatus; kinds?: readonly ProposalKind[]; limit?: number } = {}): Promise<LearningProposal[]> {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (filter.status) {
    binds.push(filter.status);
    clauses.push(`status = ?${binds.length}`);
  }
  if (filter.kinds && filter.kinds.length > 0) {
    binds.push(JSON.stringify(filter.kinds));
    clauses.push(`kind IN (SELECT value FROM json_each(?${binds.length}))`);
  }
  binds.push(Math.max(1, Math.min(200, Math.floor(filter.limit ?? 50))));
  const { results } = await db
    .prepare(`SELECT ${PROPOSAL_COLUMNS} FROM learnings_proposals ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC, short_id ASC LIMIT ?${binds.length}`)
    .bind(...binds)
    .all<ProposalRow>();
  return results.map(fromRow).filter((p): p is LearningProposal => p !== null);
}

/** Mark pending proposals past their expiry as expired. Returns how many. Never throws. */
export async function expireLearningProposals(db: D1Database, now: Date): Promise<number> {
  try {
    const at = now.toISOString();
    const r = await db
      .prepare("UPDATE learnings_proposals SET status = 'expired', status_reason = 'expired unreviewed', updated_at = ?1 WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?1")
      .bind(at)
      .run();
    return r.meta.changes ?? 0;
  } catch {
    return 0;
  }
}

/** How many proposals a loop made since `since`. Throws on a database error. */
export async function proposalsSince(db: D1Database, proposedBy: string, since: Date, kind?: ProposalKind): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM learnings_proposals WHERE proposed_by = ?1 AND created_at >= ?2 ${kind ? "AND kind = ?3" : ""}`)
    .bind(...(kind ? [proposedBy, since.toISOString(), kind] : [proposedBy, since.toISOString()]))
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** The dashboard's view of a proposal (gateway protocol `Proposal`). */
export interface ProposalView {
  id: string;
  source: "learning" | "brain" | "copy";
  title: string;
  detail: string;
  createdAt: string;
  expiresAt?: string;
  digest: string;
}

export function toProposalView(p: LearningProposal): ProposalView {
  const source = p.kind === "brain" || p.kind === "voice" ? "brain" : p.kind === "template" ? "copy" : "learning";
  return { id: p.shortId, source, title: proposalTitle(p), detail: detailOf(p), createdAt: p.createdAt, ...(p.expiresAt ? { expiresAt: p.expiresAt } : {}), digest: p.digest };
}

