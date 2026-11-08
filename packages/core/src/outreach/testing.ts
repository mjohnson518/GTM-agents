// GTM-agents: test doubles and synthetic fixtures for outreach tests.
//
// Import them from "@gtm-agents/core/outreach/testing" in tests only. fakeSendOutreach records every
// item it is handed and answers with an outcome per item (sent by default), so a test can assert
// exactly what would have gone out and with which approved digest. fakeJudge is a model gateway that
// answers the reviewer's schema, or fails in a chosen way. The seed helpers write an invented company
// (Acme), invented people on *.example domains, a locked brain and locked templates.
import { BRAIN_LOCK_KEY, brainFileKey } from "../brain/load.ts";
import { computeLock, serializeLock } from "../brain/lock.ts";
import type { ComponentId } from "../brain/components.ts";
import { contactEmailFields } from "../data/contacts.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import type { CompletionRequest, CompletionResult, ModelGateway } from "../ports/model.ts";
import type { OutreachItem, OutreachOutcome, SendOutreach } from "../sending/types.ts";
import { TEMPLATES_LOCK_KEY, computeTemplateLock, templateFileKey, type TemplateFile } from "../templates/store.ts";

export const silentLogger: JobLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** A flag reader over a plain object. Keys in `failing` (or "*") throw when read. */
export function flagReader(values: Record<string, string> = {}, failing: readonly string[] = []): FlagReader & { values: Record<string, string> } {
  return {
    values,
    get(key) {
      if (failing.includes(key) || failing.includes("*")) return Promise.reject(new Error("flag store unavailable"));
      return Promise.resolve(Object.hasOwn(values, key) ? (values[key] ?? null) : null);
    },
  };
}

export interface FakeSend {
  send: SendOutreach;
  /** Each call's items. */
  calls: OutreachItem[][];
  /** Every item handed over, in order. */
  items(): OutreachItem[];
}

/** A send function that records items and answers with `decide` (sent, by default). */
export function fakeSendOutreach(decide?: (item: OutreachItem, index: number) => OutreachOutcome): FakeSend {
  const calls: OutreachItem[][] = [];
  let n = 0;
  return {
    calls,
    items: () => calls.flat(),
    send(items) {
      calls.push(items.map((i) => ({ ...i })));
      return Promise.resolve(
        items.map((item, i) => {
          n += 1;
          return decide ? decide(item, i) : { idempotencyKey: item.idempotencyKey, status: "sent" as const, providerMessageId: `pm-${n}`, sendId: `send-${n}` };
        }),
      );
    },
  };
}

export type JudgeFailure = "throw" | "garbage" | "missing_verdict" | "out_of_range" | "hang";

export interface FakeJudge extends ModelGateway {
  requests: CompletionRequest[];
}

/**
 * A judge that passes (or fails) every email it is shown, or fails in the chosen way. It reads how
 * many emails the user turn holds from the reviewer's "Email <n> (" headers.
 */
