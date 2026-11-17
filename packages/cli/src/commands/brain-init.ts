// GTM-agents: `gtm brain init`, a short interview that writes a draft brain
// (docs/BRAIN-SCHEMA.md#starting-from-an-interview).
//
//   gtm brain init [dir]                   asks the questions on the terminal
//   gtm brain init [dir] --answers <file>  takes them from a JSON file of { "<question id>": "<answer>" }
//   gtm brain init --questions             prints the questions as JSON (what a coding agent reads)
//
// Seven batches. The company and sender, the booking link and the send window belong in
// gtm.config.ts: they are printed as a snippet to paste, and the file is never edited. The others
// write personas, icp, message-pillars, facts and voice into the brain folder (./brain by default):
//   - a blank answer is a skip, never a placeholder. An item missing a required answer is not written,
//     a component with no items is not written (so tasks report it as missing), and a skipped ICP
//     question becomes an `unknown` item, the schema's way of saying it is not known yet;
//   - a never item is written only with a domain or title list, and the facts item only with its
//     claim. No pillar is tied to the fact: the person says which pillar it backs up;
//   - every answer is checked as it is given, with the brain's own rules (the component schema, links
//     only in url fields, prices only in commercial). On a terminal an invalid answer is asked again;
//     in an answers file it stops the command with nothing written;
//   - every file is written `status: draft`, so nothing is served until a person approves it, and an
//     existing component file is never overwritten.
// Then the folder is validated. Nothing is fetched and no model is called: drafting product and ICP
// from your website is the dashboard's Product and ICP page (docs/TARGETING.md).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { COMPONENT_SCHEMAS, PRICE_PATTERN, URL_FIELDS, URL_PATTERN, coerceFields, renderBrainFile, validateBrain, type BrainItemInput, type ComponentId } from "@gtm-agents/core/brain";
import { EXIT, type Io } from "../lib/io.ts";
import { locateBrain, readFlatDir } from "../lib/project.ts";

export type QuestionTarget = { kind: "brain"; component: ComponentId; item: string; field: string } | { kind: "config"; path: string };

export interface InitQuestion {
  id: string;
  batch: number;
  prompt: string;
  help?: string;
  target: QuestionTarget;
}

export interface InitBatch {
  number: number;
  title: string;
  intro: string;
}

export const BRAIN_INIT_BATCHES: readonly InitBatch[] = Object.freeze([
  { number: 1, title: "Company and sender", intro: "These go in gtm.config.ts. They are printed at the end for you to paste; the file is never edited." },
  { number: 2, title: "Buyers", intro: "Two personas: the person who signs off, and the person who feels the problem day to day." },
  { number: 3, title: "Accounts", intro: "Who you sell to, and who must never be contacted." },
  { number: 4, title: "Pain, offer and proof", intro: "What a writer may say. Only the proof answer may hold a figure. Leave anything you cannot show blank: nothing is made up in its place." },
  { number: 5, title: "The ask", intro: "Where a reader books a call. This goes in gtm.config.ts." },
  { number: 6, title: "When mail goes out", intro: "Cold mail goes out only in the recipient's local window. This goes in gtm.config.ts." },
  { number: 7, title: "Voice", intro: "How the agent writes." },
]);

const brain = (component: ComponentId, item: string, field: string): QuestionTarget => ({ kind: "brain", component, item, field });
const config = (path: string): QuestionTarget => ({ kind: "config", path });

