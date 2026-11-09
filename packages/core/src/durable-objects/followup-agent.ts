// GTM-agents: FollowupAgent, a Durable Object class kept so the binding set a deployment declares
// validates and deploys. Lifecycle follow-ups do not use it: their timer is the database. Each kind
// is due a fixed delay after the contact entered their current state, and the scheduled
// lifecycle_followups job (lifecycle/followups.ts) finds what is due with one bounded query, so a
// transition reschedules every timer by itself and no per-contact alarm can drift from the state it
// belongs to or fire after an erasure. It answers 501 to every request.
import { DurableObject } from "cloudflare:workers";

export class FollowupAgent extends DurableObject {
  override fetch(_request: Request): Response {
    return Response.json({ error: "not_implemented", detail: "lifecycle follow-ups run as the lifecycle_followups job, not through this object" }, { status: 501 });
  }
}
