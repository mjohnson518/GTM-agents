// GTM-agents: finding the right person at an account a search turned up.
//
// An account candidate names a company, not a person. When a people provider is configured,
// enrichment asks it for people at the account's domain and ranks them with the one title
// classifier: persona matches first, then the seat (decision maker first), then seniority. Only
// people the classifier keeps are used, only with a usable name, and only at the account's own
// domain. Everything the provider returns is third-party text and is cleaned before it is used or
// stored. The lookup is a paid call: the spend gate is asked first and the cost recorded after.
import { accountKey } from "../data/keys.ts";
import type { JobLogger } from "../jobs/registry.ts";
import type { PeopleProvider, PersonRecord } from "../ports/discovery.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { classifyTitle, compareTitleClasses, type TitleClass } from "../scoring/titles.ts";
import type { SourcingBrain } from "../sourcing/brain.ts";
import { splitPersonName } from "../sourcing/identity.ts";
import type { SpendGate } from "../sourcing/spend.ts";
import { PROVIDER_TEXT_CAPS, cleanProviderText, cleanProviderUrl } from "../sourcing/text.ts";

export interface PersonAtAccount {
  firstName: string;
  lastName: string | null;
  title: string;
  fit: TitleClass;
  /** An address the provider returned, unverified; null when it returned none. */
  email: string | null;
  confidence: number | null;
  profileUrl: string | null;
  sourceUrl: string | null;
  providerRef: string;
  provider: string;
}

export type PeopleLookup =
  | { ok: true; people: PersonAtAccount[] }
  | { ok: false; reason: "budget" | "error"; detail?: string };

export interface PeopleLookupOptions {
  people: PeopleProvider;
  gate: SpendGate;
  brain: Pick<SourcingBrain, "personas" | "never">;
  reviews?: ReadonlyMap<string, "keep" | "drop">;
  /** People requested from the provider. */
  limit: number;
  log?: JobLogger;
}

function toPerson(record: PersonRecord, account: string, provider: string, options: PeopleLookupOptions): PersonAtAccount | null {
  if (record.accountDomain && accountKey(record.accountDomain) !== account) return null;
  const first = cleanProviderText(record.firstName, PROVIDER_TEXT_CAPS.name);
  const last = cleanProviderText(record.lastName, PROVIDER_TEXT_CAPS.name);
  // Every name goes through the same check, so a provider's first-name field holding a handle or a
  // company is skipped, not greeted.
  const split = splitPersonName(first ? [first, last].filter(Boolean).join(" ") : cleanProviderText(record.fullName, PROVIDER_TEXT_CAPS.name));
  if (!split?.first) return null;
  const title = cleanProviderText(record.title, PROVIDER_TEXT_CAPS.title);
  if (!title) return null;
  const fit = classifyTitle(title, options.brain.personas, { never: options.brain.never, ...(options.reviews ? { reviews: options.reviews } : {}) });
  const ref = cleanProviderText(record.providerRef, PROVIDER_TEXT_CAPS.ref);
  if (!ref) return null;
  const confidence = typeof record.attributes?.confidence === "number" ? record.attributes.confidence : null;
  return {
    firstName: split.first,
    lastName: split.last ?? null,
    title,
    fit,
    email: typeof record.email === "string" ? record.email : null,
    confidence,
    profileUrl: cleanProviderUrl(record.profileUrl),
    sourceUrl: cleanProviderUrl(record.evidence?.[0]?.url),
    providerRef: ref,
    provider,
  };
}

/** People at `account` the classifier keeps, best first. */
export async function findPeopleAtAccount(account: string, options: PeopleLookupOptions): Promise<PeopleLookup> {
  if (!(await options.gate.allow())) return { ok: false, reason: "budget", detail: options.gate.stopped ?? undefined };
  let page: Awaited<ReturnType<PeopleProvider["searchPeople"]>>;
  try {
    page = await options.people.searchPeople({ accountDomains: [account], limit: options.limit });
  } catch (error) {
    options.log?.warn("people lookup failed", { provider: options.people.name, error: sanitizeErrorMessage(error) });
    return { ok: false, reason: "error", detail: sanitizeErrorMessage(error) };
  }
  await options.gate.record(page.cost, { provider: options.people.name, capability: "people_search" });
  const people = (Array.isArray(page?.items) ? page.items : [])
    .map((record) => toPerson(record, account, options.people.name, options))
    .filter((p): p is PersonAtAccount => p !== null && p.fit.decision === "keep")
    .sort((a, b) => compareTitleClasses(a.fit, b.fit));
  return { ok: true, people };
}