export const BRAIN_INIT_QUESTIONS: readonly InitQuestion[] = Object.freeze([
  { id: "company_name", batch: 1, prompt: "Company name?", target: config("company.name") },
  { id: "company_domain", batch: 1, prompt: "Primary domain?", help: "Lowercase, without https://, for example acme.example.", target: config("company.domain") },
  { id: "company_url", batch: 1, prompt: "Website?", help: "An https:// URL.", target: config("company.url") },
  { id: "product_name", batch: 1, prompt: "Product name?", target: config("company.product.name") },
  { id: "product_description", batch: 1, prompt: "The product, in one sentence?", target: config("company.product.description") },
  { id: "agent_name", batch: 1, prompt: "The name the agent signs with?", target: config("agent.name") },
  { id: "sender_email", batch: 1, prompt: "Cold mail sender address?", help: "On a subdomain of your domain, kept apart from your main mail, for example avery@outreach.acme.example.", target: config("sending.from.email") },
  { id: "sender_name", batch: 1, prompt: "Sender display name?", target: config("sending.from.name") },
  { id: "reply_to", batch: 1, prompt: "Where replies go (a real mailbox)?", target: config("sending.replyTo") },
  { id: "support_address", batch: 1, prompt: "Support address?", target: config("sending.supportAddress") },
  { id: "postal_address", batch: 1, prompt: "Postal address for the cold mail footer?", target: config("sending.postalAddress") },

  { id: "buyer_titles", batch: 2, prompt: "Titles of the person who signs off?", help: "Comma-separated, for example VP Engineering, Head of Engineering.", target: brain("personas", "economic-buyer", "titles") },
  { id: "buyer_seniority", batch: 2, prompt: "Their seniority?", help: "Comma-separated, from c_level, vp, head, director, manager, lead, senior, individual.", target: brain("personas", "economic-buyer", "seniority") },
  { id: "buyer_cares", batch: 2, prompt: "What they care about, in a sentence?", target: brain("personas", "economic-buyer", "text") },
  { id: "champion_titles", batch: 2, prompt: "Titles of the person who feels the problem and would champion a fix?", help: "Comma-separated.", target: brain("personas", "champion", "titles") },
  { id: "champion_seniority", batch: 2, prompt: "Their seniority?", help: "Comma-separated, from c_level, vp, head, director, manager, lead, senior, individual.", target: brain("personas", "champion", "seniority") },
  { id: "champion_cares", batch: 2, prompt: "What they care about, in a sentence?", target: brain("personas", "champion", "text") },

  { id: "icp_who", batch: 3, prompt: "The companies you sell to, in a sentence?", target: brain("icp", "who", "text") },
  { id: "icp_must_have", batch: 3, prompt: "What must be true of a company before it is contacted?", target: brain("icp", "must-have", "text") },
  { id: "icp_why_now", batch: 3, prompt: "Why would they buy now?", target: brain("icp", "why-now", "text") },
  { id: "never_reason", batch: 3, prompt: "Who must never be contacted, and why, in a sentence?", target: brain("icp", "never", "text") },
  { id: "never_domains", batch: 3, prompt: "Domains never to contact?", help: "Comma-separated, for example initech.example.", target: brain("icp", "never", "domains") },
  { id: "never_titles", batch: 3, prompt: "Titles never to contact?", help: "Comma-separated.", target: brain("icp", "never", "titles") },

  { id: "pain", batch: 4, prompt: "The problem you solve, in one or two sentences?", help: "No figures here: a figure goes in the proof answers.", target: brain("message-pillars", "problem", "text") },
  { id: "difference", batch: 4, prompt: "What you do that the alternatives do not?", target: brain("message-pillars", "difference", "text") },
  { id: "proof_claim", batch: 4, prompt: "One result a customer got, in a sentence?", help: "Only what you can show. Blank if you have none yet.", target: brain("facts", "customer-result", "text") },
  { id: "proof_figure", batch: 4, prompt: "The exact figure, as a writer may quote it?", help: "For example 62% fewer reruns. Blank if there is none.", target: brain("facts", "customer-result", "value") },
  { id: "proof_url", batch: 4, prompt: "Where it is published?", help: "An https:// URL. Blank if it is not public.", target: brain("facts", "customer-result", "url") },

  { id: "booking_url", batch: 5, prompt: "Booking link?", help: "An https:// URL.", target: config("sending.bookingUrl") },

  { id: "send_days", batch: 6, prompt: "Days cold mail may go out?", help: "Comma-separated from MON, TUE, WED, THU, FRI, SAT, SUN. Blank keeps the default (MON, TUE, WED, THU).", target: config("sending.windowDays") },
  { id: "send_hours", batch: 6, prompt: "Hours, in the recipient's time zone?", help: "Whole hours as start-end, for example 8-15 (from 8:00 until 15:00). Blank keeps the default.", target: config("sending.windowHours") },

  { id: "voice_do", batch: 7, prompt: "How you write, in a sentence?", target: brain("voice", "do", "text") },
  { id: "voice_dont", batch: 7, prompt: "What it must never sound like?", target: brain("voice", "dont", "text") },
  { id: "signoff", batch: 7, prompt: "How messages are signed off?", target: brain("voice", "signoff", "text") },
]);

