// GTM-agents: the drafts_create tool: write one email draft that waits for the operator's approval.
//
// Its class is taint none, gate full: a session that has read raw untrusted text (a web page) cannot
// create drafts, while a session that has read only short third-party text (a contact lookup) can.
// The handler never decides anything about sending. It inserts a row in `drafts` with status
// pending_approval and nothing else; the operator path shows it with its digest and the approval
// binds to that digest.
//
// Skip rather than guess: a recipient that does not normalize to exactly one plain address is
// refused, never repaired. A subject is one line. Drafts written here are operator-requested
// one-offs; cold sequence steps are assembled from templates elsewhere and are not offered.
import { normalizeAddress } from "../sending/suppression.ts";
import type { ToolHandler } from "../runtime/dispatcher.ts";

/** Kinds a chat draft may have: written drafts, never cold sequence steps or proposals. */
export const CHAT_DRAFT_KINDS = ["warm_intro", "check_in", "reply", "recap", "referral_ask", "lifecycle"] as const;
export type ChatDraftKind = (typeof CHAT_DRAFT_KINDS)[number];

export const DRAFT_SUBJECT_MAX_CHARS = 200;
/** Kept short enough that an approval request always shows the whole draft. */
export const DRAFT_BODY_MAX_CHARS = 3000;

export const draftsCreateDefinition = {
  name: "drafts_create",
  description:
    "Create one plain-text email draft for the operator to approve. It is not sent. Use only facts the operator gave you, reference data, or records you looked up. Refused once the session has read a web page.",
  inputSchema: {
    type: "object",
    properties: {
      recipient_email: { type: "string", description: "The recipient's exact email address, as the operator or a contact record gave it." },
      recipient_name: { type: "string", description: "The recipient's name, if known." },
      subject: { type: "string", description: "One line, at most 200 characters." },
      body: { type: "string", description: "Plain text, at most 3000 characters. No markdown." },
      kind: { type: "string", enum: [...CHAT_DRAFT_KINDS], description: "What the draft is. Defaults to warm_intro." },
    },
    required: ["recipient_email", "subject", "body"],
    additionalProperties: false,
  },
} as const;

export interface CreatedDraft {
  id: string;
  recipientEmail: string;
}

export interface DraftsCreateDeps {
  db: D1Database;
  /** Called after a draft row is written, so the operator path can request its approval. */
  onCreated?: (draft: CreatedDraft) => void;
  newId?: () => string;
  now?: () => Date;
}

export function newDraftId(): string {
  return `dr_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

// Dashes the house style forbids in copy, written as escapes so this file holds none.
const LONG_DASH = /\s*[\u2013\u2014]\s*/g;
// eslint-disable-next-line no-control-regex -- control characters are what this removes
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

// Zero-width and bidirectional controls, which could make a preview render differently from the
// bytes its digest binds.
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

function cleanCopy(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(CONTROL, "").replace(INVISIBLE, "").replace(LONG_DASH, ", ").trim();
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} is required`);
  return value;
}

export function createDraftsCreateHandler(deps: DraftsCreateDeps): ToolHandler {
  return async (input) => {
    const recipient = normalizeAddress(requiredString(input, "recipient_email"));
    if (!recipient) throw new Error("recipient_email is not one valid email address; ask the operator for the exact address");
    const rawSubject = requiredString(input, "subject");
    if (/[\r\n]/.test(rawSubject)) throw new Error("subject must be one line");
    const subject = cleanCopy(rawSubject);
    const body = cleanCopy(requiredString(input, "body"));
    if (subject.length === 0 || subject.length > DRAFT_SUBJECT_MAX_CHARS) throw new Error(`subject must be 1 to ${DRAFT_SUBJECT_MAX_CHARS} characters`);
    if (body.length === 0 || body.length > DRAFT_BODY_MAX_CHARS) throw new Error(`body must be 1 to ${DRAFT_BODY_MAX_CHARS} characters`);
    const kind = input.kind === undefined ? "warm_intro" : input.kind;
    if (typeof kind !== "string" || !(CHAT_DRAFT_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`kind must be one of ${CHAT_DRAFT_KINDS.join(", ")}`);
    }
    const name = typeof input.recipient_name === "string" ? cleanCopy(input.recipient_name).replace(/\n/g, " ").slice(0, 120) : "";

    const id = (deps.newId ?? newDraftId)();
    const at = (deps.now?.() ?? new Date()).toISOString();
    const contact = await deps.db.prepare("SELECT id FROM contacts WHERE email = ?1").bind(recipient).first<{ id: string }>();
    await deps.db
      .prepare(
        `INSERT INTO drafts (id, contact_id, kind, recipient_email, recipient_name, subject, body, status, notes, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending_approval', 'created in operator chat', ?8, ?8)`,
      )
      .bind(id, contact?.id ?? null, kind, recipient, name || null, subject, body, at)
      .run();
    try {
      deps.onCreated?.({ id, recipientEmail: recipient });
    } catch {
      // Notification is bookkeeping; the draft exists either way.
    }
    return `Draft ${id} created for ${recipient} and waiting for the operator's approval. It has not been sent.`;
  };
}
