// GTM-agents: synthetic fixtures for the ship loop's planning tests: an Acme config, invented
// contacts and feedback on *.example domains, a model gateway that answers by role and embeds by
// keyword, a recording build starter, and a clean slate. Nothing here is a real person or company.
import type { Env } from "@gtm-agents/core";
import { defineConfig, type GtmConfig, type GtmConfigInput } from "@gtm-agents/core/config";
import { contactEmailFields } from "@gtm-agents/core/data";
import type { CompletionRequest, ModelGateway, ModelRole } from "@gtm-agents/core/ports";
import type { TemplateFile } from "@gtm-agents/core/templates";
import type { StartShipBuild } from "./contract.ts";
import { hexId } from "./planning-shared.ts";

export const SHIP_TEST_MODEL = "ship-test-model";
export const SHIP_TEST_EMBEDDER = "ship-test-embedder";
export const SHIP_TEST_REPO = "acme-example/quarantine";
export const SHIP_TEST_CHAT = "4251001";

/** The synthetic Acme config with every role the planning side uses priced, and the module on. */
export function shipTestConfig(overrides: Partial<GtmConfigInput> = {}): GtmConfig {
  return defineConfig({
    company: { name: "Acme", domain: "acme.example", url: "https://acme.example", product: { name: "Acme Quarantine", description: "Detects flaky tests in CI and quarantines them automatically." } },
    agent: { name: "Avery" },
    sending: {
      from: { email: "avery@outreach.acme.example", name: "Avery at Acme" },
      replyTo: "avery@acme.example",
      supportAddress: "support@acme.example",
      postalAddress: "Acme Inc., 100 Example Street, Springfield, EX 00000",
      domain: "outreach.acme.example",
      bookingUrl: "https://acme.example/book",
    },
    models: {
      roles: { triage: SHIP_TEST_MODEL, strategist: SHIP_TEST_MODEL, embedding: SHIP_TEST_EMBEDDER },
      pricing: { [SHIP_TEST_MODEL]: { inputCentsPerMTok: 10, outputCentsPerMTok: 50 } },
    },
    modules: { ship: { enabled: true } },
    operator: { allowedChatIds: [SHIP_TEST_CHAT], allowedUserIds: [SHIP_TEST_CHAT] },
    ...overrides,
  });
}

/** Flags with the ship loop's switches on. */
export const SHIP_ON: Readonly<Record<string, string>> = Object.freeze({
  "ship:enabled": "true",
  "ship:themes_enabled": "true",
  "ship:specs_enabled": "true",
  "ship:notes_enabled": "true",
});

/** Remove every row the planning tests write, so counts start from zero. */
export async function resetShipTables(db: D1Database): Promise<void> {
  await db.batch(
    ["ship_notes", "ship_tasks", "feedback_items", "themes", "autonomy_events", "autonomy_level_changes", "drafts", "contact_lifecycle", "suppression", "erasure_tombstones", "audit_log", "event_effects", "cost_events"].map((t) =>
      db.prepare(`DELETE FROM ${t}`),
    ),
  );
}

export interface SeededPerson {
  id: string;
  email: string;
}

let counter = 0;
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}${(counter += 1)}`;

/** An invented contact, optionally a product user (signed up) and paying. */
export async function seedPerson(db: D1Database, options: { first?: string | null; email?: string; productUser?: boolean; state?: string; mrrCents?: number; productUserId?: string } = {}): Promise<SeededPerson> {
  const email = options.email ?? `${uid("ada")}@${uid("globex")}.example`;
  const fields = await contactEmailFields(email);
  if (!fields) throw new Error(`not an address: ${email}`);
  const id = uid("ct");
  await db
    .prepare("INSERT INTO contacts (id, first_name, email, email_sha256, mailbox_sha256, account_key, warmth) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'customer')")
    .bind(id, options.first === undefined ? "Ada" : options.first, fields.email, fields.email_sha256, fields.mailbox_sha256, fields.email.split("@")[1] ?? null)
    .run();
  if (options.productUser !== false || options.state) {
    const state = options.state ?? "activated";
    await db
      .prepare("INSERT INTO contact_lifecycle (contact_id, state, product_user_id, mrr_cents, signed_up_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .bind(id, state, options.productUserId ?? uid("pu"), options.mrrCents ?? 0, options.productUser === false ? null : "2026-10-01T00:00:00.000Z")
      .run();
  }
  return { id, email: fields.email };
}

/** An invented feedback item. */
export async function seedFeedback(
  db: D1Database,
  input: { text: string; contactId?: string | null; productUserId?: string | null; status?: string; themeId?: string | null; summary?: string | null; priority?: string | null; createdAt?: string },
): Promise<string> {
  const id = uid("fb");
  await db
    .prepare(
      `INSERT INTO feedback_items (id, source, external_id, product_user_id, contact_id, text, status, theme_id, triage_summary, priority, created_at)
       VALUES (?1, 'product', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(id, uid("ext"), input.productUserId ?? null, input.contactId ?? null, input.text, input.status ?? "new", input.themeId ?? null, input.summary ?? null, input.priority ?? null, input.createdAt ?? new Date().toISOString())
    .run();
  return id;
}