/** The fields each item always carries: what the question means, never an answer. */
const FIXED: Readonly<Record<string, Record<string, string>>> = {
  "personas/economic-buyer": { role: "economic_buyer", seat: "decision_maker" },
  "personas/champion": { role: "champion", seat: "influencer" },
  "icp/who": { kind: "who" },
  "icp/must-have": { kind: "must_have" },
  "icp/why-now": { kind: "why_now" },
  "icp/never": { kind: "never" },
  "voice/do": { kind: "do" },
  "voice/dont": { kind: "dont" },
  "voice/signoff": { kind: "signoff" },
};

/** What a skipped ICP question is written as. */
const ICP_UNKNOWN: Readonly<Record<string, string>> = {
  who: "Not answered yet: who you sell to.",
  "must-have": "Not answered yet: what must be true of a company you sell to.",
  "why-now": "Not answered yet: why they buy now.",
};
const NEVER_REASON = "Excluded by the deployer.";
const FACT_ID = "customer-result";
const MAX_ANSWERS_BYTES = 64 * 1024;
const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
// The config schema's domain rule (packages/core/src/config/schema.ts): letters only in the top-level label.
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** The config schema's length limits, where they are tighter than 300. */
const CONFIG_MAX: Readonly<Record<string, number>> = { "company.name": 120, "company.product.name": 120, "company.product.description": 500, "agent.name": 60, "sending.from.name": 80 };
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
/** Answers that mean "I do not know": a blank answer is the way to skip, so these are never written. */
const SKIP_WORDS = /^(?:tbd|tba|todo|n\/?a|none|unknown|not sure|skip|later|\?+|-+|\.+)$/i;
const HOURS = /^(\d{1,2})\s*-\s*(\d{1,2})$/;
const FIGURE = /\d/;

const USAGE = "Usage: gtm brain init [dir] [--answers <file.json>] | gtm brain init --questions";

type Answers = Record<string, string>;
type FieldSchema = { safeParse(value: unknown): { success: boolean; error?: { issues: Array<{ message: string }> } } };

