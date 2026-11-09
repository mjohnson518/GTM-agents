// GTM-agents: the dashboard's typed RPC client over the gateway WebSocket. It owns the connection
// lifecycle (connect handshake, reconnect with backoff, the "not configured" and "not allowed"
// outcomes), one promise per request id with a timeout, and the pushed-event subscriptions.
// The protocol types come from core as types only, so nothing from core ships in the bundle.
import type {
  MethodName,
  MethodParams,
  MethodResult,
  PROTOCOL_VERSION as CORE_PROTOCOL_VERSION,
  RpcErrorCode,
  ServerEvent,
} from "@gtm-agents/core/gateway/protocol";
import { backoffDelay, classifyCloseCode, classifyProbeStatus } from "./state.ts";

/** Kept in step with core at compile time: this fails to typecheck if the protocol version moves. */
export const PROTOCOL_VERSION: typeof CORE_PROTOCOL_VERSION = 1;

export type ClientErrorCode = RpcErrorCode | "timeout" | "disconnected";

export class RpcError extends Error {
  readonly code: ClientErrorCode;
  constructor(code: ClientErrorCode, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

export type EventName = ServerEvent["event"];
export type EventData<E extends EventName> = Extract<ServerEvent, { event: E }>["data"];

export type Session = MethodResult<"connect">;

export type ConnectionState =
  | { kind: "connecting"; attempt: number }
  | { kind: "open"; session: Session }
  | { kind: "reconnecting"; attempt: number; inMs: number; reason: string }
  | { kind: "not_configured"; disabled: boolean }
  | { kind: "not_allowed"; message: string }
  | { kind: "incompatible"; message: string }
  | { kind: "stopped" };

export interface SocketHandlers {
  open(): void;
  message(data: string): void;
  close(code: number, reason: string): void;
}

export interface SocketHandle {
  send(data: string): void;
  close(code?: number): void;
}

export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketHandle;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ProbeResult {
  status: number;
  /** The gateway's error code from the JSON body, for example "dashboard_disabled". */
  error?: string;
}

export interface ClientOptions {
  url: string;
  socketFactory: SocketFactory;
  /** Reads the HTTP status (and error code) of a plain GET to the socket path, or null when it cannot be reached. */
  probe?: () => Promise<ProbeResult | null>;
  timers?: Timers;
  random?: () => number;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: RpcError): void;
  timer: unknown;
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/** The WebSocket factory the browser uses. Only string frames are passed on. */
export const browserSocketFactory: SocketFactory = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.onopen = () => handlers.open();
  ws.onmessage = (event: MessageEvent) => {
    if (typeof event.data === "string") handlers.message(event.data);
  };
  ws.onclose = (event: CloseEvent) => handlers.close(event.code, event.reason);
  return {
    send: (data) => ws.send(data),
    close: (code) => ws.close(code),
  };
};

/** The socket URL on the page's own origin: wss when the page is https, ws only for local http. */
export function socketUrl(location: { protocol: string; host: string }): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}/ws`;
}

/**
 * A plain same-origin GET to the socket path. The Access cookie rides along; nothing else is sent.
 * A redirect means Access wants a fresh sign-in, which reads as 401.
 */
export async function browserProbe(): Promise<ProbeResult | null> {
  try {
    const response = await fetch("/ws", { method: "GET", cache: "no-store", credentials: "same-origin", redirect: "manual" });
    if (response.type === "opaqueredirect") return { status: 401 };
    let error: string | undefined;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string") error = body.error.slice(0, 64);
    } catch {
      // Not JSON; the status is enough.
    }
    return error ? { status: response.status, error } : { status: response.status };
  } catch {
    return null;
  }
}

export class GatewayClient {
  #options: Required<Omit<ClientOptions, "probe">> & Pick<ClientOptions, "probe">;
  #socket: SocketHandle | null = null;
  #opened = false;
  #ready = false;
  #stopped = true;
  #attempt = 0;
  #seq = 0;
  #retryTimer: unknown = null;
  #pending = new Map<string, Pending>();
  #eventListeners = new Map<string, Set<(data: never) => void>>();
  #stateListeners = new Set<(state: ConnectionState) => void>();
  #state: ConnectionState = { kind: "stopped" };

  constructor(options: ClientOptions) {
    this.#options = {
      timers: defaultTimers,
      random: Math.random,
      requestTimeoutMs: 20_000,
      connectTimeoutMs: 10_000,
      ...options,
    };
  }

  get state(): ConnectionState {
    return this.#state;
  }

  /** Opens the connection and keeps it open until `stop()`. */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#attempt = 0;
    this.#open();
  }

  stop(): void {
    this.#stopped = true;
    this.#clearRetry();
    this.#teardown("The dashboard closed the connection.");
    this.#setState({ kind: "stopped" });
  }

  /** Skips the remaining backoff (for a "try again" button, or the browser coming back online). */
  retryNow(): void {
    if (this.#state.kind === "open" || this.#state.kind === "connecting") return;
    this.#clearRetry();
    this.#stopped = false;
    this.#open();
  }

  /** Calls a method. Rejects with an RpcError on a server error, a timeout or a lost connection. */
  call<M extends MethodName>(method: M, params: MethodParams<M>, timeoutMs?: number): Promise<MethodResult<M>> {
    if (!this.#ready && method !== "connect" && method !== "health") {
      return Promise.reject(new RpcError("disconnected", "Not connected to the deployment."));
    }
    return this.#send(method, params, timeoutMs ?? this.#options.requestTimeoutMs);
  }

  /** Subscribes to a pushed event. Returns the unsubscribe function. */
  on<E extends EventName>(event: E, handler: (data: EventData<E>) => void): () => void {
    let set = this.#eventListeners.get(event);
    if (!set) {
      set = new Set();
      this.#eventListeners.set(event, set);
    }
    const entry = handler as (data: never) => void;
    set.add(entry);
    return () => set.delete(entry);
  }

  /** Subscribes to connection state changes; the handler runs once at once with the current state. */
  onState(handler: (state: ConnectionState) => void): () => void {
    this.#stateListeners.add(handler);
    handler(this.#state);
    return () => this.#stateListeners.delete(handler);
  }

  #send<M extends MethodName>(method: M, params: MethodParams<M>, timeoutMs: number): Promise<MethodResult<M>> {
    const socket = this.#socket;
    if (!socket || !this.#opened) return Promise.reject(new RpcError("disconnected", "Not connected to the deployment."));
    this.#seq += 1;
    const id = `r${this.#seq}`;
    return new Promise<MethodResult<M>>((resolve, reject) => {
      const timer = this.#options.timers.setTimeout(() => {
        if (this.#pending.delete(id)) reject(new RpcError("timeout", `${method} did not answer in time.`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch {
        this.#settle(id);
        reject(new RpcError("disconnected", "The connection is not open."));
      }
    });
  }

  #settle(id: string): Pending | undefined {
    const pending = this.#pending.get(id);
    if (!pending) return undefined;
    this.#pending.delete(id);
    this.#options.timers.clearTimeout(pending.timer);
    return pending;
  }

  #open(): void {
    this.#teardown("Reconnecting.");
    this.#setState({ kind: "connecting", attempt: this.#attempt });
    let handle: SocketHandle | null = null;
    const isCurrent = () => this.#socket === handle && handle !== null;
    handle = this.#options.socketFactory(this.#options.url, {
      open: () => {
        if (!isCurrent()) return;
        this.#opened = true;
        void this.#handshake();
      },
      message: (data) => {
        if (isCurrent()) this.#onMessage(data);
      },
      close: (code, reason) => {
        if (isCurrent()) void this.#onClose(code, reason);
      },
    });
    this.#socket = handle;
  }

  async #handshake(): Promise<void> {
    const socket = this.#socket;
    try {
      const session = await this.#send("connect", { protocolVersion: PROTOCOL_VERSION }, this.#options.connectTimeoutMs);
      if (this.#socket !== socket) return;
      this.#ready = true;
      this.#attempt = 0;
      this.#setState({ kind: "open", session });
    } catch (err) {
      if (this.#socket !== socket) return;
      const error = err instanceof RpcError ? err : new RpcError("internal", "The connect request failed.");
      if (error.code === "unauthenticated" || error.code === "forbidden") {
        this.#finish({ kind: "not_allowed", message: error.message });
      } else if (error.code === "invalid") {
        this.#finish({ kind: "incompatible", message: error.message });
      } else {
        this.#teardown(error.message);
        this.#scheduleRetry(error.message);
      }
    }
  }

  #onMessage(raw: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") return;
    const record = frame as Record<string, unknown>;
    if (typeof record.id === "string" && ("result" in record || "error" in record)) {
      const pending = this.#settle(record.id);
      if (!pending) return;
      if ("error" in record) {
        const error = record.error as { code?: unknown; message?: unknown } | null;
        const code = typeof error?.code === "string" ? (error.code as RpcErrorCode) : "internal";
        const message = typeof error?.message === "string" ? error.message : "The request failed.";
        pending.reject(new RpcError(code, message));
      } else {
        pending.resolve(record.result);
      }
      return;
    }
    if (typeof record.event === "string") {
      const listeners = this.#eventListeners.get(record.event);
      if (!listeners) return;
      for (const listener of [...listeners]) {
        try {
          listener(record.data as never);
        } catch {
          // A listener that throws never breaks the connection or the other listeners.
        }
      }
    }
  }

  async #onClose(code: number, reason: string): Promise<void> {
    const wasOpen = this.#opened;
    this.#teardown(reason || "The connection closed.");
    if (this.#stopped) return;
    const byCode = classifyCloseCode(code);
    if (byCode === "not_allowed") return this.#finish({ kind: "not_allowed", message: reason || "This account is not allowed to use the dashboard." });
    if (byCode === "not_configured") return this.#finish({ kind: "not_configured", disabled: false });
    if (!wasOpen && this.#options.probe) {
      const probed = await this.#options.probe();
      if (this.#stopped || this.#socket !== null) return;
      const byStatus = classifyProbeStatus(probed?.status ?? null);
      if (byStatus === "not_allowed") return this.#finish({ kind: "not_allowed", message: "This account is not allowed to use the dashboard, or the sign-in has expired." });
      if (byStatus === "not_configured") return this.#finish({ kind: "not_configured", disabled: probed?.error === "dashboard_disabled" });
      if (probed?.status === 426) {
        // The gateway is configured and on, yet refused the upgrade: an origin or allowlist refusal looks like this.
        return this.#scheduleRetry("The deployment refused the connection. If this continues, this account may not be on the operator allowlist.");
      }
    }
    this.#scheduleRetry(reason || "The connection closed.");
  }

  #finish(state: ConnectionState): void {
    this.#stopped = true;
    this.#clearRetry();
    this.#teardown("Stopped.");
    this.#setState(state);
  }

  #scheduleRetry(reason: string): void {
    if (this.#stopped) return;
    const inMs = backoffDelay(this.#attempt, this.#options.random);
    this.#attempt += 1;
    this.#setState({ kind: "reconnecting", attempt: this.#attempt, inMs, reason });
    this.#retryTimer = this.#options.timers.setTimeout(() => {
      this.#retryTimer = null;
      if (!this.#stopped) this.#open();
    }, inMs);
  }

  #clearRetry(): void {
    if (this.#retryTimer !== null) {
      this.#options.timers.clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
  }

  #teardown(message: string): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#opened = false;
    this.#ready = false;
    for (const id of [...this.#pending.keys()]) this.#settle(id)?.reject(new RpcError("disconnected", message));
    if (socket) {
      try {
        socket.close(1000);
      } catch {
        // Already closed.
      }
    }
  }

  #setState(state: ConnectionState): void {
    this.#state = state;
    for (const listener of [...this.#stateListeners]) {
      try {
        listener(state);
      } catch {
        // A state listener that throws never breaks the client.
      }
    }
  }
}
