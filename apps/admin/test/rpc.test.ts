// GTM-agents: tests for the dashboard RPC client: the connect handshake, one promise per request
// id, timeouts, pushed events, reconnect with backoff, and the "not configured" and "not allowed"
// outcomes. A fake socket stands in for the browser WebSocket.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClient, PROTOCOL_VERSION, RpcError, socketUrl } from "../src/rpc.ts";
import type { ConnectionState, SocketHandlers } from "../src/rpc.ts";

class FakeSocket {
  readonly url: string;
  readonly handlers: SocketHandlers;
  readonly sent: Array<{ id: string; method: string; params: unknown }> = [];
  closedWith: number | undefined;

  constructor(url: string, handlers: SocketHandlers) {
    this.url = url;
    this.handlers = handlers;
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as { id: string; method: string; params: unknown });
  }

  close(code?: number): void {
    this.closedWith = code;
  }

  reply(id: string, result: unknown): void {
    this.handlers.message(JSON.stringify({ id, result }));
  }

  fail(id: string, code: string, message: string): void {
    this.handlers.message(JSON.stringify({ id, error: { code, message } }));
  }

  last(): { id: string; method: string; params: unknown } {
    const frame = this.sent[this.sent.length - 1];
    if (!frame) throw new Error("nothing sent");
    return frame;
  }
}