function isHttps(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Why a config answer cannot be used, or null. `earlier` holds the other answers, for the subdomain rule. */
function configProblem(path: string, value: string, earlier: Answers): string | null {
  if (path === "sending.from.email") {
    if (!EMAIL.test(value)) return "use an email address, for example avery@outreach.acme.example";
    const company = (earlier.company_domain ?? "").trim().toLowerCase();
    const host = value.slice(value.lastIndexOf("@") + 1).toLowerCase();
    if (company && !host.endsWith(`.${company}`)) return `send from a subdomain of ${company}, for example someone@outreach.${company}, so your main domain's reputation stays apart`;
    return null;
  }
  if (path.endsWith("email") || path === "sending.replyTo" || path === "sending.supportAddress") return EMAIL.test(value) ? null : "use an email address, for example avery@acme.example";
  if (path === "company.domain") return DOMAIN.test(value) ? null : "use a lowercase domain such as acme.example, without https:// or a path";
  if (path === "company.url" || path === "sending.bookingUrl") return isHttps(value) ? null : "use an https:// URL";
  if (path === "sending.postalAddress") return value.length >= 10 && value.length <= 300 ? null : "use the full postal address, 10 to 300 characters";
  if (path === "sending.windowDays") return windowDays(value) ? null : "use days from MON, TUE, WED, THU, FRI, SAT, SUN, comma-separated";
  if (path === "sending.windowHours") return windowHours(value) ? null : "use whole hours as start-end with start before end, for example 8-15";
  const max = CONFIG_MAX[path] ?? 300;
  return value.length <= max ? null : `keep it to ${max} characters`;
}

function windowDays(value: string): string[] | null {
  const days = value.split(",").map((d) => d.trim().toUpperCase()).filter((d) => d !== "");
  return days.length > 0 && days.every((d) => WEEKDAYS.includes(d)) ? [...new Set(days)] : null;
}

function windowHours(value: string): { start: number; end: number } | null {
  const m = HOURS.exec(value);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  return start >= 0 && start <= 23 && end >= 1 && end <= 24 && start < end ? { start, end } : null;
}

/** Why a brain answer cannot be used, by the brain's own rules, or null. */
function brainProblem(target: Extract<QuestionTarget, { kind: "brain" }>, value: string): string | null {
  const schema = (COMPONENT_SCHEMAS[target.component].shape as Record<string, FieldSchema>)[target.field];
  if (!schema) return "not a field of this component";
  const result = schema.safeParse(coerceFields(target.component, { [target.field]: value })[target.field]);
  if (!result.success) return result.error?.issues[0]?.message ?? "not valid";
  if (!(URL_FIELDS[target.component] ?? []).includes(target.field) && URL_PATTERN.test(value)) return "links go only in the proof's link answer";
  if (PRICE_PATTERN.test(value)) return "prices go in commercial.md, which init does not write";
  // A never list is enforced by account key: a name that is not a domain would silently stop nothing.
  if (target.component === "icp" && target.field === "domains") {
    const bad = value.split(",").map((d) => d.trim().toLowerCase()).filter((d) => d !== "" && !DOMAIN.test(d));
    if (bad.length > 0) return `use domains such as initech.example, not names (${bad.slice(0, 3).join(", ")})`;
  }
  return null;
}

/** Why an answer cannot be used, or null. A blank answer is a skip, never a problem. */
export function answerProblem(question: InitQuestion, raw: string, earlier: Answers = {}): string | null {
  const value = raw.replace(/\s+/g, " ").trim();
  if (value === "") return null;
  if (SKIP_WORDS.test(value)) return "leave it blank to skip; nothing is written in its place";
  if (DASHES.test(value)) return "no em or en dashes: use a comma, a period, a colon or parentheses";
  return question.target.kind === "config" ? configProblem(question.target.path, value, earlier) : brainProblem(question.target, value);
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let at = obj;
  for (const key of keys.slice(0, -1)) {
    at[key] ??= {};
    at = at[key] as Record<string, unknown>;
  }
  at[keys[keys.length - 1] ?? ""] = value;
}

/** The gtm.config.ts values the answers give, well-formed ones only. sending.domain is the sender address's domain. */
export function configFromAnswers(answers: Answers): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const q of BRAIN_INIT_QUESTIONS) {
    if (q.target.kind !== "config") continue;
    const value = (answers[q.id] ?? "").replace(/\s+/g, " ").trim();
    if (value === "" || configProblem(q.target.path, value, answers)) continue;
    const typed = q.target.path === "sending.windowDays" ? windowDays(value) : q.target.path === "sending.windowHours" ? windowHours(value) : value;
    setPath(out, q.target.path, typed);
    if (q.target.path === "sending.from.email") setPath(out, "sending.domain", value.slice(value.lastIndexOf("@") + 1).toLowerCase());
  }
  return out;
}

/** The snippet to paste into gtm.config.ts, or null when no config question was answered. */
function renderSnippet(values: Record<string, unknown>): string | null {
  if (Object.keys(values).length === 0) return null;
  const lines: string[] = [];
  const write = (obj: Record<string, unknown>, indent: string) => {
    for (const [key, value] of Object.entries(obj)) {
      if (Array.isArray(value)) lines.push(`${indent}${key}: [${value.map((v) => JSON.stringify(v)).join(", ")}],`);
      else if (key === "windowHours" && value && typeof value === "object") {
        const h = value as { start: number; end: number };
        lines.push(`${indent}${key}: { start: ${h.start}, end: ${h.end} },`);
      } else if (value && typeof value === "object") {
        lines.push(`${indent}${key}: {`);
        write(value as Record<string, unknown>, `${indent}  `);
        lines.push(`${indent}},`);
      } else lines.push(`${indent}${key}: ${JSON.stringify(value)},`);
    }
  };
  write(values, "  ");
  return lines.join("\n");
}

