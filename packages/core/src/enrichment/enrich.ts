// GTM-agents: the enrichment stage: raw candidates become enriched (or rejected) people.
//
// For each raw candidate, oldest first, up to discovery:enrich_per_cycle per run:
//   1. Identity and the fit gate, before any paid call: the candidate needs a company account key
//      (never a personal mailbox domain or a shared host), must not be on the brain's never list,
//      and its account must not have a model fit score below 5.
//   2. The person: an account candidate gets the best-fitting person at the account from the
//      people provider; up to `peoplePerAccount - 1` further matches become new raw candidates.
//   3. Person fit, from the one title classifier. A drop is rejected. A maybe is enriched without
//      any paid email lookup, so it cannot be promoted: a maybe is a no until proven.
//   4. The email waterfall (skipped when a clean address found on an earlier run is already on the
//      row, so paid-for work is never lost), then a suppression check (an address that is suppressed, tombstoned or
//      opted out is rejected and not kept), then a duplicate check against contacts, then
//      verification (cached when fresh).
//   5. Per-field evidence (employer domain, title, email), with conflicts marked for a person.
// The budget stops the stage: when the spend gate refuses, the current candidate keeps its
// progress and stays raw for the next run. A suppression check that cannot be read stops the stage
// too (it fails closed), leaving the candidate raw. Evidence is what conflict holds are built on, so a database
// error while recording it fails the run rather than let a candidate through unchecked.
import { accountKey } from "../data/keys.ts";
import { addressHash, checkSuppression, mailboxOf } from "../sending/suppression.ts";
import { classifyTitle } from "../scoring/titles.ts";
import { LOW_FIT_SCORE } from "../scoring/fit.ts";
import {
  fitAttribute,
  insertCandidate,
  loadTitleReviews,
  parseAttributes,
  parseSteps,
  updateCandidate,
  type CandidateAttributes,
  type CandidateRow,
  type CandidateUpdate,
} from "../sourcing/candidates.ts";
import type { SourcingAdapters, StageContext } from "../sourcing/context.ts";
import { SOURCING_FLAGS, readFlagOn } from "../sourcing/flags.ts";
import { matchNeverList, screenAddress } from "../sourcing/identity.ts";
import type { RejectReason } from "../sourcing/reasons.ts";
import { recordEvidence } from "./evidence.ts";
import { findPeopleAtAccount } from "./people.ts";
import { verifyAddress } from "./verification.ts";
import { runEmailWaterfall } from "./waterfall.ts";

/** People requested from the people provider for one account. */
export const PEOPLE_LOOKUP_LIMIT = 10;
/** Failed (non-budget) lookups before a candidate is rejected. */
export const MAX_ENRICH_ATTEMPTS = 3;

export interface EnrichOptions {
  /** People kept per account candidate: the best fills the candidate, the rest become new candidates. */
  peoplePerAccount: number;
}

export interface EnrichStats {
  processed: number;
  enriched: number;
  rejected: number;
  duplicate: number;
  held: number;
  budgetStopped: boolean;
}

type Outcome = "enriched" | "rejected" | "duplicate" | "held" | "budget" | "stop";

export async function enrichStage(ctx: StageContext, adapters: SourcingAdapters, limit: number, options: EnrichOptions): Promise<EnrichStats> {
  const stats: EnrichStats = { processed: 0, enriched: 0, rejected: 0, duplicate: 0, held: 0, budgetStopped: false };
  if (limit <= 0) return stats;
  const waterfallEnabled = await readFlagOn(ctx.flags, SOURCING_FLAGS.waterfall);
  const reviews = await loadTitleReviews(ctx.db);
  const disabled = new Set<string>();
  const { results: rows } = await ctx.db.prepare("SELECT * FROM candidates WHERE status = 'raw' ORDER BY created_at, id LIMIT ?1").bind(limit).all<CandidateRow>();
  for (const row of rows) {
    if (ctx.signal?.aborted) break;
    const outcome = await enrichOne(row, { ctx, adapters, options, waterfallEnabled, reviews, disabled });
    stats.processed += 1;
    if (outcome === "budget" || outcome === "stop") {
      stats.budgetStopped = outcome === "budget";
      stats.held += 1;
      break;
    }
    stats[outcome] += 1;
  }
  return stats;
}

interface EnrichDeps {
  ctx: StageContext;
  adapters: SourcingAdapters;
  options: EnrichOptions;
  waterfallEnabled: boolean;
  reviews: ReadonlyMap<string, "keep" | "drop">;
  disabled: Set<string>;
}

