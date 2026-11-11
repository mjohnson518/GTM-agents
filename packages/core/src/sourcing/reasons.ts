// GTM-agents: the closed set of reasons a candidate stops short of promotion.
//
// Every move to a terminal status other than promoted (rejected, borderline, duplicate) writes one
// of these codes to `attributes.reject_reason`, beside the free-text `qualification_notes` an
// operator reads. The note explains one row; the code is what the rejections metric counts, so the
// funnel digest can say how many candidates each filter took out and from which source and query.
// Adding a filter means adding its code here; nothing writes a code that is not in this list.

export const REJECT_REASONS = [
  /** No company account key: a personal mailbox, a shared host or no domain at all. */
  "no_domain",
  /** The domain, company name or title matches the brain's never list. */
  "never_list",
  /** A person result whose name could not be read. */
  "name_unreadable",
  /** The account's model fit score is below the fit floor. */
  "low_fit",
  /** An account candidate, and no people provider is configured to find a person there. */
  "no_people_provider",
  /** The people lookup failed on every allowed run. */
  "people_lookup_failed",
  /** No one the people provider returned at the account matches a persona. */
  "no_persona_match",
  /** The title classifier dropped the person. */
  "person_fit_drop",
  /** The person fit was undecided at promotion, and a maybe is never promoted. */
  "person_fit_maybe",
  /** The address is suppressed, tombstoned or opted out. */
  "suppressed",
  /** The address or its mailbox is already a contact. */
  "duplicate_contact",
  /** The same full name at the same account is already a contact. */
  "duplicate_person",
  /** The address does not parse as exactly one address. */
  "address_unparseable",
  /** The address is not a work address at the candidate's own account. */
  "not_work_address",
  /** A role mailbox, not a person. */
  "role_mailbox",
  /** The verifier errored on every allowed run. */
  "verification_failed",
  /** Verification stayed unknown on every allowed attempt. */
  "verification_unknown",
  /** The verification result does not pass the promotion policy. */
  "verification_policy",
  /** The qualification score is under the rejection line. */
  "low_score",
  /** The qualification score is between the rejection line and the qualified line (borderline). */
  "borderline_score",
] as const;

export type RejectReason = (typeof REJECT_REASONS)[number];

const KNOWN: ReadonlySet<string> = new Set(REJECT_REASONS);

export function isRejectReason(value: unknown): value is RejectReason {
  return typeof value === "string" && KNOWN.has(value);
}
