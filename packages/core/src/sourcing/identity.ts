// GTM-agents: identity rules for sourced people: names, addresses, account names and the never list.
//
// Each check errs toward "not usable". A skipped person costs nothing; an email to a guessed
// address, a role mailbox or a personal inbox costs sender reputation and breaks the work-email
// rule. So:
//   - splitPersonName returns null rather than guess which part of a name is which;
//   - screenAddress accepts only one plain address at the account's own domain, and never a
//     personal mailbox (accountKey returns null for those), a shared host or a role mailbox;
//   - matchNeverList applies the brain's icp `never` items, which are hard stops.
import { accountKey } from "../data/keys.ts";
import { normalizeAddress } from "../sending/suppression.ts";

/** Local parts that reach a team or a function, not one person. Never promoted. */
export const ROLE_MAILBOXES: ReadonlySet<string> = new Set([
  "info", "hello", "hi", "contact", "contactus", "sales", "support", "help", "helpdesk", "admin", "administrator",
  "office", "team", "partners", "partnerships", "careers", "jobs", "recruiting", "hr", "talent", "press", "media",
  "pr", "marketing", "billing", "accounts", "accounting", "finance", "invoices", "legal", "privacy", "security",
  "abuse", "postmaster", "hostmaster", "webmaster", "noreply", "no-reply", "donotreply", "do-not-reply", "mail",
  "enquiries", "inquiries", "investors", "ir", "events", "community", "feedback", "orders", "service", "it",
]);

/** True when the address's local part (ignoring any +tag) names a role, not a person. */
export function isRoleAddress(email: string): boolean {
  const local = email.slice(0, email.lastIndexOf("@")).toLowerCase().split("+")[0] ?? "";
  return ROLE_MAILBOXES.has(local);
}

export type AddressVerdict = "clean" | "malformed" | "personal" | "off_domain" | "role";

export interface AddressScreen {
  verdict: AddressVerdict;
  /** The normalized address, when it parsed. */
  email?: string;
}

/**
 * Free screen before any paid verification. Clean only when the value is exactly one address,
 * at a company domain (not a personal mailbox or shared host), equal to `account`, and not a role
 * mailbox.
 */
export function screenAddress(raw: unknown, account: string): AddressScreen {
  const email = normalizeAddress(raw);
  if (!email) return { verdict: "malformed" };
  const key = accountKey(email);
  if (!key) return { verdict: "personal", email };
  if (key !== account) return { verdict: "off_domain", email };
  if (isRoleAddress(email)) return { verdict: "role", email };
  return { verdict: "clean", email };
}

const HONORIFICS: ReadonlySet<string> = new Set(["mr", "mrs", "ms", "miss", "mx", "dr", "prof", "sir", "dame", "rev"]);
const NAME_SUFFIXES: ReadonlySet<string> = new Set(["jr", "sr", "ii", "iii", "iv", "phd", "md", "mba", "esq", "cpa"]);
// Letters (any script), combining marks, apostrophes, hyphens and periods; nothing that suggests a
// handle, a number or an address.
const NAME_PART = /^[\p{L}\p{M}][\p{L}\p{M}'.-]{0,39}$/u;

export interface PersonName {
  first: string | null;
  last: string | null;
}

/**
 * Split a full name into first and last. Handles "Last, First", honorifics and suffixes. Returns
 * null when the value does not look like a person's name (digits, symbols, one letter, too many
 * words), so the caller skips rather than greets the wrong word. A single word gives a first name
 * only.
 */
export function splitPersonName(raw: unknown): PersonName | null {
  if (typeof raw !== "string") return null;
  let text = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  if (text.length === 0 || text.length > 80) return null;
  let tokens: string[];
  const comma = text.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  if (comma.length === 2 && !NAME_SUFFIXES.has(normalizeToken(comma[1] ?? ""))) {
    // "Doe, Jane" is last, first.
    text = `${comma[1]} ${comma[0]}`;
  } else if (comma.length > 2) {
    return null;
  }
  tokens = text.replace(/,/g, " ").split(" ").filter((t) => t.length > 0);
  while (tokens.length > 0 && HONORIFICS.has(normalizeToken(tokens[0] ?? ""))) tokens = tokens.slice(1);
  while (tokens.length > 0 && NAME_SUFFIXES.has(normalizeToken(tokens.at(-1) ?? ""))) tokens = tokens.slice(0, -1);
  if (tokens.length === 0 || tokens.length > 4) return null;
  if (!tokens.every((t) => NAME_PART.test(t))) return null;
  const first = tokens[0] ?? null;
  if (!first || first.replace(/[.'-]/g, "").length < 2) return null;
  if (tokens.length === 1) return { first, last: null };
  const last = tokens.at(-1) ?? null;
  if (!last || last.replace(/[.'-]/g, "").length < 2) return { first, last: null };
  return { first, last };
}

const normalizeToken = (t: string) => t.toLowerCase().replace(/\./g, "");

const LEGAL_SUFFIXES: ReadonlySet<string> = new Set([
  "inc", "incorporated", "llc", "llp", "lp", "ltd", "limited", "corp", "corporation", "co", "company", "gmbh", "ag",
  "sa", "sas", "sarl", "spa", "plc", "bv", "nv", "pte", "pty", "oy", "ab", "as", "kk",
]);

/**
 * A comparable key for a company name: accents folded, "&" read as "and", dotted initials joined,
 * trailing legal suffixes dropped. Null when nothing identifying is left (a single token under
 * four characters is a fragment, not a name).
 */
export function accountNameKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const parts = raw
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
  const tokens: string[] = [];
  for (const token of parts) {
    const previous = tokens.at(-1);
    // "A.C.M.E." splits into single letters; join them back into one token.
    if (token.length === 1 && previous !== undefined && /^[a-z]+$/.test(previous) && previous.length <= 3 && tokens.length > 0) {
      tokens[tokens.length - 1] = previous + token;
    } else {
      tokens.push(token);
    }
  }
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens.at(-1) ?? "")) tokens.pop();
  if (tokens.length === 0) return null;
  if (tokens.length === 1 && (tokens[0] ?? "").length < 4) return null;
  return tokens.join(" ");
}

/** The brain's hard stops: icp items of kind `never`. */
export interface NeverList {
  /** Account keys. */
  domains: readonly string[];
  /** Company names, matched by accountNameKey containment. */
  accounts: readonly string[];
  /** Title phrases, matched by normalized containment. */
  titles: readonly string[];
}

export const EMPTY_NEVER_LIST: NeverList = Object.freeze({ domains: [], accounts: [], titles: [] });

/** Lowercase words separated by single spaces, for phrase containment checks. */
export function normalizePhrase(text: string): string {
  return ` ${text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
}

/** The reason a person or account is on the never list, or null when it is not. */
export function matchNeverList(never: NeverList, subject: { domain?: string | null; accountName?: string | null; title?: string | null }): string | null {
  const domain = subject.domain ? accountKey(subject.domain) : null;
  if (domain) {
    for (const entry of never.domains) {
      const key = accountKey(entry);
      if (key && key === domain) return `account ${domain} is on the never list`;
    }
  }
  const name = accountNameKey(subject.accountName);
  if (name) {
    for (const entry of never.accounts) {
      const key = accountNameKey(entry);
      if (key && normalizePhrase(name).includes(normalizePhrase(key))) return "the company name is on the never list";
    }
  }
  if (subject.title) {
    const title = normalizePhrase(subject.title);
    for (const entry of never.titles) {
      const phrase = normalizePhrase(entry);
      if (phrase.trim().length > 0 && title.includes(phrase)) return "the title is on the never list";
    }
  }
  return null;
}
