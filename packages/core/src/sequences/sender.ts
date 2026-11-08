// GTM-agents: the send function for sequence steps.
//
//   const send = createSequenceSender(senderDepsFromEnv(env, { config, provider }));
//
// It is the provider boundary every other send goes through (createDeliveryBoundary), with every
// check it runs: delivery:enabled, the halt and the cold kill switch, suppression, the content lint,
// the verification policy, the approved digest, the send window, the per-domain and per-account caps
// and the circuit breaker. The one difference from createOutreachSender: a step that has to wait is
// never written to the deferred queue. It stays due on its campaign row instead, at the time the
// boundary named, so the follow-up sweep runs its own checks again (above all the reply check over
// the whole account) right before the step goes. The deferred replay re-checks only the contact
// itself, and a colleague's reply must stop the next step too.
import { createDeliveryBoundary, type OutreachSenderDeps } from "../sending/boundary.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import type { SendOutreach } from "../sending/types.ts";

/** The send function for sequence steps. One outcome per item, in order; never throws. */
export function createSequenceSender(deps: OutreachSenderDeps): SendOutreach {
  const boundary = createDeliveryBoundary(deps);
  return async (items) => {
    try {
      return await boundary.run(items, { persistDeferrals: false });
    } catch (error) {
      // Unreachable by design; a defect must still never become a send or an unhandled rejection.
      deps.log?.error("the sequence send function failed unexpectedly", { error: sanitizeErrorMessage(error) });
      return items.map((item) => ({ idempotencyKey: typeof item?.idempotencyKey === "string" ? item.idempotencyKey : "", status: "failed" as const, retryable: true, message: "the send function failed unexpectedly; see the logs." }));
    }
  };
}
