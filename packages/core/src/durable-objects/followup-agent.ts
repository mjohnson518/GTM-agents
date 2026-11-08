// GTM-agents: FollowupAgent, one Durable Object per contact. Lifecycle transitions reschedule the
// contact's follow-up timers with Durable Object alarms, so no cron job scans every contact. In this
// version it answers 501 to every request; it exists so the binding set validates and deploys.
import { DurableObject } from "cloudflare:workers";

export class FollowupAgent extends DurableObject {
  override fetch(_request: Request): Response {
    return Response.json({ error: "not_implemented", detail: "lifecycle follow-ups are not available in this version" }, { status: 501 });
  }
}
