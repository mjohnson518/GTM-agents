// GTM-agents: the sending-domain DNS preflight for `gtm doctor --remote`: TXT lookups over Cloudflare's
// JSON DNS, and the SPF, DKIM and DMARC checks on the isolated sending subdomain. The checks only
// report; nothing here holds a send. A lookup that cannot be made is a WARN, never a PASS or a FAIL,
// so doctor stays usable offline. A DKIM selector is never guessed: without sending.dkimSelector the
// DKIM check says how to enable it.
import type { Check } from "../commands/doctor.ts";

/** The part of `fetch` the lookups use, so tests can answer from recorded responses. */
export type DnsFetch = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** A TXT lookup: the records found (possibly none), or why the lookup could not be made. */
export type TxtLookup = { ok: true; records: string[] } | { ok: false; error: string };

const DOH_URL = "https://cloudflare-dns.com/dns-query";
const TXT = 16;
const TIMEOUT_MS = 5_000;

/** Join a TXT record's quoted segments ("a" "b" is "ab") and unescape them. Unquoted data is kept as is. */
function txtData(data: string): string {
  const segments = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] ?? "").replace(/\\(.)/g, "$1"));
  return segments.length ? segments.join("") : data.trim();
}

/**
 * The TXT records at `name`. A DNS status other than NOERROR (NXDOMAIN, for one) means no records;
 * a network error, a non-200 answer or a body that is not a DNS JSON answer means unreadable.
 */
