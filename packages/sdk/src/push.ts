// GTM-agents SDK: signing and sending a product event to the deployment (push, host to agent).
//
// The emitter does exactly what the contract's minimal implementation does: serialize once, sign
// those exact bytes, post them with a 3-second timeout, and never retry, never throw and never block
// the user's request beyond that timeout. A missed event is repaired by the agent's nightly pull. A
// host that wants retries runs them from a queue of its own and reuses the same event id; the agent
// answers `duplicate: true` and applies nothing twice.
import { hmacSha256Hex } from "./crypto.ts";
import { eventProblem, type ProductEvent } from "./events.ts";

/** The push signature header: `sha256=<hex HMAC-SHA256(PRODUCT_WEBHOOK_SECRET, raw body)>`. */
export const SIGNATURE_HEADER = "X-Signature";
/** Equal to the body's `id`. */
export const EVENT_ID_HEADER = "X-Event-Id";
/** The agent's webhook path, under its base URL. */
export const PRODUCT_WEBHOOK_PATH = "/api/webhooks/product";
export const DEFAULT_EMIT_TIMEOUT_MS = 3000;

/** The value of X-Signature for `body`, exactly as sent. */
export async function signPush(body: string, secret: string): Promise<string> {
  return `sha256=${await hmacSha256Hex(secret, body)}`;
}

/** The headers a push carries. */
export async function pushHeaders(event: Pick<ProductEvent, "id">, body: string, secret: string): Promise<Record<string, string>> {
  return { "Content-Type": "application/json", [SIGNATURE_HEADER]: await signPush(body, secret), [EVENT_ID_HEADER]: event.id };
}

export interface EmitterOptions {
  /** The agent's webhook URL, `{AGENT_BASE_URL}/api/webhooks/product`. Unset: the emitter is a no-op. */
  url: string | undefined | null;
  /** PRODUCT_WEBHOOK_SECRET. Unset: the emitter is a no-op. */
  secret: string | undefined | null;
  /** Defaults to 3000. */
  timeoutMs?: number;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Called with what went wrong, for the host's own logs. It must not throw; if it does, that is swallowed too. */
  onError?: (error: { eventId: string; reason: string }) => void;
}

export type EmitResult =
  | { sent: true; status: number; duplicate: boolean }
  | { sent: false; reason: "not_configured" | "invalid_event" | "rejected" | "network" | "timeout"; status?: number; detail?: string };

export interface ProductEmitter {
  /** False when the URL or the secret is unset: every emit is then a no-op. */
  readonly enabled: boolean;
  /** Send one event, once. Never throws; resolves within the timeout. */
  emit(event: ProductEvent): Promise<EmitResult>;
}

/** An emitter for the host application. */
export function createProductEmitter(options: EmitterOptions): ProductEmitter {
  const url = typeof options.url === "string" ? options.url.trim() : "";
  const secret = typeof options.secret === "string" ? options.secret : "";
  const enabled = url.length > 0 && secret.length > 0;
  const timeoutMs = options.timeoutMs ?? DEFAULT_EMIT_TIMEOUT_MS;
  const send: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const report = (eventId: string, reason: string) => {
    try {
      options.onError?.({ eventId, reason });
    } catch {
      // The host's logger must not break the user's request either.
    }
  };
  return {
    enabled,
    async emit(event) {
      if (!enabled) return { sent: false, reason: "not_configured" };
      const id = typeof event?.id === "string" ? event.id : "";
      try {
        const problem = eventProblem(event);
        if (problem) {
          report(id, problem);
          return { sent: false, reason: "invalid_event", detail: problem };
        }
        const body = JSON.stringify(event);
        const response = await send(url, { method: "POST", headers: await pushHeaders(event, body, secret), body, signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) {
          report(id, `the agent answered ${response.status}`);
          return { sent: false, reason: "rejected", status: response.status };
        }
        let duplicate = false;
        try {
          duplicate = ((await response.json()) as { duplicate?: unknown })?.duplicate === true;
        } catch {
          // A 200 without a readable body still means accepted.
        }
        return { sent: true, status: response.status, duplicate };
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        report(id, timedOut ? "timed out" : "network error");
        return { sent: false, reason: timedOut ? "timeout" : "network" };
      }
    },
  };
}
