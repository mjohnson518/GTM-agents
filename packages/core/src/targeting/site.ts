// GTM-agents: reading the operator's own site for a targeting draft.
//
// Every page is read with fetchPublicPage, the same rules as the web_fetch tool: a full http(s) URL
// that passes the URL check, redirects followed by hand with every hop validated, at most 512 KB,
// text/html and text/plain only. After the first page, up to SITE_EXTRA_PAGES more are read from
// the links on it: only pages on the same registrable domain whose path names a product, about,
// pricing, customers or solutions page, with no query string. A page that redirects off the site is
// dropped. No logins, no forms, no JavaScript. The text is untrusted: it is returned for the caller
// to fence, and only its URL, title, size and hash are ever stored.
import { SHARED_HOST_DOMAINS, registrableDomain } from "../data/keys.ts";
import { sha256Hex } from "../brain/lock.ts";
import { fetchPublicPage, type PublicPage } from "../tools/web-fetch.ts";

/** Pages read after the first, at most. */
export const SITE_EXTRA_PAGES = 3;
/** The most page text sent to the model, in characters, across every page. */
export const SITE_TEXT_MAX_CHARS = 24_000;
/** Of that, the most from the first page. */
export const SITE_FIRST_PAGE_MAX_CHARS = 12_000;
/** Less readable text than this, across every page, and no draft is made. */
export const SITE_TEXT_MIN_CHARS = 200;

const USEFUL_PATH = /\/(about|company|product|products|platform|features|how-it-works|pricing|plans|customers|case-studies|solutions|use-cases|why)(\/|$|-)/i;

export interface SitePage {
  url: string;
  title: string;
  bytes: number;
  sha256: string;
  /** The page text, cut to its share of SITE_TEXT_MAX_CHARS. Untrusted. Never stored. */
  text: string;
}

export type SiteRead = { ok: true; pages: SitePage[]; skipped: Array<{ url: string; reason: string }> } | { ok: false; reason: string };

/** The site a URL belongs to: its registrable domain, or its whole host on a shared host (one tenant of many). */
function siteOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const domain = registrableDomain(host);
    if (!domain) return null;
    return SHARED_HOST_DOMAINS.has(domain) ? host : domain;
  } catch {
    return null;
  }
}

/** The extra pages worth reading from the first page's links: same site, useful paths, no query. */
export function extraPageUrls(first: Pick<PublicPage, "url" | "links">, max = SITE_EXTRA_PAGES): string[] {
  const site = siteOf(first.url);
  if (!site) return [];
  const self = new URL(first.url);
  const out: string[] = [];
  for (const link of first.links) {
    let u: URL;
    try {
      u = new URL(link);
    } catch {
      continue;
    }
    if (u.search !== "" || u.username !== "" || u.password !== "") continue;
    if (siteOf(u.toString()) !== site || !USEFUL_PATH.test(u.pathname)) continue;
    if (u.pathname.replace(/\/$/, "") === self.pathname.replace(/\/$/, "") && u.hostname === self.hostname) continue;
    const key = `${u.hostname}${u.pathname.replace(/\/$/, "")}`;
    if (out.some((o) => o.replace(/^https?:\/\//, "").replace(/\/$/, "") === key)) continue;
    out.push(u.toString());
    if (out.length >= max) break;
  }
  return out;
}

async function asPage(page: PublicPage, chars: number): Promise<SitePage> {
  return { url: page.url, title: page.title.slice(0, 200), bytes: page.bytes, sha256: await sha256Hex(page.text), text: page.text.slice(0, chars) };
}

/** Read the site. Never throws: a first page that cannot be read is a plain reason, and so is a site with too little text. */
export async function readSite(url: string, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<SiteRead> {
  const fetchOptions = { ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.signal ? { signal: options.signal } : {}) };
  let first: PublicPage;
  try {
    first = await fetchPublicPage(url, fetchOptions);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message.slice(0, 200) : "the page could not be read" };
  }
  const site = siteOf(first.url);
  const pages: SitePage[] = [await asPage(first, SITE_FIRST_PAGE_MAX_CHARS)];
  const skipped: Array<{ url: string; reason: string }> = [];
  let room = SITE_TEXT_MAX_CHARS - (pages[0]?.text.length ?? 0);
  for (const next of extraPageUrls(first)) {
    if (room <= 0) break;
    try {
      const page = await fetchPublicPage(next, fetchOptions);
      if (siteOf(page.url) !== site) {
        skipped.push({ url: next, reason: "it redirected off the site" });
        continue;
      }
      const read = await asPage(page, room);
      room -= read.text.length;
      pages.push(read);
    } catch (error) {
      skipped.push({ url: next, reason: error instanceof Error ? error.message.slice(0, 200) : "it could not be read" });
    }
  }
  const total = pages.reduce((n, p) => n + p.text.trim().length, 0);
  if (total < SITE_TEXT_MIN_CHARS) return { ok: false, reason: `the site has too little readable text (${total} characters); paste the text instead` };
  return { ok: true, pages, skipped };
}
