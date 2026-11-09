// GTM-agents: synthetic fixtures for the experiments tests: served templates, their rows, and
// ledger rows with known arms and outcomes. Every template, company and send is invented.
import type { JobLogger } from "../src/jobs/registry.ts";
import { templateFile } from "../src/outreach/testing.ts";
import { serveTemplateFiles, type ServedTemplate } from "../src/templates/store.ts";

export const quiet: JobLogger = { info: () => {}, warn: () => {}, error: () => {} };
export const DAY = 86_400_000;

/** Serve Acme templates from synthetic files and record their rows, as a cold batch run would. */
export async function servedAcmeTemplates(db: D1Database, ids: readonly string[], options: { weight?: number; subject?: string } = {}): Promise<ServedTemplate[]> {
  const load = await serveTemplateFiles(
    ids.map((id) => templateFile(id, { ...(options.weight !== undefined ? { weight: options.weight } : {}), ...(options.subject ? { subject: options.subject } : {}) })),
    { companyDomain: "acme.example" },
  );
  if (load.templates.length !== ids.length) throw new Error(`templates not served: ${JSON.stringify(load.skipped)}`);
  for (const t of load.templates) {
    await db
      .prepare(
        `INSERT INTO templates (id, kind, status, step, subject, body_sha256, volume_weight, created_at, updated_at) VALUES (?1, 'cold_intro', 'approved', 1, ?2, ?3, ?4, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
         ON CONFLICT (id) DO UPDATE SET body_sha256 = excluded.body_sha256, volume_weight = excluded.volume_weight`,
      )
      .bind(t.id, t.subject, t.sha256, t.meta.volume_weight)
      .run();
  }
  return load.templates;
}

let seq = 0;

export interface LedgerRows {
  templateId: string;
  sha: string;
  sends: number;
  positives: number;
  /** Human replies that are not positive, on top of the positives. */
  replies?: number;
  sentAt: string;
  experimentId?: string;
  arm?: string;
  accountKey?: string | null;
  step?: number;
  draftId?: (i: number) => string | null;
}

/** Insert first touches on the ledger: `positives` of them positive, the rest silent. */
export async function insertLedger(db: D1Database, rows: LedgerRows): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < rows.sends; i++) {
    seq += 1;
    const positive = i < rows.positives;
    const replied = positive || i < rows.positives + (rows.replies ?? 0);
    statements.push(
      db
        .prepare(
          `INSERT INTO outreach_sends (id, account_key, template_id, template_sha256, experiment_id, experiment_arm, sequence_step, send_path, provider, sent_at,
             replied_at, reply_intent, positive_reply_at, draft_id)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'cold', 'test-ledger', ?8, ?9, ?10, ?11, ?12)`,
        )
        .bind(
          `osx_${seq}`,
          rows.accountKey === undefined ? `acct${seq}.example` : rows.accountKey,
          rows.templateId,
          rows.sha,
          rows.experimentId ?? null,
          rows.arm ?? null,
          rows.step ?? 1,
          rows.sentAt,
          replied ? rows.sentAt : null,
          positive ? "interested" : replied ? "not_a_fit" : null,
          positive ? rows.sentAt : null,
          rows.draftId ? rows.draftId(i) : null,
        ),
    );
  }
  for (let i = 0; i < statements.length; i += 100) await db.batch(statements.slice(i, i + 100));
}

export const iso = (ms: number) => new Date(ms).toISOString();

/** The copy an experiment over these two templates starts with. */
export const copyOf = (templates: readonly ServedTemplate[]) => ({ controlSha: templates[0]?.sha256 ?? "", treatmentSha: templates[1]?.sha256 ?? "" });