const SESSION = { operator: { email: "ops@acme.example" }, deployment: { name: "acme-gtm", environment: "production" }, capabilities: ["chat"] };

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function setup(probeStatus: number | null = 426, probeError?: string) {
  const sockets: FakeSocket[] = [];
  const states: ConnectionState[] = [];
  const probe = vi.fn(async () => (probeStatus === null ? null : probeError ? { status: probeStatus, error: probeError } : { status: probeStatus }));
  const client = new GatewayClient({
    url: "wss://gtm.acme.example/ws",
    socketFactory: (url, handlers) => {
      const socket = new FakeSocket(url, handlers);
      sockets.push(socket);
      return socket;
    },
    probe,
    random: () => 0.5,
    requestTimeoutMs: 1000,
  });
  client.onState((state) => states.push(state));
  const current = () => {
    const socket = sockets[sockets.length - 1];
    if (!socket) throw new Error("no socket");
    return socket;
  };
  async function open(): Promise<FakeSocket> {
    const socket = current();
    socket.handlers.open();
    const connect = socket.last();
    socket.reply(connect.id, SESSION);
    await flush();
    return socket;
  }
  return { client, sockets, states, probe, current, open };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GatewayClient", () => {
  it("sends connect first with the protocol version, then reports the session", async () => {
    const t = setup();
    t.client.start();
    const socket = t.current();
    expect(socket.url).toBe("wss://gtm.acme.example/ws");
    socket.handlers.open();
    expect(socket.sent).toHaveLength(1);
    expect(socket.last()).toMatchObject({ method: "connect", params: { protocolVersion: PROTOCOL_VERSION } });
    socket.reply(socket.last().id, SESSION);
    await flush();
    expect(t.client.state).toEqual({ kind: "open", session: SESSION });
  });

  it("refuses calls before the handshake completes", async () => {
    const t = setup();
    t.client.start();
    t.current().handlers.open();
    await expect(t.client.call("status", {})).rejects.toMatchObject({ code: "disconnected" });
  });

  it("resolves each request by its id, out of order", async () => {
    const t = setup();
    t.client.start();
    const socket = await t.open();
    const first = t.client.call("agents.list", {});
    const second = t.client.call("cost.summary", { days: 1 });
    const [a, b] = socket.sent.slice(-2);
    expect(a?.id).not.toBe(b?.id);
    socket.reply(b!.id, { totalCents: 12, byJob: {}, byProvider: {} });
    socket.reply(a!.id, []);
    await expect(second).resolves.toEqual({ totalCents: 12, byJob: {}, byProvider: {} });
    await expect(first).resolves.toEqual([]);
  });

  it("rejects with the server's error code and message", async () => {
    const t = setup();
    t.client.start();
    const socket = await t.open();
    const pending = t.client.call("drafts.approve", { draftId: "d1", shownDigest: "abc" });
    socket.fail(socket.last().id, "conflict", "The draft changed.");
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err).toMatchObject({ code: "conflict", message: "The draft changed." });
  });

  it("times a request out and ignores a late answer", async () => {
    const t = setup();
    t.client.start();
    const socket = await t.open();
    const pending = t.client.call("status", {});
    const id = socket.last().id;
    vi.advanceTimersByTime(1001);
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    expect(() => socket.reply(id, {})).not.toThrow();
  });

  it("delivers pushed events to subscribers until they unsubscribe", async () => {
    const t = setup();
    t.client.start();
    const socket = await t.open();
    const seen: string[] = [];
    const off = t.client.on("chat.delta", (data) => seen.push(data.text));
    t.client.on("chat.delta", () => {
      throw new Error("a broken listener");
    });
    socket.handlers.message(JSON.stringify({ event: "chat.delta", data: { turnId: "t1", text: "Hel" } }));
    socket.handlers.message(JSON.stringify({ event: "chat.delta", data: { turnId: "t1", text: "lo" } }));
    off();
    socket.handlers.message(JSON.stringify({ event: "chat.delta", data: { turnId: "t1", text: "!" } }));
    expect(seen).toEqual(["Hel", "lo"]);
  });

  it("ignores malformed frames", async () => {
    const t = setup();
    t.client.start();
    const socket = await t.open();
    expect(() => {
      socket.handlers.message("not json");
      socket.handlers.message("null");
      socket.handlers.message(JSON.stringify({ id: "unknown", result: 1 }));
    }).not.toThrow();
    expect(t.client.state.kind).toBe("open");
  });

  it("rejects pending requests when the socket drops, then reconnects with backoff", async () => {
    const t = setup();
    t.client.start();
    const socket = await t.open();
    const pending = t.client.call("status", {});
    socket.handlers.close(1006, "");
    await flush();
    await expect(pending).rejects.toMatchObject({ code: "disconnected" });
    expect(t.client.state).toMatchObject({ kind: "reconnecting", attempt: 1, inMs: 375 });
    expect(t.probe).not.toHaveBeenCalled();
    vi.advanceTimersByTime(375);
    expect(t.sockets).toHaveLength(2);
    await t.open();
    expect(t.client.state.kind).toBe("open");
    expect(t.states.filter((state) => state.kind === "open")).toHaveLength(2);
  });

  it("stops at not_allowed when connect is refused", async () => {
    const t = setup();
    t.client.start();
    const socket = t.current();
    socket.handlers.open();
    socket.fail(socket.last().id, "forbidden", "Not on the allowlist.");
    await flush();
    expect(t.client.state).toEqual({ kind: "not_allowed", message: "Not on the allowlist." });
    vi.advanceTimersByTime(60_000);
    expect(t.sockets).toHaveLength(1);
  });

  it("reports not_configured when a failed upgrade probes as 503", async () => {
    const t = setup(503);
    t.client.start();
    t.current().handlers.close(1006, "");
    await flush();
    expect(t.probe).toHaveBeenCalledOnce();
    expect(t.client.state).toEqual({ kind: "not_configured", disabled: false });
    vi.advanceTimersByTime(60_000);
    expect(t.sockets).toHaveLength(1);
  });

  it("tells a disabled dashboard apart from an unconfigured one", async () => {
    const t = setup(503, "dashboard_disabled");
    t.client.start();
    t.current().handlers.close(1006, "");
    await flush();
    expect(t.client.state).toEqual({ kind: "not_configured", disabled: true });
  });

  it("says why when a configured gateway keeps refusing the upgrade", async () => {
    const t = setup(426);
    t.client.start();
    t.current().handlers.close(1006, "");
    await flush();
    expect(t.client.state).toMatchObject({ kind: "reconnecting", reason: expect.stringContaining("allowlist") as unknown });
  });

  it("reports not_allowed when a failed upgrade probes as 403", async () => {
    const t = setup(403);
    t.client.start();
    t.current().handlers.close(1006, "");
    await flush();
    expect(t.client.state.kind).toBe("not_allowed");
  });

  it("keeps retrying when the probe says nothing conclusive", async () => {
    const t = setup(null);
    t.client.start();
    t.current().handlers.close(1006, "");
    await flush();
    expect(t.client.state.kind).toBe("reconnecting");
  });

  it("honours an application close code that refuses the operator", async () => {
    const t = setup();
    t.client.start();
    await t.open();
    t.current().handlers.close(4403, "revoked");
    await flush();
    expect(t.client.state).toEqual({ kind: "not_allowed", message: "revoked" });
  });

  it("closes and stays closed after stop", async () => {
    const t = setup();
    t.client.start();
    const socket = await t.open();
    t.client.stop();
    expect(socket.closedWith).toBe(1000);
    socket.handlers.close(1000, "");
    await flush();
    vi.advanceTimersByTime(60_000);
    expect(t.sockets).toHaveLength(1);
    expect(t.client.state.kind).toBe("stopped");
  });

  it("retryNow skips the remaining backoff", async () => {
    const t = setup();
    t.client.start();
    await t.open();
    t.current().handlers.close(1006, "");
    await flush();
    t.client.retryNow();
    expect(t.sockets).toHaveLength(2);
  });
});

describe("socketUrl", () => {
  it("uses wss on https and the page's own host", () => {
    expect(socketUrl({ protocol: "https:", host: "gtm.acme.example" })).toBe("wss://gtm.acme.example/ws");
    expect(socketUrl({ protocol: "http:", host: "localhost:5173" })).toBe("ws://localhost:5173/ws");
  });
});
