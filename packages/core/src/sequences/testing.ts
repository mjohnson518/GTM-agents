// GTM-agents: test doubles and synthetic fixtures for sequence tests.
//
// Import them from "@gtm-agents/core/sequences/testing" in tests only. sequenceTemplate builds an
// approved follow-up or breakup template file; ACME_SEQUENCE_TEMPLATES is a three-step sequence for
// the invented company Acme. seedFirstTouch writes what a sent cold first touch leaves behind (the
// campaign row, the sequence row at step 1, the send ledger row), so a test can start at the sweep.
// withMessageIds gives a fake email provider a Message-ID lookup that counts its calls. Every
// person, address and id is invented, on *.example domains.
import type { EmailProvider } from "../ports/email.ts";
import { resetOutreachTables } from "../outreach/testing.ts";
import type { TemplateFile } from "../templates/store.ts";

export interface SequenceTemplateOptions {
  kind?: "follow_up" | "breakup";
  step?: number;
  subject?: string;
  body?: string;
  angle?: string;
  personas?: string;
  weight?: number;
  status?: string;
}

export function sequenceTemplate(id: string, options: SequenceTemplateOptions = {}): TemplateFile {
  const kind = options.kind ?? "follow_up";
  const body =
    options.body ??
    (kind === "breakup"
      ? "Hi {{first_name}},\n\nI will stop here so I do not crowd your inbox. If flaky builds become a priority at {{account_name}}, reply to this email and I will pick it up from there.\n\n{{sender_name}}"
      : "Hi {{first_name}},\n\nA short follow-up on my note about flaky builds. Acme can show you which tests cause the most reruns, reading test reports only.\n\nWould a short call help? You can pick a time here: {{booking_url}}\n\n{{sender_name}}");
  const lines = [
    "---",
    `id: ${id}`,
    `kind: ${kind}`,
    `status: ${options.status ?? "approved"}`,
    `step: ${options.step ?? (kind === "breakup" ? 3 : 2)}`,
    `angle: ${options.angle ?? "none"}`,
    `subject: ${options.subject ?? "Re: {{original_subject}}"}`,
    `volume_weight: ${options.weight ?? 1}`,
    ...(options.personas ? [`personas: ${options.personas}`] : []),
    "---",
    body,
    "",
  ];
  return { name: `${id}.md`, content: lines.join("\n") };
}

/** A follow-up (step 2) and a breakup (step 3) for Acme. */
export const ACME_SEQUENCE_TEMPLATES: readonly TemplateFile[] = Object.freeze([sequenceTemplate("follow-up"), sequenceTemplate("breakup", { kind: "breakup" })]);

export interface FirstTouch {
  campaignId: string;
  contactId: string;
  /** The provider that sent it: the send ledger's provider name. */
  provider: string;
  sentAt: Date;
  /** When step 2 is due; defaults to sentAt plus 3 days. */
  nextSendAt?: Date;
  subject?: string;
  templateId?: string;
  providerMessageId?: string;
  /** The stored RFC Message-ID, when the test wants it known already. */
  messageId?: string | null;
  sendId?: string;
}

/** What a sent cold first touch leaves behind: the campaign, the row at step 1, the ledger row; warmth contacted. */
export async function seedFirstTouch(db: D1Database, touch: FirstTouch): Promise<{ sendId: string }> {
  const at = touch.sentAt.toISOString();
  const sendId = touch.sendId ?? `os_${touch.contactId}_1`;
  const next = (touch.nextSendAt ?? new Date(touch.sentAt.getTime() + 3 * 86_400_000)).toISOString();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO campaigns (id, name, status, created_at, updated_at) VALUES (?1, 'Cold batch', 'active', ?2, ?2)").bind(touch.campaignId, at),
    db
      .prepare(
        `INSERT INTO campaign_contacts (campaign_id, contact_id, status, sequence_step, sequence_active, next_send_at, created_at, updated_at)
         VALUES (?1, ?2, 'sent', 1, 1, ?3, ?4, ?4)`,
      )
      .bind(touch.campaignId, touch.contactId, next, at),
    db
      .prepare(
        `INSERT INTO outreach_sends (id, contact_id, account_key, campaign_id, template_id, subject, sequence_step, send_path, provider, provider_message_id, message_id,
           recipient_domain, sent_at, created_at)
         SELECT ?1, c.id, c.account_key, ?2, ?3, ?4, 1, 'cold', ?5, ?6, ?7, substr(c.email, instr(c.email, '@') + 1), ?8, ?8 FROM contacts c WHERE c.id = ?9`,
      )
      .bind(sendId, touch.campaignId, touch.templateId ?? "cold-intro", touch.subject ?? "Flaky builds at Globex Corporation", touch.provider, touch.providerMessageId ?? `pm-${touch.contactId}-1`, touch.messageId ?? null, at, touch.contactId),
    db.prepare("UPDATE contacts SET warmth = 'contacted', last_contacted_at = ?2, total_touches = 1 WHERE id = ?1 AND warmth = 'cold'").bind(touch.contactId, at),
  ]);
  return { sendId };
}

export interface MessageIdLookups {
  /** Every provider message id looked up, in order. */
  calls: string[];
  /** How the lookup answers: a Message-ID, null (not known yet), or a thrown error. */
  answer: (providerMessageId: string) => string | null | Error;
}

/** Give a provider a Message-ID lookup: by default every id is known as <id@mail.fake.example>. */
export function withMessageIds<P extends EmailProvider>(provider: P, answer?: (providerMessageId: string) => string | null | Error): P & { lookups: MessageIdLookups } {
  const lookups: MessageIdLookups = { calls: [], answer: answer ?? ((id) => `<${id}@mail.fake.example>`) };
  return Object.assign(provider, {
    lookups,
    getMessageId(providerMessageId: string): Promise<string | null> {
      lookups.calls.push(providerMessageId);
      const found = lookups.answer(providerMessageId);
      return found instanceof Error ? Promise.reject(found) : Promise.resolve(found);
    },
  });
}

/** Delete the rows sequence tests write, including the outreach tables. Storage is per test file. */
export async function resetSequenceTables(db: D1Database): Promise<void> {
  await db.batch([db.prepare("DELETE FROM manual_touches"), db.prepare("DELETE FROM outreach_log"), db.prepare("DELETE FROM erasure_tombstones")]);
  await resetOutreachTables(db);
}

/** A database that fails every statement whose SQL matches `pattern`, and passes the rest through. */
export function failingOn(db: D1Database, pattern: RegExp): D1Database {
  const wrap = (sql: string, statement: D1PreparedStatement): D1PreparedStatement => {
    if (!pattern.test(sql)) return statement;
    const fail = () => Promise.reject(new Error("D1_ERROR: injected failure"));
    const failing = { bind: () => failing, run: fail, all: fail, first: fail, raw: fail, __failing: true };
    return failing;
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(sql, target.prepare(sql));
      if (prop === "batch") {
        return (statements: D1PreparedStatement[]) =>
          statements.some((s) => (s as unknown as { __failing?: boolean }).__failing) ? Promise.reject(new Error("D1_ERROR: injected failure")) : target.batch(statements);
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
