// GTM-agents: is the sender of an inbound message who the From address says, as far as the
// receiving mailbox could tell? Automatic replies require it (auto-send-rules.ts, rule 7), so a
// forged From cannot make the system mail the real contact.
//
// The evidence is the Authentication-Results header (RFC 8601) the receiving mailbox wrote on top of
// the message. It is untrusted text like every header, so it is read strictly, and anything missing,
// truncated or ambiguous counts as not authenticated:
//   1. the header kept is the first one on the message (inbox intake keeps the first occurrence),
//      which is the one the receiving mailbox prepended. Its authserv-id must be one this deployment
//      trusts for the mailbox the message came through (TRUSTED_AUTHSERV_IDS, by inbox provider). A
//      mailbox with no trusted id (Cloudflare Email Routing, a test double) never authenticates;
//   2. a value with a quoted string, an unbalanced comment, a result that is not `method=result`, a
//      property that is not `ptype.property=value`, or that reaches the stored length limit is
//      refused as ambiguous rather than guessed at;
//   3. any DMARC result other than pass or none refuses;
//   4. it passes only with an aligned pass: DKIM pass whose signing domain (header.d, else the
//      domain of the address in header.i) is the sender's domain, a parent of it or a subdomain of
//      it, or SPF pass whose smtp.mailfrom address has such a domain. Siblings never align.
// Inbox intake keeps this header only whole and only as printable ASCII (inbox/headers.ts), and
// this parser refuses anything else too, so no Unicode space or full-width character can become a
// delimiter after the checks.
import { MAX_HEADER_CHARS } from "../inbox/headers.ts";

/** The authserv-id each inbox provider's receiving servers write. Unknown providers have none. */
export const TRUSTED_AUTHSERV_IDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "inbox-gmail": Object.freeze(["mx.google.com"]),
});

export interface AuthResult {
  method: string;
  result: string;
  props: Readonly<Record<string, string>>;
}

export interface ParsedAuthenticationResults {
  authservId: string;
  results: AuthResult[];
}

/** Remove (comments), nested ones included. Null when they do not balance. */
function stripComments(value: string): string | null {
  let depth = 0;
  let out = "";
  for (const ch of value) {
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth < 0) return null;
      out += " ";
      continue;
    }
    if (depth === 0) out += ch === "(" ? " " : ch;
  }
  return depth === 0 ? out : null;
}

const TOKEN = /^[a-z0-9][a-z0-9.-]*$/;
const RESULT = /^([a-z0-9_-]+)(?:\/\d+)?=([a-z]+)$/;
const PROPERTY = /^([a-z0-9_-]+)\.([a-z0-9_-]+)=(\S+)$/;
const REASON = /^reason=\S+$/;

/** Parse one Authentication-Results value strictly. Null for anything missing or ambiguous. Pure. */
export function parseAuthenticationResults(raw: string | null | undefined): ParsedAuthenticationResults | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  // Plain printable ASCII only, no quoting and no escapes; never normalized, so no character can
  // turn into a delimiter after this check.
  if (value === "" || value.length >= MAX_HEADER_CHARS || !/^[\x20-\x7e]+$/.test(value) || /["\\]/.test(value)) return null;
  const plain = stripComments(value);
  if (plain === null) return null;
  const [head, ...rest] = plain.toLowerCase().split(";");
  const id = (head ?? "").trim().split(/ +/);
  if (id.length < 1 || id.length > 2 || !TOKEN.test(id[0] ?? "") || (id.length === 2 && !/^\d+$/.test(id[1] ?? ""))) return null;
  const results: AuthResult[] = [];
  const segments = rest.map((s) => s.trim()).filter((s) => s !== "");
  if (segments.length === 1 && segments[0] === "none") return { authservId: id[0] ?? "", results };
  for (const segment of segments) {
    const tokens = segment.split(/ +/);
    const first = RESULT.exec(tokens[0] ?? "");
    if (!first) return null;
    const props: Record<string, string> = {};
    for (const token of tokens.slice(1)) {
      if (REASON.test(token)) continue;
      const property = PROPERTY.exec(token);
      if (!property) return null;
      const key = `${property[1] ?? ""}.${property[2] ?? ""}`;
      if (Object.hasOwn(props, key)) return null;
      props[key] = property[3] ?? "";
    }
    results.push({ method: first[1] ?? "", result: first[2] ?? "", props });
  }
  return { authservId: id[0] ?? "", results };
}

const DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** A bare domain, checked and lowercased, or null. */
const asDomain = (value: string | undefined): string | null => {
  const domain = (value ?? "").replace(/\.$/, "").toLowerCase();
  return DOMAIN.test(domain) ? domain : null;
};

/** The domain of something that must be an address: exactly one "@", a local part, a domain. */
const domainOfAddress = (value: string | undefined): string | null => {
  const text = (value ?? "").replace(/^<|>$/g, "");
  const at = text.indexOf("@");
  if (at < 0 || at !== text.lastIndexOf("@")) return null;
  return asDomain(text.slice(at + 1));
};

/** The sender's domain from a plain address or "Name <address>", or null. */
function senderDomain(sender: string | null | undefined): string | null {
  if (typeof sender !== "string") return null;
  const address = (/<([^<>]+)>\s*$/.exec(sender)?.[1] ?? sender).trim();
  return /^[^@\s]+@[^@\s]+$/.test(address) ? domainOfAddress(address) : null;
}

/**
 * Aligned: the same domain, or one is a parent of the other (signing as globex.example for
 * mail.globex.example). Siblings never align, so no public suffix guess (us.com, waw.pl) can make
 * two unrelated registrants look like one.
 */
function aligned(domain: string | null, sender: string): boolean {
  if (!domain) return false;
  return domain === sender || domain.endsWith(`.${sender}`) || sender.endsWith(`.${domain}`);
}

export interface SenderAuthentication {
  ok: boolean;
  reason: string;
  method?: "dkim" | "spf";
}

/** Whether the sender is authenticated, from the stored header. Pure; fails closed. */
export function senderAuthentication(input: { header: string | null | undefined; sender: string | null | undefined; trustedIds: readonly string[] }): SenderAuthentication {
  const no = (reason: string): SenderAuthentication => ({ ok: false, reason });
  const domain = senderDomain(input.sender);
  if (!domain) return no("the sender's address does not parse");
  if (input.trustedIds.length === 0) return no("no receiving server is trusted for the mailbox this came through");
  const parsed = parseAuthenticationResults(input.header);
  if (!parsed) return no("Authentication-Results is missing or ambiguous");
  if (!input.trustedIds.map((t) => t.toLowerCase()).includes(parsed.authservId)) return no(`Authentication-Results is from ${parsed.authservId.slice(0, 60)}, not the receiving mailbox`);
  if (parsed.results.some((r) => r.method === "dmarc" && r.result !== "pass" && r.result !== "none")) return no("DMARC did not pass");
  for (const r of parsed.results) {
    if (r.result !== "pass") continue;
    const signer = r.props["header.d"] !== undefined ? asDomain(r.props["header.d"]) : domainOfAddress(r.props["header.i"]);
    if (r.method === "dkim" && aligned(signer, domain)) return { ok: true, reason: "aligned DKIM pass", method: "dkim" };
    if (r.method === "spf" && aligned(domainOfAddress(r.props["smtp.mailfrom"]), domain)) return { ok: true, reason: "aligned SPF pass", method: "spf" };
  }
  return no("no DKIM or SPF pass aligned with the sender's domain");
}