interface Draft {
  files: Array<{ component: ComponentId; content: string }>;
  notWritten: ComponentId[];
  leftAlone: ComponentId[];
  notes: string[];
}

/** The draft files the answers give, skipping what was not answered. Pure. */
export function draftBrain(answers: Answers, existing: ReadonlySet<string>, today: string): Draft {
  const value = (id: string) => (answers[id] ?? "").replace(/\s+/g, " ").trim();
  const components: ComponentId[] = [];
  const itemsBy = new Map<ComponentId, Map<string, Record<string, string>>>();
  for (const q of BRAIN_INIT_QUESTIONS) {
    if (q.target.kind !== "brain") continue;
    const { component, item, field } = q.target;
    if (!components.includes(component)) components.push(component);
    const items = itemsBy.get(component) ?? new Map<string, Record<string, string>>();
    itemsBy.set(component, items);
    const fields = items.get(item) ?? { ...(FIXED[`${component}/${item}`] ?? {}) };
    items.set(item, fields);
    const v = value(q.id);
    if (v !== "") fields[field] = v;
  }
  const notes: string[] = [];
  const answeredFields = (component: ComponentId, item: string) => Object.keys(itemsBy.get(component)?.get(item) ?? {}).filter((k) => !(k in (FIXED[`${component}/${item}`] ?? {})));

  // ICP: skipped questions are unknown, once anything about the ICP was answered. never needs a list.
  const icp = itemsBy.get("icp");
  if (icp) {
    const anyIcp = [...icp.keys()].some((item) => answeredFields("icp", item).length > 0);
    for (const item of ["who", "must-have", "why-now"]) {
      const fields = icp.get(item);
      if (anyIcp && fields && !fields.text) Object.assign(fields, { kind: "unknown", text: ICP_UNKNOWN[item] ?? "Not answered yet." });
    }
    const never = icp.get("never");
    if (never && (never.domains || never.titles) && !never.text) never.text = NEVER_REASON;
    if (never && !never.domains && !never.titles) {
      if (never.text) notes.push("icp never: not written; it needs a domain or a title list.");
      icp.delete("never");
    }
  }
  // Facts: only with the claim. No pillar is tied to it here: that would say the result backs up the
  // pillar, which nobody answered. The person adds the reference.
  if (itemsBy.get("facts")?.get(FACT_ID)?.text && !existing.has("facts") && [...(itemsBy.get("message-pillars")?.values() ?? [])].some((f) => f.text))
    notes.push(`To tie the customer result to the pillar it backs up, add "- proof: ${FACT_ID}" to that pillar in message-pillars.md.`);
  for (const pillar of ["problem", "difference"]) {
    const text = itemsBy.get("message-pillars")?.get(pillar)?.text;
    if (text && FIGURE.test(text)) notes.push(`WARN message-pillars ${pillar === "problem" ? "pain" : "difference"}: this answer holds a figure. A writer states figures only from facts, so put it in the proof answers.`);
  }

  const files: Draft["files"] = [];
  const notWritten: ComponentId[] = [];
  const leftAlone: ComponentId[] = [];
  for (const component of components) {
    const items: BrainItemInput[] = [];
    for (const [id, fields] of itemsBy.get(component) ?? []) {
      const answered = answeredFields(component, id);
      if (answered.length === 0 && !(component === "icp" && fields.kind === "unknown")) continue;
      const parsed = (COMPONENT_SCHEMAS[component] as unknown as FieldSchema).safeParse(coerceFields(component, fields));
      if (!parsed.success) {
        notes.push(`${component} ${id}: incomplete, not written (${parsed.error?.issues[0]?.message ?? "a required answer is missing"}).`);
        continue;
      }
      items.push({ id, fields });
    }
    if (items.length === 0) notWritten.push(component);
    else if (existing.has(component)) leftAlone.push(component);
    else files.push({ component, content: renderBrainFile({ component, status: "draft", version: 1, updated: today, items }) });
  }
  return { files, notWritten, leftAlone, notes };
}