async function enrichOne(row: CandidateRow, deps: EnrichDeps): Promise<Outcome> {
  const { ctx, adapters } = deps;
  const { db, brain, now } = ctx;
  const attrs: CandidateAttributes = parseAttributes(row.attributes);
  const save = (fields: CandidateUpdate) => updateCandidate(db, row.id, "raw", { attributes: JSON.stringify(attrs), ...fields }, now);
  // The reason code is merged into the attributes beside everything already there.
  const reject = async (reason: RejectReason, notes: string, fields: CandidateUpdate = {}): Promise<Outcome> => {
    attrs.reject_reason = reason;
    await save({ status: "rejected", qualification_notes: notes, ...fields });
    return "rejected";
  };

  // 1. Identity and the fit gate.
  const account = accountKey(row.account_key);
  if (!account) return reject("no_domain", "no company domain: a personal mailbox, a shared host or no domain at all");
  const never = matchNeverList(brain.never, { domain: account, accountName: row.account_name, title: row.job_title });
  if (never) return reject("never_list", never);
  const fitRow = await db.prepare("SELECT status, fit_score FROM account_fit WHERE account_key = ?1").bind(account).first<{ status: string; fit_score: number | null }>();
  if (fitRow?.status === "scored" && fitRow.fit_score !== null && fitRow.fit_score < LOW_FIT_SCORE) {
    return reject("low_fit", `the account's fit score is ${fitRow.fit_score}, below ${LOW_FIT_SCORE}`);
  }

  // 2. The person.
  let first = row.first_name;
  let last = row.last_name;
  let title = row.job_title;
  let personSource = row.source;
  let personUrl: string | null = row.url;
  let provided: { email: string; provider: string; confidence?: number | null; sourceUrl?: string | null } | null = row.email
    ? { email: row.email, provider: row.email_source ?? row.source }
    : null;
  // Only an account candidate (no person named yet) asks the people provider. A named person
  // without a title is never swapped for someone else: person fit leaves them undecided below.
  if (!first) {
    if (!adapters.people) return reject("no_people_provider", "the candidate names an account, and no people provider is configured to find a person there");
    const lookup = await findPeopleAtAccount(account, {
      people: adapters.people,
      gate: ctx.gate,
      brain,
      reviews: deps.reviews,
      limit: PEOPLE_LOOKUP_LIMIT,
      log: ctx.log,
    });
    if (!lookup.ok) {
      if (lookup.reason === "budget") return "budget";
      attrs.enrich_attempts = (attrs.enrich_attempts ?? 0) + 1;
      if (attrs.enrich_attempts >= MAX_ENRICH_ATTEMPTS) return reject("people_lookup_failed", "the people lookup failed on three runs");
      await save({ qualification_notes: "people lookup failed; retried next run" });
      return "held";
    }
    const [best, ...rest] = lookup.people;
    if (!best) return reject("no_persona_match", "no one at the account matches a persona");
    for (const extra of rest.slice(0, Math.max(0, deps.options.peoplePerAccount - 1))) {
      let screened = extra.email ? screenAddress(extra.email, account) : null;
      // A suppressed, tombstoned or opted-out address is never stored, and neither is one whose
      // check could not be read.
      if (screened?.verdict === "clean" && screened.email && !(await checkSuppression(db, [screened.email])).ok) screened = null;
      await insertCandidate(
        db,
        {
          source: extra.provider,
          sourceRef: extra.providerRef,
          queryId: row.query_id,
          searchType: "person",
          url: extra.sourceUrl,
          firstName: extra.firstName,
          lastName: extra.lastName,
          jobTitle: extra.title,
          accountName: row.account_name,
          accountKey: account,
          // Only a clean work address is kept; anything else is dropped here, never stored.
          email: screened?.verdict === "clean" ? (screened.email ?? null) : null,
          emailSource: screened?.verdict === "clean" ? extra.provider : null,
          status: "raw",
          attributes: { ...(extra.profileUrl ? { profile_url: extra.profileUrl } : {}), ...(attrs.segment ? { segment: attrs.segment } : {}) },
        },
        now,
      );
    }
    first = best.firstName;
    last = best.lastName;
    title = best.title;
    personSource = best.provider;
    personUrl = best.sourceUrl;
    if (best.profileUrl) attrs.profile_url = best.profileUrl;
    provided = best.email ? { email: best.email, provider: best.provider, confidence: best.confidence, sourceUrl: best.sourceUrl } : provided;
  }

  // 3. Person fit.
  const fit = classifyTitle(title, brain.personas, { never: brain.never, reviews: deps.reviews });
  attrs.person_fit = fitAttribute(fit);
  const person: CandidateUpdate = { first_name: first, last_name: last, job_title: title };
  if (fit.decision === "drop") return reject("person_fit_drop", `person fit: ${fit.reason}`, { ...person, email: null });
  if (fit.decision !== "keep") {
    await save({ ...person, email: null, email_source: null, status: "enriched", qualification_notes: `person fit is undecided (${fit.reason}); no email lookup` });
    return "enriched";
  }

  // 4. The email waterfall, unless a clean address from an earlier run is already on the row.
  const tried = parseSteps(row.email_steps_tried);
  const onRow = row.email ? screenAddress(row.email, account) : null;
  const waterfall =
    onRow?.verdict === "clean" && onRow.email
      ? { found: { email: onRow.email, provider: row.email_source ?? row.source, confidence: null, sourceUrl: null }, steps: [], budgetStopped: false }
      : await runEmailWaterfall(
          { firstName: first, lastName: last, account, profileUrl: attrs.profile_url ?? null, provided, tried },
          { finders: adapters.finders, waterfallEnabled: deps.waterfallEnabled, gate: ctx.gate, disabled: deps.disabled, log: ctx.log },
        );
  const steps = JSON.stringify([...tried, ...waterfall.steps.filter((s) => s.outcome !== "skipped").map((s) => s.step)]);
  const found = waterfall.found;
  if (!found) {
    if (waterfall.budgetStopped) {
      await save({ ...person, email_steps_tried: steps });
      return "budget";
    }
    await recordPersonEvidence(db, row, account, title, personSource, personUrl, now);
    await save({ ...person, email: null, email_steps_tried: steps, status: "enriched", qualification_notes: "no work address found" });
    return "enriched";
  }

  // Suppression first: a suppressed, tombstoned or opted-out address is never kept or verified.
  const suppression = await checkSuppression(db, [found.email]);
  if (!suppression.ok) {
    if (suppression.blocked.some((b) => b.reason === "check_failed")) {
      // Nothing is saved: the candidate stays as it was, and the stage stops.
      return "stop";
    }
    return reject("suppressed", "the address is suppressed", { ...person, email: null, email_source: null, email_steps_tried: steps });
  }

  const duplicate = await db
    .prepare("SELECT id FROM contacts WHERE email_sha256 = ?1 OR mailbox_sha256 = ?2 OR email_sha256 = ?2 LIMIT 1")
    .bind(await addressHash(found.email), await addressHash(mailboxOf(found.email)))
    .first<{ id: string }>();
  if (duplicate) {
    // Recorded against the existing contact too, so a disagreement with what is on file is held.
    await recordEvidence(db, { candidateId: row.id, contactId: duplicate.id, field: "job_title", value: title ?? "", provider: personSource, sourceUrl: personUrl, now });
    attrs.reject_reason = "duplicate_contact";
    await save({ ...person, email: found.email, email_source: found.provider, email_steps_tried: steps, status: "duplicate", promoted_contact_id: duplicate.id, qualification_notes: "already a contact" });
    return "duplicate";
  }

  const verification = await verifyAddress(found.email, { db, verifier: adapters.verifier, gate: ctx.gate, now, log: ctx.log });
  if (!verification.ok && verification.reason === "budget") {
    // Keep the clean address so the next run verifies it without finding it again.
    await save({ ...person, email: found.email, email_source: found.provider, email_steps_tried: steps });
    return "budget";
  }
  const record = verification.ok ? verification.record : null;

  // 5. Evidence.
  await recordPersonEvidence(db, row, account, title, personSource, personUrl, now);
  await recordEvidence(db, {
    candidateId: row.id,
    field: "email",
    value: found.email,
    provider: found.provider,
    sourceUrl: found.sourceUrl,
    confidence: found.confidence,
    verifiedAt: record?.status === "deliverable" ? record.verifiedAt : null,
    now,
  });
  const note = record ? `email ${record.status}${record.cached ? " (cached)" : ""}` : `email not verified (${verification.ok ? "" : verification.reason})`;
  await save({ ...person, email: found.email, email_source: found.provider, email_steps_tried: steps, status: "enriched", qualification_notes: note });
  return "enriched";
}

async function recordPersonEvidence(db: D1Database, row: CandidateRow, account: string, title: string | null, personSource: string, personUrl: string | null, now: Date): Promise<void> {
  await recordEvidence(db, { candidateId: row.id, field: "employer_domain", value: account, provider: row.source, sourceUrl: row.url, now });
  if (title) await recordEvidence(db, { candidateId: row.id, field: "job_title", value: title, provider: personSource, sourceUrl: personUrl, now });
}