export function fakeJudge(options: { pass?: boolean; score?: number; failure?: JudgeFailure; model?: string } = {}): FakeJudge {
  const requests: CompletionRequest[] = [];
  const model = options.model ?? "judge-test-model";
  return {
    name: "fake-judge",
    requests,
    async complete(request): Promise<CompletionResult> {
      requests.push(request);
      if (options.failure === "throw") throw new Error("the judge is unavailable");
      if (options.failure === "hang") {
        await new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("aborted");
      }
      const content = typeof request.messages[0]?.content === "string" ? request.messages[0].content : "";
      const count = [...content.matchAll(/^Email (\d+) \(/gm)].length;
      const score = options.failure === "out_of_range" ? 9 : (options.score ?? 4);
      const verdicts = Array.from({ length: options.failure === "missing_verdict" ? Math.max(0, count - 1) : count }, (_, index) => ({
        index,
        pass: options.pass ?? true,
        relevance: score,
        clarity: score,
        tone: score,
        claims: score,
        reasons: options.pass === false ? ["the opening reads as generic"] : [],
      }));
      const text = options.failure === "garbage" ? "I think these look fine." : JSON.stringify({ verdicts });
      return { text, toolCalls: [], stopReason: "end", usage: { inputTokens: 1200, outputTokens: 150 }, model };
    },
    embed: () => Promise.reject(new Error("not used")),
  };
}

const brainFile = (component: string, body: string) => ["---", `component: ${component}`, "status: approved", "version: 1", "updated: 2026-11-01", "---", "", body, ""].join("\n");

export const ACME_BRAIN: Readonly<Partial<Record<ComponentId, string>>> = Object.freeze({
  personas: [
    "## economic-buyer",
    "- role: economic_buyer",
    "- seat: decision_maker",
    "- titles: VP Engineering, Head of Engineering, CTO",
    "- seniority: c_level, vp, head",
    "- text: Owns the engineering tooling budget.",
    "",
    "## platform-champion",
    "- role: champion",
    "- seat: influencer",
    "- titles: Staff Engineer, Platform Lead",
    "- text: Feels the pain of flaky pipelines every day.",
  ].join("\n"),
  icp: ["## never-competitors", "- kind: never", "- domains: initech.example", "- text: A competitor; never contacted."].join("\n"),
  facts: ["## setup-time", "- text: Most teams finish setup in under an hour.", "- value: under an hour"].join("\n"),
  "message-pillars": ["## less-rerunning", "- text: Engineers stop rerunning builds that failed for reasons unrelated to their change.", "- proof: setup-time"].join("\n"),
  voice: ["## plain", "- kind: do", "- text: Write plainly and ask one question."].join("\n"),
});

/** Upload an approved, locked brain to KV. */
export async function uploadOutreachBrain(kv: KVNamespace, bodies: Partial<Record<ComponentId, string>> = ACME_BRAIN): Promise<void> {
  const files = Object.entries(bodies).map(([component, body]) => ({ name: `${component}.md`, component: component as ComponentId, content: brainFile(component, body ?? "") }));
  await kv.put(BRAIN_LOCK_KEY, serializeLock(await computeLock(files.map((f) => ({ name: f.name, content: f.content })))));
  for (const f of files) await kv.put(brainFileKey(f.component), f.content);
}

export function templateFile(id: string, options: { subject?: string; body?: string; status?: string; weight?: number; personas?: string; segments?: string; kind?: string } = {}): TemplateFile {
  const lines = [
    "---",
    `id: ${id}`,
    `kind: ${options.kind ?? "cold_intro"}`,
    `status: ${options.status ?? "approved"}`,
    "step: 1",
    `subject: ${options.subject ?? "Flaky builds at {{account_name}}"}`,
    `volume_weight: ${options.weight ?? 1}`,
    ...(options.personas ? [`personas: ${options.personas}`] : []),
    ...(options.segments ? [`segments: ${options.segments}`] : []),
    "---",
    options.body ??
      [
        "Hi {{first_name}},",
        "",
        "When a build fails for a reason unrelated to the change, someone reruns it, waits, and loses the thread of what they were doing.",
        "{{persona_line}}",
        "",
        "Is flaky-test time something your team tracks at {{account_name}}, or does it mostly show up as frustration in standup?",
        "",
        "{{sender_name}}",
      ].join("\n"),
    "",
  ];
  return { name: `${id}.md`, content: lines.join("\n") };
}

/** Upload templates and their lock to KV. */
export async function uploadTemplates(kv: KVNamespace, files: readonly TemplateFile[]): Promise<void> {
  await kv.put(TEMPLATES_LOCK_KEY, JSON.stringify(await computeTemplateLock(files)));
  for (const f of files) await kv.put(templateFileKey(f.name.replace(/\.md$/, "")), f.content);
}

export interface SeedContact {
  first: string | null;
  last?: string;
  email: string;
  accountName?: string;
  title?: string;
  persona?: string;
  warmth?: string;
  confidence?: string;
  verification?: string;
  fit?: "keep" | "maybe" | "drop" | null;
  createdAt?: string;
  attributes?: Record<string, unknown>;
}

/** Insert an account (when new) and a contact ready for cold selection. Returns the contact id. */
export async function seedContact(db: D1Database, contact: SeedContact): Promise<string> {
  const fields = await contactEmailFields(contact.email);
  if (!fields) throw new Error(`not an address: ${contact.email}`);
  const domain = contact.email.split("@")[1] ?? "";
  const id = `ct_${fields.email_sha256.slice(0, 12)}`;
  const at = contact.createdAt ?? "2026-11-01T00:00:00.000Z";
  await db
    .prepare("INSERT OR IGNORE INTO accounts (account_key, name, domain, created_at, updated_at) VALUES (?1, ?2, ?1, ?3, ?3)")
    .bind(domain, contact.accountName ?? domain, at)
    .run();
  await db
    .prepare(
      `INSERT INTO contacts (id, first_name, last_name, email, email_sha256, mailbox_sha256, account_key, job_title, warmth, email_confidence,
         verification_status, attributes, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)`,
    )
    .bind(
      id,
      contact.first,
      contact.last ?? null,
      fields.email,
      fields.email_sha256,
      fields.mailbox_sha256,
      domain,
      contact.title ?? "Staff Engineer",
      contact.warmth ?? "cold",
      contact.confidence ?? "high",
      contact.verification ?? "deliverable",
      JSON.stringify(contact.attributes ?? {}),
      at,
    )
    .run();
  if (contact.fit !== null) {
    await db.prepare("INSERT INTO contact_fit (contact_id, decision, reason, source, decided_at, created_at) VALUES (?1, ?2, 'test', 'rule', ?3, ?3)").bind(id, contact.fit ?? "keep", at).run();
  }
  if (contact.persona) {
    await db.prepare("INSERT INTO account_contacts (account_key, contact_id, persona, created_at) VALUES (?1, ?2, ?3, ?4)").bind(domain, id, contact.persona, at).run();
  }
  await db
    .prepare("INSERT OR IGNORE INTO email_verifications (email_sha256, status, provider, score, verified_at, created_at) VALUES (?1, ?2, 'test', 95, ?3, ?3)")
    .bind(fields.email_sha256, contact.verification ?? "deliverable", at)
    .run();
  return id;
}

/** Delete the rows outreach tests write. Storage is per test file, so this touches no other suite. */
export async function resetOutreachTables(db: D1Database): Promise<void> {
  const tables = [
    "approval_manifests",
    "quality_checks",
    "campaign_contacts",
    "drafts",
    "campaigns",
    "templates",
    "copy_lines",
    "persona_playbooks",
    "outreach_holdout",
    "outreach_sends",
    "deferred_sends",
    "inbound_emails",
    "deals",
    "event_effects",
    "autonomy_events",
    "cost_events",
    "suppression",
    "contact_evidence",
    "contact_lifecycle",
    "account_contacts",
    "contact_fit",
    "email_verifications",
    "contacts",
    "accounts",
    "account_fit",
  ];
  // An opted-out contact may only be deleted while its opt-out is kept elsewhere, so tombstones are
  // written for them first and removed with everything else.
  await db
    .prepare("INSERT OR IGNORE INTO erasure_tombstones (email_sha256, mailbox_sha256, source, erased_at) SELECT email_sha256, mailbox_sha256, 'operator', created_at FROM contacts WHERE warmth = 'opted_out'")
    .run();
  await db.batch([...tables.map((t) => db.prepare(`DELETE FROM ${t}`)), db.prepare("DELETE FROM erasure_tombstones")]);
}