/** Read and check an answers file. Returns the answers, or the problems that stop the command. */
function readAnswers(path: string): { answers: Answers } | { problems: string[] } {
  if (!existsSync(path) || !statSync(path).isFile()) return { problems: [`${path} is not a file`] };
  if (statSync(path).size > MAX_ANSWERS_BYTES) return { problems: [`${path} is over ${MAX_ANSWERS_BYTES / 1024} KB`] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { problems: [`${path} is not valid JSON: ${(error as Error).message}`] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { problems: [`${path} must hold one object of "<question id>": "<answer>"`] };
  const byId = new Map(BRAIN_INIT_QUESTIONS.map((q) => [q.id, q]));
  const problems: string[] = [];
  const answers: Answers = {};
  const given: Answers = Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const question = byId.get(id);
    if (!question) {
      problems.push(`${id}: not a question (gtm brain init --questions lists them)`);
      continue;
    }
    if (typeof value !== "string") {
      problems.push(`${id}: the answer must be text`);
      continue;
    }
    const problem = answerProblem(question, value, given);
    if (problem) problems.push(`${id}: ${problem}`);
    else answers[id] = value;
  }
  return problems.length > 0 ? { problems } : { answers };
}

/** Ask every question on the terminal, again when an answer is invalid. A blank answer skips. Null when the person stopped it (Ctrl-D, Ctrl-C). */
async function interview(io: Io & { ask(question: string): Promise<string> }): Promise<Answers | null> {
  const answers: Answers = {};
  const say = (...lines: string[]) => lines.forEach((l) => io.out(l));
  for (const batch of BRAIN_INIT_BATCHES) {
    say("", `${batch.number}. ${batch.title}`, batch.intro);
    for (const q of BRAIN_INIT_QUESTIONS.filter((x) => x.batch === batch.number)) {
      if (q.help) io.out(`   ${q.help}`);
      for (;;) {
        let answer: string;
        try {
          answer = await io.ask(`${q.prompt} (blank to skip)`);
        } catch {
          return null;
        }
        const problem = answerProblem(q, answer, answers);
        if (!problem) {
          if (answer.trim() !== "") answers[q.id] = answer;
          break;
        }
        io.out(`   Not used: ${problem}. Try again, or leave it blank to skip.`);
      }
    }
  }
  return answers;
}

export interface BrainInitOptions {
  /** Today's date for the files' `updated` field. Tests set it. */
  now?: () => Date;
  /** Validates the folder once the files are written: `gtm brain validate <dir>`. */
  validate: (dir: string) => Promise<number>;
}

export async function brainInit(args: string[], io: Io, options: BrainInitOptions): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { answers: { type: "string" }, questions: { type: "boolean", default: false } } });
  } catch (err) {
    io.err(`gtm brain init: ${(err as Error).message}`);
    io.err(USAGE);
    return EXIT.usage;
  }
  if (parsed.values.questions) {
    const batches = BRAIN_INIT_BATCHES.map((b) => ({
      ...b,
      questions: BRAIN_INIT_QUESTIONS.filter((q) => q.batch === b.number).map((q) => ({
        id: q.id,
        prompt: q.prompt,
        ...(q.help ? { help: q.help } : {}),
        writes: q.target.kind === "config" ? `gtm.config.ts ${q.target.path}` : `${q.target.component}.md ${q.target.item}.${q.target.field}`,
      })),
    }));
    io.out(JSON.stringify({ batches }, null, 2));
    return EXIT.ok;
  }

  const { brainDir } = locateBrain(io.cwd, parsed.positionals[0], undefined);
  const say = (...lines: string[]) => lines.forEach((l) => io.out(l));
  const show = (p: string) => relative(io.cwd, p) || ".";
  if (existsSync(brainDir) && !statSync(brainDir).isDirectory()) {
    io.err(`gtm brain init: ${show(brainDir)} is not a directory`);
    return EXIT.usage;
  }
  const existingFiles = existsSync(brainDir) ? readFlatDir(brainDir) : [];
  // Lowercased: on a case-insensitive file system Voice.md is voice.md.
  const existing = new Set(existingFiles.filter((f) => f.name.toLowerCase().endsWith(".md")).map((f) => f.name.slice(0, -3).toLowerCase()));
  let answers: Answers;
  if (parsed.values.answers !== undefined) {
    const read = readAnswers(resolve(io.cwd, parsed.values.answers));
    if ("problems" in read) {
      for (const p of read.problems) io.err(`gtm brain init: ${p}`);
      io.err("gtm brain init: nothing was written. Fix the answers and run it again.");
      return EXIT.usage;
    }
    answers = read.answers;
  } else if (io.ask) {
    io.out(`gtm brain init: a short interview for a draft brain in ${show(brainDir)}. Leave anything you are unsure of blank.`);
    const kept = BRAIN_INIT_QUESTIONS.flatMap((q) => (q.target.kind === "brain" && existing.has(q.target.component) ? [q.target.component] : []));
    if (kept.length > 0) io.out(`Already in the folder, and left alone whatever you answer: ${[...new Set(kept)].join(", ")}.`);
    const asked = await interview(io as Io & { ask(question: string): Promise<string> });
    if (!asked) {
      io.err("gtm brain init: the interview was stopped; nothing was written.");
      return EXIT.usage;
    }
    answers = asked;
  } else {
    io.err("gtm brain init: there is no terminal to ask on; pass the answers with --answers <file.json> (gtm brain init --questions lists them)");
    return EXIT.usage;
  }

  const draft = draftBrain(answers, existing, (options.now?.() ?? new Date()).toISOString().slice(0, 10));

  // The whole set must validate with what is already in the folder before anything is written.
  const names = new Set(draft.files.map((f) => `${f.component}.md`));
  const check = await validateBrain([...existingFiles.filter((f) => !names.has(f.name.toLowerCase())), ...draft.files.map((f) => ({ name: `${f.component}.md`, content: f.content }))]);
  const errors = check.issues.filter((i) => i.severity === "error" && names.has(i.file));
  if (errors.length > 0) {
    for (const e of errors) io.err(`ERROR ${e.file}${e.line ? `:${e.line}` : ""}  ${e.message}`);
    io.err("gtm brain init: nothing was written.");
    return EXIT.failed;
  }

  mkdirSync(brainDir, { recursive: true });
  // wx: a file that appeared since the folder was read is left alone, never overwritten.
  const written: typeof draft.files = [];
  for (const f of draft.files) {
    try {
      writeFileSync(join(brainDir, `${f.component}.md`), f.content, { flag: "wx" });
      written.push(f);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      draft.leftAlone.push(f.component);
    }
  }
  draft.files = written;
  io.out("");
  if (draft.files.length > 0) io.out(`Wrote (status: draft): ${draft.files.map((f) => show(join(brainDir, `${f.component}.md`))).join(", ")}`);
  if (draft.leftAlone.length > 0) io.out(`Left alone (already there): ${draft.leftAlone.join(", ")}`);
  if (draft.notWritten.length > 0) io.out(`Not written (no answers): ${draft.notWritten.join(", ")}. Tasks report them as missing until you write them.`);
  for (const note of draft.notes) io.out(note);

  const snippet = renderSnippet(configFromAnswers(answers));
  if (snippet) say("", "Put these in gtm.config.ts (only what you answered), then check it with npx gtm doctor:", snippet);

  io.out("");
  const code = await options.validate(brainDir);
  say(
    "",
    "Next:",
    "  1. Read each file and correct it. Write the components init does not cover from docs/BRAIN-SCHEMA.md.",
    "  2. Set status: approved on the files you stand behind, then run npx gtm brain validate --write-lock.",
    "  3. Upload to staging: npx gtm brain upload --env staging.",
    "  To draft product and ICP from your website, use the dashboard's Product and ICP page (docs/TARGETING.md), then npx gtm brain pull.",
  );
  return code;
}
