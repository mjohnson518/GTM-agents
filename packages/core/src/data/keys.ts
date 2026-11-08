// GTM-agents: the account key.
//
// An account is identified by the lowercased registrable domain of its website or work email:
// "https://www.Acme.example/pricing", "jane@eu.acme.example" and "acme.example" all give
// "acme.example". A personal mailbox domain or a shared host (a free site builder, a code host, a
// social network) is never an account: accountKey returns null for those, and the caller skips
// rather than guesses.
//
// Registrable domains are worked out without the full public suffix list: a country-code domain
// whose second label is a generic one (co, com, net, org, gov, edu, ac, or, ne, go, gob) or one of a
// few listed suffixes keys on three labels (globex.co.uk, initech.com.co); anything else keys on
// two. Set the key explicitly when that is wrong.
import { normalizeAddress } from "../sending/suppression.ts";

const GENERIC_SECOND_LEVELS: ReadonlySet<string> = new Set(["co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob", "ltd", "plc", "me"]);

const TWO_LEVEL_SUFFIXES: ReadonlySet<string> = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk", "me.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "org.nz", "co.jp", "ne.jp", "or.jp", "co.kr", "co.in", "co.id", "co.il", "co.za",
  "com.br", "com.mx", "com.ar", "com.cn", "com.hk", "com.sg", "com.tr", "com.tw", "com.my", "com.ph",
  "com.vn", "com.ng", "com.eg", "com.sa", "com.pk",
]);

/** Mailbox providers whose addresses belong to people, not companies. */
export const PERSONAL_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com", "msn.com",
  "yahoo.com", "yahoo.co.uk", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com",
  "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de", "web.de", "mail.com", "yandex.com", "yandex.ru",
  "zoho.com", "fastmail.com", "hey.com", "qq.com", "163.com", "126.com", "naver.com",
  "btinternet.com", "comcast.net", "verizon.net", "att.net", "gmx.net", "t-online.de", "orange.fr", "free.fr",
  "laposte.net", "wanadoo.fr", "libero.it", "seznam.cz", "wp.pl", "o2.pl", "mail.ru", "rambler.ru", "rediffmail.com",
  "bigpond.com", "shaw.ca", "rogers.com", "sky.com", "virginmedia.com", "tutanota.com", "duck.com",
]);

/** Free mail brands with a domain per country (yahoo.fr, outlook.de, hotmail.co.jp and so on). */
const PERSONAL_BRANDS: ReadonlySet<string> = new Set(["yahoo", "ymail", "rocketmail", "hotmail", "outlook", "gmx", "yandex"]);

/** Hostnames that serve many unrelated people or sites under a company's own domain. */
const SHARED_HOSTNAMES: ReadonlySet<string> = new Set(["sites.google.com", "docs.google.com", "privaterelay.appleid.com"]);

/** Hosts where many unrelated sites or profiles live under one registrable domain. */
export const SHARED_HOST_DOMAINS: ReadonlySet<string> = new Set([
  "github.io", "gitlab.io", "vercel.app", "netlify.app", "pages.dev", "herokuapp.com", "web.app", "firebaseapp.com",
  "wixsite.com", "squarespace.com", "wordpress.com", "blogspot.com", "substack.com", "medium.com", "notion.site",
  "carrd.co", "webflow.io", "linktr.ee", "linkedin.com", "twitter.com", "x.com", "facebook.com", "instagram.com",
  "youtube.com", "github.com", "crunchbase.com", "wellfound.com", "workers.dev", "myshopify.com", "calendly.com",
  "notion.so", "typeform.com", "eventbrite.com", "meetup.com", "gitbook.io", "readthedocs.io", "bitbucket.io",
]);

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The registrable domain of a hostname, or null when it is not a usable public hostname. */
export function registrableDomain(hostname: string): string | null {
  const host = hostname.trim().toLowerCase().replace(/\.+$/, "");
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  if (/^\d+$/.test(labels.at(-1) ?? "")) return null;
  const lastTwo = labels.slice(-2).join(".");
  const countryCode = (labels.at(-1) ?? "").length === 2;
  const take = TWO_LEVEL_SUFFIXES.has(lastTwo) || (countryCode && GENERIC_SECOND_LEVELS.has(labels.at(-2) ?? "")) ? 3 : 2;
  if (labels.length < take) return null;
  return labels.slice(-take).join(".");
}

/**
 * The account key for a URL, an email address or a bare domain, or null when there is no company
 * account behind it (a personal mailbox, a shared host, or input that does not parse).
 */
export function accountKey(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  let text = input.trim();
  if (text.length === 0 || text.length > 2048) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  if (!hasScheme && text.includes("@")) {
    // An address: exactly one, or nothing. A URL with an @ in its query is not an address.
    const address = normalizeAddress(text);
    if (!address) return null;
    text = address.slice(address.lastIndexOf("@") + 1);
  }
  let host: string;
  try {
    host = new URL(hasScheme ? text : `https://${text}`).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return null;
  }
  if (SHARED_HOSTNAMES.has(host) || [...SHARED_HOSTNAMES].some((h) => host.endsWith(`.${h}`))) return null;
  const domain = registrableDomain(host.replace(/^www\./, ""));
  if (!domain || PERSONAL_EMAIL_DOMAINS.has(domain) || SHARED_HOST_DOMAINS.has(domain)) return null;
  if (PERSONAL_BRANDS.has(domain.split(".")[0] ?? "")) return null;
  return domain;
}
