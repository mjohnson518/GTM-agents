// GTM-agents: OperatorGateway, the Durable Object that holds the admin dashboard's WebSocket
// connections (hibernating) and serializes operator chat. In this version it answers 501 to every
// request; it exists so the binding set validates and deploys.
import { DurableObject } from "cloudflare:workers";

export class OperatorGateway extends DurableObject {
  override fetch(_request: Request): Response {
    return Response.json({ error: "not_implemented", detail: "the operator gateway is not available in this version" }, { status: 501 });
  }
}
