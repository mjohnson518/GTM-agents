// GTM-agents: the deterministic quality gate: the checks every outbound message passes before it
// may leave without a person reading it.
//
// It is pure and needs no network. Text is normalized (NFKC) before checking. Each finding has a
// code and a severity:
//   - block: the message is never created or sent (the lint's blocks, a recipient who is not the
//     contact the copy was written for, an account name the identity rules reject);
//   - hold: a person decides (the lint's warnings, an impersonal greeting, a fallback such as "your
//     company" while the name is known, a link that is not allowed, an unapproved claim, a length
//     out of bounds for the kind, a long subject, a cold intro with no question, exclamations).
// The verdict is the worst severity found, and the score (100, minus 40 per block and 15 per hold)
// is for trend reports only. The model reviewer (reviewer.ts) adds its verdict on top with
// withReview. The gate never rewrites copy; it reports.
import { WORD_BOUNDS, SUBJECT_MAX, type TemplateKind } from "../templates/schema.ts";
import { countWords } from "../templates/variables.ts";
import { accountNameKey } from "../sourcing/identity.ts";
import { checkClaims } from "./claims.ts";
import { lintOutbound } from "./lint.ts";

export type QualityVerdict = "pass" | "hold" | "block";
export type FindingSeverity = "block" | "hold";
/** What is being checked: a template kind, or a reply. */
export type QualityKind = TemplateKind | "reply";

export interface QualityFinding {
  code: string;
  severity: FindingSeverity;
  detail: string;
}

export interface QualityResult {
  verdict: QualityVerdict;
  /** 100, minus 40 per block and 15 per hold, floored at 0. For trend reports only. */
  score: number;
  findings: QualityFinding[];
}

/** Every code the gate and the composer can report, with its severity. docs/OUTREACH.md lists them. */
export const QUALITY_CODES = Object.freeze({
  LINT_EMPTY_SUBJECT: "block",
  LINT_EMPTY_BODY: "block",
  LINT_HIDDEN_CHARACTER: "block",
  LINT_HOUSE_RULE_CHARACTER: "block",
  LINT_PLACEHOLDER_LEAK: "block",
  LINT_URL_SHORTENER: "block",
  LINT_HTML: "block",
  RECIPIENT_MISMATCH: "block",
  UNUSABLE_ACCOUNT_NAME: "block",
  SUBJECT_LINE_BREAK: "block",
  LINT_SPAM_PHRASE: "hold",
  LINT_SUBJECT_CAPS: "hold",
  LINT_SUBJECT_PUNCTUATION: "hold",
  GREETING_NOT_PERSONAL: "hold",
  ACCOUNT_FALLBACK_USED: "hold",
  LINK_NOT_ALLOWED: "hold",
  UNAPPROVED_CLAIM: "hold",
  TOO_SHORT: "hold",
  TOO_LONG: "hold",
  SUBJECT_TOO_LONG: "hold",
  NO_QUESTION: "hold",
  EXCLAMATIONS: "hold",
  MISSING_VARIABLE: "hold",
  NO_TEMPLATE: "hold",
  PER_DRAFT_REVIEW: "hold",
  REVIEW_UNAVAILABLE: "hold",
  REVIEW_FAILED: "hold",
} satisfies Record<string, FindingSeverity>);
export type QualityCode = keyof typeof QUALITY_CODES;

/** Word bounds for replies, which are not a template kind. */
export const REPLY_WORD_BOUNDS = Object.freeze({ min: 8, max: 160 });

export interface QualityContact {
  /** The contact's address, as stored. */
  email: string | null;
  firstName: string | null;
  accountName: string | null;
  accountKey: string | null;
}

export interface LinkPolicy {
  /** Domains whose host and subdomains may be linked: the company's domain and the app host. */
  domains: readonly string[];
  /** URLs that may be linked exactly as written: the booking URL. */
  exactUrls: readonly string[];
}

export interface QualityInput {
  kind: QualityKind;
  subject: string;
  body: string;
  /** The address the message will be sent to. */
  recipient: string;
  /** The contact the copy was written for. Required for the recipient and personalization checks. */
  contact?: QualityContact;
  links: LinkPolicy;
  /** Approved text the copy's figures and claims must come from. Omitted, the claims check does not run. */
  claimSources?: readonly string[];
}

