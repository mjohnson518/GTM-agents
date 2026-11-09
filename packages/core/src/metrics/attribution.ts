// GTM-agents: the one definition of first-touch attribution.
//
// A reply is credited to the contact's latest first touch (sequence step 1, on the cold or sequence
// path) sent in the ATTRIBUTION_WINDOW_DAYS before the reply, on that send's ledger row:
//   - replied_at is the reply's own received time, never the time any job ran; when replies arrive
//     out of order, the earliest wins;
//   - reply_intent is the intent of the reply that set replied_at;
//   - reply_after_step is the highest step actually sent to the contact between that first touch
//     and the reply, so it is bounded by what went out and says how deep the sequence was;
//   - positive_reply_at is the earliest positive reply's own received time.
// The reply track writes these (replies/ledger.ts, creditReply) when it routes a triaged reply; the
// metric functions here read them. A follow-up never takes the credit from the first touch that
// opened the conversation, so a template is judged on the replies its sequence earned.

/** A reply is credited to a first touch sent at most this many days before it. */
export const ATTRIBUTION_WINDOW_DAYS = 60;
