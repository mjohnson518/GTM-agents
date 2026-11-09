// GTM-agents: what every dashboard method handler receives: the bindings, the deployment's wiring, the
// connection's verified identity, and ways to push events.
import type { z } from "zod";
import type { Env } from "../env.ts";
import type { FlagReader } from "../jobs/registry.ts";
import { kvFlags } from "../sending/flags.ts";
import type { PARAMS } from "./params.ts";
import type { MethodName, MethodResult, RpcErrorCode, ServerEvent } from "./protocol.ts";
import type { GatewayWiring } from "./wiring.ts";

/** Per-connection state, kept in the socket's attachment so it survives hibernation. */
export interface ConnectionState {
  /** From the verified Access token at upgrade; never from a request. */
  email: string;
  sub: string;
  /** When the Access token expires (ms). Requests after it close the socket so the dashboard reconnects. */
  expiresAt: number;
  connected: boolean;
  subscribed: boolean;
  /** The current rate-limit window. */
  rl: { start: number; requests: number; mutations: number; chats: number };
}

export class RpcError extends Error {
  readonly code: RpcErrorCode;
  constructor(code: RpcErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RunningTurn {
  controller: AbortController;
  email: string;
}

export interface GatewayContext<E extends Env = Env> {
  env: E;
  wiring: GatewayWiring<E>;
  state: ConnectionState;
  now: () => Date;
  /** "operator:<email>", as recorded on every row a dashboard action writes. */
  actor: string;
  flags: FlagReader;
  /** Push an event to this connection. */
  push: (event: ServerEvent) => void;
  /** Push an event to every connected dashboard. */
  broadcast: (event: ServerEvent) => void;
  /** Work that continues after the response is sent (a chat turn). */
  defer: (task: Promise<unknown>) => void;
  /** Chat turns in progress in this object, by turn id. */
  turns: Map<string, RunningTurn>;
  /** Extra audit details a mutating handler records: ids, counts and enum values only. */
  audit: Record<string, string | number | boolean | null>;
}

export type ParsedParams<M extends MethodName> = z.output<(typeof PARAMS)[M]>;

export type Handler<M extends MethodName> = (params: ParsedParams<M>, ctx: GatewayContext) => Promise<MethodResult<M>>;

export type Handlers = { [M in MethodName]: Handler<M> };

export function contextFlags(env: Env): FlagReader {
  return kvFlags(env.KV);
}

/** Run a read that is only for display: an error gives null rather than failing the whole view. */
export async function shown<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/** An opaque cursor over a numeric or text key. */
export function encodeCursor(value: string | number): string {
  return `c1.${btoa(String(value)).replace(/=+$/, "")}`;
}

export function decodeCursor(cursor: string | undefined): string | null {
  if (!cursor) return null;
  if (!/^c1\.[A-Za-z0-9+/]{1,200}$/.test(cursor)) throw new RpcError("invalid", "that cursor is not one this server issued");
  try {
    return atob(cursor.slice(3));
  } catch {
    throw new RpcError("invalid", "that cursor is not one this server issued");
  }
}