export async function resolveTxt(name: string, fetch: DnsFetch): Promise<TxtLookup> {
  const url = `${DOH_URL}?${new URLSearchParams({ name, type: "TXT" }).toString()}`;
  let body: unknown;
  try {
    const res = await fetch(url, { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, error: `DNS over HTTPS answered ${res.status}` };
    body = await res.json();
  } catch (err) {
    return { ok: false, error: (err as Error).message || "network error" };
  }
  if (!body || typeof body !== "object") return { ok: false, error: "the DNS answer was not JSON" };
  const { Status, Answer } = body as { Status?: unknown; Answer?: unknown };
  if (typeof Status !== "number") return { ok: false, error: "the DNS answer had no status" };
  if (Status !== 0) return { ok: true, records: [] };
  if (Answer === undefined) return { ok: true, records: [] };
  if (!Array.isArray(Answer)) return { ok: false, error: "the DNS answer was malformed" };
  const records = (Answer as Array<{ type?: unknown; data?: unknown }>)
    .filter((a) => a && a.type === TXT && typeof a.data === "string")
    .map((a) => txtData(a.data as string));
  return { ok: true, records };
}

const unresolved = (name: string, what: string, lookup: { error: string }): Check => ({
  status: "WARN",
  name,
  detail: `could not resolve ${what} (${lookup.error}); check it again with a working connection`,
});

/** SPF on the sending domain: exactly one v=spf1 record, and not one that authorizes everyone. */
export function spfCheck(lookup: TxtLookup, domain: string): Check {
  if (!lookup.ok) return unresolved("SPF", domain, lookup);
  const spf = lookup.records.filter((r) => /^v=spf1(\s|$)/i.test(r.trim()));
  if (spf.length === 0) return { status: "FAIL", name: "SPF", detail: `no SPF record at ${domain}; add the TXT record your email provider gives you` };
  if (spf.length > 1) return { status: "FAIL", name: "SPF", detail: `${spf.length} SPF records at ${domain}; receivers treat that as an error, so merge them into one` };
  const record = (spf[0] ?? "").trim();
  const all = record.split(/\s+/).find((t) => /^[+\-~?]?all$/i.test(t));
  if (all && /^\+all$/i.test(all)) return { status: "FAIL", name: "SPF", detail: `${domain} ends in +all, which lets anyone send as the domain; use -all or ~all` };
  if (all && /^\?all$/i.test(all)) return { status: "WARN", name: "SPF", detail: `${domain} ends in ?all, which asserts nothing about other senders; use -all or ~all` };
  return { status: "PASS", name: "SPF", detail: `${domain}: ${record.slice(0, 160)}` };
}

/** DMARC at _dmarc.<domain>: present, one record, and a policy that is enforced. */
export function dmarcCheck(lookup: TxtLookup, domain: string): Check {
  const at = `_dmarc.${domain}`;
  if (!lookup.ok) return unresolved("DMARC", at, lookup);
  const dmarc = lookup.records.filter((r) => /^v=DMARC1\s*(;|$)/i.test(r.trim()));
  if (dmarc.length === 0) return { status: "FAIL", name: "DMARC", detail: `no DMARC record at ${at}; add one, for example v=DMARC1; p=none; rua=mailto:<a reporting address>` };
  if (dmarc.length > 1) return { status: "FAIL", name: "DMARC", detail: `${dmarc.length} DMARC records at ${at}; receivers ignore all of them, so keep one` };
  const tags = new Map(
    (dmarc[0] ?? "").split(";").map((part) => {
      const eq = part.indexOf("=");
      return [part.slice(0, eq === -1 ? undefined : eq).trim().toLowerCase(), eq === -1 ? "" : part.slice(eq + 1).trim().toLowerCase()] as const;
    }),
  );
  const policy = tags.get("p");
  if (policy === "quarantine" || policy === "reject") return { status: "PASS", name: "DMARC", detail: `${at}: p=${policy}` };
  if (policy === "none") return { status: "WARN", name: "DMARC", detail: `${at}: p=none only monitors; move to p=quarantine once the reports look clean` };
  return { status: "FAIL", name: "DMARC", detail: `${at} has ${policy ? `an unknown policy p=${policy}` : "no p= policy"}; set p=none, p=quarantine or p=reject` };
}

/** DKIM at <selector>._domainkey.<domain>, when a selector is configured. */
export function dkimCheck(lookup: TxtLookup | undefined, domain: string, selector: string | undefined): Check {
  if (!selector) return { status: "INFO", name: "DKIM", detail: "set sending.dkimSelector in gtm.config.ts (the selector your email provider gives you) to check DKIM" };
  const at = `${selector}._domainkey.${domain}`;
  if (!lookup || !lookup.ok) return unresolved("DKIM", at, lookup ?? { error: "no lookup was made" });
  const keys = lookup.records.map((r) => r.trim()).filter((r) => /(^|;)\s*p=/i.test(r));
  if (keys.length === 0) return { status: "FAIL", name: "DKIM", detail: `no DKIM key at ${at}; add the record your email provider gives you, or correct sending.dkimSelector` };
  const published = keys.find((r) => /(^|;)\s*p=[^;\s]/i.test(r));
  if (!published) return { status: "FAIL", name: "DKIM", detail: `the DKIM key at ${at} is revoked (empty p=); publish the current key` };
  return { status: "PASS", name: "DKIM", detail: `${at} publishes a key` };
}

/** The sending domain is a subdomain of the company domain (the config schema already insists on it). */
export function domainSeparationCheck(sendingDomain: string, companyDomain: string): Check {
  if (sendingDomain === companyDomain || !sendingDomain.endsWith(`.${companyDomain}`)) {
    return { status: "WARN", name: "sending domain", detail: `cold mail goes from ${sendingDomain}; use an isolated subdomain of ${companyDomain}, so the primary domain's reputation stays protected` };
  }
  return { status: "INFO", name: "sending domain", detail: `cold mail goes from ${sendingDomain}, a subdomain of ${companyDomain}` };
}

/** Every DNS check for the sending domain, with the lookups made in parallel. */
export async function dnsChecks(sendingDomain: string, companyDomain: string, dkimSelector: string | undefined, fetch: DnsFetch): Promise<Check[]> {
  const [spf, dmarc, dkim] = await Promise.all([
    resolveTxt(sendingDomain, fetch),
    resolveTxt(`_dmarc.${sendingDomain}`, fetch),
    dkimSelector ? resolveTxt(`${dkimSelector}._domainkey.${sendingDomain}`, fetch) : Promise.resolve(undefined),
  ]);
  return [domainSeparationCheck(sendingDomain, companyDomain), spfCheck(spf, sendingDomain), dkimCheck(dkim, sendingDomain, dkimSelector), dmarcCheck(dmarc, sendingDomain)];
}