// Lint warnings the gate checks more precisely itself (exclamations, and length by kind).
const LINT_COVERED = new Set(["EXCLAMATIONS", "BODY_TOO_LONG"]);

const LINK = /\bhttps?:\/\/[^\s<>()"']+|\bwww\.[^\s<>()"']+/gi;
// A bare host a mail client may turn into a link ("evil.example/offer"), not part of an address or a URL.
const BARE_HOST = /(?<![@\w./-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?:\/[^\s<>()"']*)?(?![\w@-])/gi;

/** Phrases a writer falls back on when it does not know the company's name. */
const ACCOUNT_FALLBACK = /\byour (?:company|firm|organi[sz]ation|business|startup|employer)\b/i;

const NAME_CHARS = /^[\p{L}][\p{L}\p{M}'. -]*$/u;

/**
 * A first name fit to greet someone with, or null. A value with digits, an address, markup or a
 * single letter is not a name, and the composer holds the draft rather than greet a guess.
 */
export function usableFirstName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 40 || !NAME_CHARS.test(name)) return null;
  return name;
}

/**
 * True when a company name is fit to appear in copy: it has an identifying name key (not a lone
 * fragment or a legal suffix), or it is a short name its own account domain backs (a name "GV" for
 * the account gv.example). A name that holds an address, a URL or control characters never is.
 */
export function isUsableAccountName(name: string | null | undefined, accountKey?: string | null): boolean {
  if (typeof name !== "string") return false;
  const value = name.normalize("NFKC").trim();
  // eslint-disable-next-line no-control-regex -- control characters are what this rejects
  if (value === "" || value.length > 80 || /[@<>{}]|:\/\/|[\x00-\x1f\x7f]/.test(value)) return false;
  if (accountNameKey(value) !== null) return true;
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const label = (accountKey ?? "").split(".")[0] ?? "";
  return compact.length >= 2 && compact === label;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function mentions(text: string, phrase: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url.toLowerCase().startsWith("www.") ? `https://${url}` : url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** The host of a configured URL or domain, without www., or null. */
export function hostFromConfig(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.includes("://") ? hostOf(value) : value.toLowerCase().replace(/^www\./, "");
}

function linkAllowed(url: string, policy: LinkPolicy): boolean {
  const bare = url.replace(/\/$/, "");
  if (policy.exactUrls.some((u) => u === url || u.replace(/\/$/, "") === bare)) return true;
  const host = hostOf(url);
  if (!host) return false;
  return policy.domains.some((d) => {
    const domain = d.toLowerCase().replace(/^www\./, "");
    return domain !== "" && (host === domain || host.endsWith(`.${domain}`));
  });
}

/** A single plain address, ASCII letters lowercased and spaces trimmed. Null for anything else. */
function plainAddress(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/^ +| +$/g, "");
  if (!/^[^\s@<>,;"]+@[^\s@<>,;"]+$/.test(trimmed)) return null;
  return trimmed.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function verdictOf(findings: readonly QualityFinding[]): QualityResult {
  const blocks = findings.filter((f) => f.severity === "block").length;
  const holds = findings.length - blocks;
  return {
    verdict: blocks > 0 ? "block" : holds > 0 ? "hold" : "pass",
    score: Math.max(0, 100 - 40 * blocks - 15 * holds),
    findings: [...findings],
  };
}

/** Run every deterministic check. Pure; findings come in the order checked. */
export function checkOutboundQuality(input: QualityInput): QualityResult {
  const findings: QualityFinding[] = [];
  const add = (code: QualityCode, detail: string) => findings.push({ code, severity: QUALITY_CODES[code], detail });
  const subject = (input.subject ?? "").normalize("NFKC");
  const body = (input.body ?? "").normalize("NFKC");
  const all = `${subject}\n${body}`;

  const lint = lintOutbound({ subject, body });
  for (const f of lint.blocks) findings.push({ code: `LINT_${f.code}`, severity: "block", detail: f.detail });
  for (const f of lint.warnings) if (!LINT_COVERED.has(f.code)) findings.push({ code: `LINT_${f.code}`, severity: "hold", detail: f.detail });

  if (input.contact) {
    const to = plainAddress(input.recipient);
    const expected = plainAddress(input.contact.email);
    if (!to || !expected || to !== expected) add("RECIPIENT_MISMATCH", "the recipient is not the contact this copy was written for");

    const accountName = input.contact.accountName?.normalize("NFKC").trim() ?? "";
    const usable = isUsableAccountName(accountName, input.contact.accountKey);
    if (accountName !== "" && !usable && mentions(all, accountName)) {
      add("UNUSABLE_ACCOUNT_NAME", `the copy names "${accountName.slice(0, 40)}", which is not a usable company name`);
    }
    if (usable && ACCOUNT_FALLBACK.test(all) && !mentions(all, accountName)) {
      add("ACCOUNT_FALLBACK_USED", `the copy falls back on a generic phrase although the company name (${accountName.slice(0, 40)}) is known`);
    }

    if (input.kind !== "reply") {
      const name = usableFirstName(input.contact.firstName);
      const opening = body.split("\n").find((line) => line.trim() !== "") ?? "";
      if (!name) add("GREETING_NOT_PERSONAL", "the contact's first name is unknown, so the greeting cannot be personal");
      else if (!mentions(opening, name)) add("GREETING_NOT_PERSONAL", `the greeting does not use the contact's first name (${name})`);
    }
  }

  if (/[\r\n]/.test(input.subject ?? "")) add("SUBJECT_LINE_BREAK", "the subject holds a line break");
  for (const raw of all.match(LINK) ?? []) {
    const url = raw.replace(/[.,;:!?)\]]+$/, "");
    if (!linkAllowed(url, input.links)) add("LINK_NOT_ALLOWED", `a link to ${hostOf(url) ?? url.slice(0, 40)} is not allowed`);
  }
  for (const raw of all.replace(LINK, " ").match(BARE_HOST) ?? []) {
    const url = `https://${raw.replace(/[.,;:!?)\]]+$/, "")}`;
    if (!linkAllowed(url, input.links)) add("LINK_NOT_ALLOWED", `a bare link to ${hostOf(url) ?? raw.slice(0, 40)} is not allowed`);
  }

  if (input.claimSources) {
    const claims = checkClaims(all, input.claimSources);
    if (!claims.ok) add("UNAPPROVED_CLAIM", `the copy states "${claims.token}", which no approved source contains`);
  }

  const bounds = input.kind === "reply" ? REPLY_WORD_BOUNDS : WORD_BOUNDS[input.kind];
  const words = countWords(body);
  if (bounds && words < bounds.min) add("TOO_SHORT", `the body has ${words} words; ${input.kind} needs at least ${bounds.min}`);
  if (bounds && words > bounds.max) add("TOO_LONG", `the body has ${words} words; ${input.kind} allows at most ${bounds.max}`);
  if (subject.length > SUBJECT_MAX) add("SUBJECT_TOO_LONG", `the subject has ${subject.length} characters; the limit is ${SUBJECT_MAX}`);
  if (input.kind === "cold_intro" && !body.includes("?")) add("NO_QUESTION", "a cold intro asks the reader something");
  const exclamations = (all.match(/!/g) ?? []).length;
  if (exclamations > 1) add("EXCLAMATIONS", `${exclamations} exclamation marks; at most one`);

  return verdictOf(findings);
}

/** A finding the composer reports when it cannot build copy at all (a missing variable, no template). */
export function heldResult(code: Extract<QualityCode, "MISSING_VARIABLE" | "NO_TEMPLATE">, detail: string): QualityResult {
  return verdictOf([{ code, severity: QUALITY_CODES[code], detail }]);
}

/** Add a finding to a result and recompute its verdict and score. */
export function withFinding(result: QualityResult, code: QualityCode, detail: string): QualityResult {
  return verdictOf([...result.findings, { code, severity: QUALITY_CODES[code], detail }]);
}

/** One line for operator messages: "38 pass, 2 held, 0 blocked; most common: GREETING_NOT_PERSONAL (2)". */
export function summarizeQuality(results: readonly QualityResult[]): string {
  const pass = results.filter((r) => r.verdict === "pass").length;
  const hold = results.filter((r) => r.verdict === "hold").length;
  const block = results.filter((r) => r.verdict === "block").length;
  const counts = new Map<string, number>();
  for (const r of results) for (const code of new Set(r.findings.map((f) => f.code))) counts.set(code, (counts.get(code) ?? 0) + 1);
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 3)
    .map(([code, n]) => `${code} (${n})`)
    .join(", ");
  return `${pass} pass, ${hold} held, ${block} blocked${top ? `; most common: ${top}` : ""}`;
}