/** A theme row, for tests that start from one. */
export async function seedTheme(db: D1Database, input: { repo?: string; status?: string; title?: string; score?: number; spec?: string | null; specDigest?: string | null; specRisk?: string | null; id?: string } = {}): Promise<string> {
  const id = input.id ?? hexId(10);
  await db
    .prepare(
      `INSERT INTO themes (id, repo, category, affected_area, title, status, priority_score, demand_count, spec, spec_digest, spec_risk, member_count)
       VALUES (?1, ?2, 'feature_request', 'test reports', ?3, ?4, ?5, 3, ?6, ?7, ?8, 1)`,
    )
    .bind(id, input.repo ?? SHIP_TEST_REPO, input.title ?? "Export quarantined tests as CSV", input.status ?? "open", input.score ?? 10, input.spec ?? null, input.specDigest ?? null, input.specRisk ?? null)
    .run();
  return id;
}

export type RoleAnswer = string | Error | ((request: CompletionRequest) => string | Error);

export interface ShipModel extends ModelGateway {
  requests: CompletionRequest[];
  embedded: string[][];
}

/**
 * A gateway that answers each role from a table and embeds each text with the first vector whose
 * keyword it contains (the default vector otherwise). Records every request.
 */
export function shipModel(answers: Partial<Record<ModelRole, RoleAnswer>>, vectors: ReadonlyArray<readonly [string, number[]]> = [], options: { embedModel?: string; fallback?: number[] } = {}): ShipModel {
  const requests: CompletionRequest[] = [];
  const embedded: string[][] = [];
  return {
    name: "ship-test-gateway",
    requests,
    embedded,
    complete(request) {
      requests.push(request);
      const answer = answers[request.role];
      if (answer === undefined) return Promise.reject(new Error(`no answer for ${request.role}`));
      const text = typeof answer === "function" ? answer(request) : answer;
      if (text instanceof Error) return Promise.reject(text);
      return Promise.resolve({ text, toolCalls: [], stopReason: "end", usage: { inputTokens: 200, outputTokens: 80 }, model: SHIP_TEST_MODEL });
    },
    embed(texts) {
      embedded.push([...texts]);
      const out = texts.map((t) => [...(vectors.find(([k]) => t.toLowerCase().includes(k.toLowerCase()))?.[1] ?? options.fallback ?? [0, 0, 1])]);
      return Promise.resolve({ vectors: out, model: options.embedModel ?? SHIP_TEST_EMBEDDER, cost: { provider: "ship-test-gateway", capability: "embedding", usd: 0.0001 } });
    },
  };
}

/** The user turn of a request, as text. */
export const userTurn = (r: CompletionRequest): string => r.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

/** A triage answer. */
export const triageAnswer = (fields: { actionable?: boolean; category?: string; priority?: string; summary?: string; affected_area?: string } = {}): string =>
  JSON.stringify({ actionable: true, category: "feature_request", priority: "normal", summary: "Users want to export the list of quarantined tests as a CSV file.", affected_area: "test reports", ...fields });

/** A spec answer. */
export const specAnswer = (fields: Record<string, unknown> = {}): string =>
  JSON.stringify({
    title: "Export quarantined tests as CSV",
    problem: "Teams cannot take the list of quarantined tests out of the dashboard to share it in planning.",
    approach: "Add a CSV export action to the quarantine list view that serializes the visible rows.",
    acceptanceCriteria: ["The quarantine list has an Export CSV button", "The file lists test name, owner and failure count"],
    files: ["src/quarantine/list-view.ts", "src/quarantine/csv.ts"],
    tests: ["csv.test.ts covers quoting and empty lists"],
    outOfScope: ["Scheduled exports"],
    risk: "low",
    adoptionEvent: "custom.quarantine_exported",
    feasible: true,
    ...fields,
  });

export interface RecordingBuild<E extends Env> {
  start: StartShipBuild<E>;
  calls: string[];
}

/** A build starter that records the task ids it was given and answers `answer`. */
export function recordingBuild<E extends Env>(answer: { started: boolean; reason?: string } | Error = { started: true }): RecordingBuild<E> {
  const calls: string[] = [];
  return {
    calls,
    start: (_env, taskId) => {
      calls.push(taskId);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
}

/** The Acme note template, as a deployment would bundle it. */
export const SHIP_LIVE_TEMPLATE: TemplateFile = {
  name: "ship-live.md",
  content: [
    "---",
    "id: ship-live",
    "kind: lifecycle",
    "status: approved",
    "subject: The change you asked for is live",
    "updated: 2026-11-09",
    "---",
    "Hi {{first_name}},",
    "",
    "A while ago you told us what you wanted from Acme. We built it, and it is live now: {{attributes.shipped_title}}.",
    "",
    "Thank you for taking the time to write in. If it does not work the way you hoped, just reply and tell me what is missing.",
    "",
    "{{sender_name}}",
    "",
  ].join("\n"),
};
