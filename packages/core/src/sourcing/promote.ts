// GTM-agents: the promote stage: a qualified candidate with a verified work email becomes a contact.
//
// Checks, in order; the first that fails decides:
//   1. the address parses as exactly one address (contactEmailFields), or the candidate is rejected;
//   2. it is a work address at the candidate's own account: accountKey returns null for personal
//      mailboxes and shared hosts, so those are rejected here even if one slipped into the row;
//   3. it is not a role mailbox;
//   4. it is not already a contact (same address, or the same mailbox without a +tag), and the same
//      full name at the same account is not already a contact: either makes the candidate a
//      duplicate;
//   5. it is not suppressed, tombstoned or opted out (checkSuppression). A check that cannot be
//      read holds the candidate and stops the stage, because the check fails closed;
//   6. it has no unresolved evidence conflict: a conflict is held for a person, never guessed at;
//   7. the person fit, recomputed from the current brain, is keep, nothing is on the never list, and
//      the account is not scored below the fit floor (a source may insert rows already qualified);
//   8. a fresh verification passes the promotion policy (verification:promotion_policy): only
//      deliverable under the default `strict`, risky too under `allow_risky`. Unknown results are
//      retried on later runs and rejected after three; anything else is rejected.
// Then one D1 batch, all or nothing: the account upsert, the contact insert (normalized address
// and both hashes, warmth cold, the verification grade, the source and query), the candidate's
// move to promoted, its evidence linked to the contact, the persona seat and the fit verdict. The
// contact insert and the candidate update are both guarded on the candidate still being qualified,
// so two runs cannot promote one candidate twice. A missing first name is allowed: drafting holds
// such a contact later rather than greet a guessed name. Every rejection and duplicate records its
// reason code (sourcing/reasons.ts) in the attributes, saved with the fit verdict and retry counters
// worked out on the way. After the batch, a signal held at the
// account for its first contacts is carried to the new contact (signals/carry.ts).
import { accountKey } from "../data/keys.ts";
import { contactEmailFields } from "../data/contacts.ts";
import { checkSuppression } from "../sending/suppression.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { LOW_FIT_SCORE } from "../scoring/fit.ts";
import { classifyTitle } from "../scoring/titles.ts";
import { hasOpenConflict } from "../enrichment/evidence.ts";
import { MAX_UNKNOWN_ATTEMPTS, emailConfidence, passesPromotionPolicy, verifyAddress } from "../enrichment/verification.ts";
import type { EmailVerifier } from "../ports/contact.ts";
import { candidateUpdate, fitAttribute, loadTitleReviews, parseAttributes, updateCandidate, type CandidateRow } from "./candidates.ts";
import type { StageContext } from "./context.ts";
import type { PromotionPolicy } from "./flags.ts";
import { isRoleAddress, matchNeverList } from "./identity.ts";
import type { RejectReason } from "./reasons.ts";
import { carrySignals } from "../signals/carry.ts";

export interface PromoteStats {
  processed: number;
  promoted: number;
  duplicate: number;
  rejected: number;
  held: number;
  budgetStopped: boolean;
}

export interface PromoteOptions {
  policy: PromotionPolicy;
  verifier: EmailVerifier | undefined;
}

type Outcome = "promoted" | "duplicate" | "rejected" | "held" | "budget" | "stop";

export async function promoteStage(ctx: StageContext, limit: number, options: PromoteOptions): Promise<PromoteStats> {
  const stats: PromoteStats = { processed: 0, promoted: 0, duplicate: 0, rejected: 0, held: 0, budgetStopped: false };
  if (limit <= 0) return stats;
  const reviews = await loadTitleReviews(ctx.db);
  const { results: rows } = await ctx.db
    .prepare("SELECT * FROM candidates WHERE status = 'qualified' AND email IS NOT NULL ORDER BY qualification_score DESC, updated_at, id LIMIT ?1")
    .bind(limit)
    .all<CandidateRow>();
  for (const row of rows) {
    if (ctx.signal?.aborted) break;
    const outcome = await promoteOne(row, ctx, options, reviews);
    stats.processed += 1;
    if (outcome === "budget" || outcome === "stop") {
      stats.held += 1;
      stats.budgetStopped = outcome === "budget";
      break;
    }
    stats[outcome] += 1;
  }
  return stats;
}

async function promoteOne(row: CandidateRow, ctx: StageContext, options: PromoteOptions, reviews: ReadonlyMap<string, "keep" | "drop">): Promise<Outcome> {
  const { db, now } = ctx;
  const attrs = parseAttributes(row.attributes);
  const reject = async (reason: RejectReason, notes: string, clearEmail = false): Promise<Outcome> => {
    attrs.reject_reason = reason;
    await updateCandidate(
      db,
      row.id,
      "qualified",
      { status: "rejected", qualification_notes: notes, attributes: JSON.stringify(attrs), ...(clearEmail ? { email: null, email_source: null } : {}) },
      now,
    );
    return "rejected";
  };
  const hold = async (notes: string): Promise<Outcome> => {
    await updateCandidate(db, row.id, "qualified", { qualification_notes: notes, attributes: JSON.stringify(attrs) }, now);
    return "held";
  };

  // 1 to 3: the address.
  const fields = await contactEmailFields(row.email);
  if (!fields) return reject("address_unparseable", "the address does not parse", true);
  const account = accountKey(row.account_key);
  if (!account || accountKey(fields.email) !== account) return reject("not_work_address", "not a work address at the candidate's account", true);
  if (isRoleAddress(fields.email)) return reject("role_mailbox", "a role mailbox, not a person", true);

  // 4: identity.
  const existing = await db
    .prepare("SELECT id FROM contacts WHERE email_sha256 = ?1 OR mailbox_sha256 = ?2 OR email_sha256 = ?2 LIMIT 1")
    .bind(fields.email_sha256, fields.mailbox_sha256)
    .first<{ id: string }>();
  const namesake =
    existing ??
    (row.first_name && row.last_name
      ? await db
          .prepare("SELECT id FROM contacts WHERE account_key = ?1 AND lower(first_name) = lower(?2) AND lower(last_name) = lower(?3) LIMIT 1")
          .bind(account, row.first_name, row.last_name)
          .first<{ id: string }>()
      : null);
  if (namesake) {
    attrs.reject_reason = existing ? "duplicate_contact" : "duplicate_person";
    await updateCandidate(
      db,
      row.id,
      "qualified",
      {
        status: "duplicate",
        promoted_contact_id: namesake.id,
        qualification_notes: existing ? "already a contact" : "the same person at the same account is already a contact",
        attributes: JSON.stringify(attrs),
      },
      now,
    );
    return "duplicate";
  }

  // 5: suppression, tombstones and opt-outs. Fails closed.
  const suppression = await checkSuppression(db, [fields.email]);
  if (!suppression.ok) {
    if (suppression.blocked.some((b) => b.reason === "check_failed")) {
      await hold("the suppression check could not be read; retried next run");
      return "stop";
    }
    return reject("suppressed", "the address is suppressed", true);
  }

  // 6: conflicts are held for a person.
  if (await hasOpenConflict(db, { candidateId: row.id })) return hold("held: an evidence conflict waits for a person to resolve it");

  // 7: person fit and the never list, from the current brain.
  const fit = classifyTitle(row.job_title, ctx.brain.personas, { never: ctx.brain.never, reviews });
  attrs.person_fit = fitAttribute(fit);
  const never = matchNeverList(ctx.brain.never, { domain: account, accountName: row.account_name, title: row.job_title });
  // A title on the never list is also a person-fit drop; the never list is the reason recorded.
  if (fit.decision !== "keep") return reject(never ? "never_list" : fit.decision === "drop" ? "person_fit_drop" : "person_fit_maybe", `person fit is ${fit.decision}: ${fit.reason}`);
  if (never) return reject("never_list", never);
  const accountFit = await db.prepare("SELECT fit_score FROM account_fit WHERE account_key = ?1 AND status = 'scored'").bind(account).first<{ fit_score: number | null }>();
  if (accountFit?.fit_score !== null && accountFit?.fit_score !== undefined && accountFit.fit_score < LOW_FIT_SCORE) return reject("low_fit", `the account's fit score is below ${LOW_FIT_SCORE}`);

  // 8: verification and the policy.
  const verification = await verifyAddress(fields.email, { db, verifier: options.verifier, gate: ctx.gate, now, log: ctx.log });
  if (!verification.ok) {
    if (verification.reason === "budget") return "budget";
    // A verifier error is retried on later runs and rejected after MAX_UNKNOWN_ATTEMPTS; one that
    // will not go away (or no verifier at all) stops the stage, so it is not repeated for every row.
    attrs.verify_errors = (typeof attrs.verify_errors === "number" ? attrs.verify_errors : 0) + 1;
    if (attrs.verify_errors >= MAX_UNKNOWN_ATTEMPTS) return reject("verification_failed", "the address could not be verified on three runs");
    await hold(`not promoted: the address could not be verified (${verification.reason})`);
    return verification.reason === "no_verifier" || verification.retryable === false ? "stop" : "held";
  }
  const record = verification.record;
  if (record.status === "unknown") {
    attrs.verify_attempts = (attrs.verify_attempts ?? 0) + (record.cached ? 0 : 1);
    if ((attrs.verify_attempts ?? 0) >= MAX_UNKNOWN_ATTEMPTS) return reject("verification_unknown", "verification stayed unknown after three attempts");
    return hold("verification is unknown; retried when the result expires");
  }
  if (!passesPromotionPolicy(record, options.policy)) {
    return reject("verification_policy", `verification ${record.status}${record.disposable ? " (disposable)" : ""} does not pass the ${options.policy} policy`);
  }

  // The batch.
  const contactId = crypto.randomUUID();
  const stamp = now.toISOString();
  const confidence = emailConfidence(record);
  const stillQualified = "EXISTS (SELECT 1 FROM candidates WHERE id = ?1 AND status = 'qualified')";
  const contactAttributes = JSON.stringify({
    ...(fit.persona ? { persona: fit.persona } : {}),
    ...(attrs.segment ? { segment: attrs.segment } : {}),
    ...(attrs.profile_url ? { profile_url: attrs.profile_url } : {}),
  });
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO accounts (account_key, name, domain, created_at, updated_at) VALUES (?1, ?2, ?1, ?3, ?3)
           ON CONFLICT(account_key) DO UPDATE SET updated_at = excluded.updated_at`,
        )
        .bind(account, row.account_name ?? account, stamp),
      db
        .prepare(
          `INSERT INTO contacts (id, first_name, last_name, email, email_sha256, mailbox_sha256, account_key, job_title, source, candidate_id,
             discovery_query_id, warmth, email_source, email_confidence, verification_status, verified_at, enriched_at, attributes, created_at, updated_at)
           SELECT ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?1, ?11, 'cold', ?12, ?13, ?14, ?15, ?16, ?17, ?16, ?16 WHERE ${stillQualified}`,
        )
        .bind(
          row.id,
          contactId,
          row.first_name,
          row.last_name,
          fields.email,
          fields.email_sha256,
          fields.mailbox_sha256,
          account,
          row.job_title,
          row.source,
          row.query_id,
          row.email_source,
          confidence,
          record.status,
          record.verifiedAt,
          stamp,
          contactAttributes,
        ),
      candidateUpdate(db, row.id, "qualified", { status: "promoted", promoted_contact_id: contactId, email: fields.email, qualification_notes: `promoted (${record.status})`, attributes: JSON.stringify(attrs) }, now),
      db.prepare("UPDATE contact_evidence SET contact_id = ?2 WHERE candidate_id = ?1 AND contact_id IS NULL AND EXISTS (SELECT 1 FROM contacts WHERE id = ?2)").bind(row.id, contactId),
      db
        .prepare("INSERT OR IGNORE INTO account_contacts (account_key, contact_id, persona, is_primary, created_at) SELECT ?1, ?2, ?3, 0, ?4 WHERE EXISTS (SELECT 1 FROM contacts WHERE id = ?2)")
        .bind(account, contactId, fit.persona, stamp),
      db
        .prepare("INSERT OR IGNORE INTO contact_fit (contact_id, decision, reason, source, decided_at, created_at) SELECT ?1, 'keep', ?2, ?4, ?3, ?3 WHERE EXISTS (SELECT 1 FROM contacts WHERE id = ?1)")
        .bind(contactId, fit.reason, stamp, fit.persona ? "brain" : "model"),
      db
        .prepare(
          `UPDATE discovery_queries SET total_promoted = total_promoted + 1, first_promoted_at = COALESCE(first_promoted_at, ?2)
            WHERE id = ?1 AND EXISTS (SELECT 1 FROM contacts WHERE id = ?3)`,
        )
        .bind(row.query_id, stamp, contactId),
    ]);
  } catch (error) {
    // Most often another candidate promoted the same address first; the next run sees the contact
    // and marks this one a duplicate.
    ctx.log.warn("promotion batch failed; the candidate stays qualified", { candidate: row.id, error: sanitizeErrorMessage(error) });
    return "held";
  }
  const created = await db.prepare("SELECT 1 AS hit FROM contacts WHERE id = ?1").bind(contactId).first();
  if (!created) return "held";
  // Signal carry is bookkeeping on this path: an error is logged and dropped.
  try {
    await carrySignals(db, contactId, now);
  } catch (error) {
    ctx.log.warn("signal carry failed; the contact is promoted without it", { contact: contactId, error: sanitizeErrorMessage(error) });
  }
  return "promoted";
}
