// GTM-agents: tests for the Worker's email() entry point: routed mail is recorded through intake
// with the inbox on, forwarded once when a forward address is set, and rejected rather than dropped
// with the inbox off. The parser and every message are synthetic.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { memoryKv } from "../src/agents/testing.ts";
import type { Env } from "../src/env.ts";
import { NOT_ACCEPTING_TEXT, type RoutedEmail, type RoutedEmailMessage, type RoutedEmailParser } from "../src/inbox/email-handler.ts";
import { inboundMessage } from "../src/inbox/testing.ts";
import type { InboundMessage } from "../src/ports/email.ts";
import { AdapterError } from "../src/ports/types.ts";
import { createWorker } from "../src/worker.ts";
import { config, failingOn, uid } from "./delivery-fakes.ts";

/** A parser that reads the raw message as JSON overrides for a synthetic InboundMessage. */
function jsonParser(name = uid("routing")): RoutedEmailParser & { parsed: number } {
  const parser = {
    name,
    parsed: 0,
    async parseRouted(message: RoutedEmail): Promise<InboundMessage> {
      parser.parsed += 1;
      const raw = typeof message.raw === "string" ? message.raw : await new Response(message.raw).text();
      try {
        return inboundMessage(JSON.parse(raw) as Partial<InboundMessage>);
      } catch {
        throw new AdapterError("not a message", "invalid", false);
      }
    },
  };
  return parser;
}

function routed(raw: string, messageId: string): RoutedEmailMessage & { rejected: string[]; forwardedTo: string[] } {
  const message = {
    from: "riley@prospect.example",
    to: "avery@acme.example",
    raw,
    rawSize: raw.length,
    headers: new Headers({ "message-id": messageId }),
    rejected: [] as string[],
    forwardedTo: [] as string[],
    setReject(reason: string) {
      message.rejected.push(reason);
    },
    forward(to: string) {
      message.forwardedTo.push(to);
      return Promise.resolve({});
    },
  };
  return message;
}

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

function testEnv(flags: Record<string, string>, db: D1Database = env.DB): Env {
  return { ...(env as unknown as Env), DB: db, KV: memoryKv(flags) as unknown as KVNamespace };
}

async function rowCount(provider: string, id: string): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM inbound_emails WHERE provider = ?1 AND provider_message_id = ?2").bind(provider, id).first<{ n: number }>())?.n ?? 0;
}

describe("the email() entry point", () => {
  it("is exported only when inbound email is configured", () => {
    expect(createWorker(config).email).toBeUndefined();
    expect(createWorker(config, { inboundEmail: { parser: () => jsonParser() } }).email).toBeTypeOf("function");
  });

  it("records routed mail through intake, and forwards a copy once per message", async () => {
    const parser = jsonParser();
    const worker = createWorker(config, { inboundEmail: { parser: () => parser, forwardTo: "inbox-copy@acme.example" } });
    const id = uid("routed");
    const raw = JSON.stringify({ providerMessageId: id, from: { email: `${uid("riley")}@prospect.example` }, subject: "Re: Flaky builds", text: "Yes, please." });
    const first = routed(raw, `<${id}@prospect.example>`);
    await worker.email?.(first as unknown as ForwardableEmailMessage, testEnv({ "inbox:enabled": "true" }), ctx);
    expect(first.forwardedTo).toEqual(["inbox-copy@acme.example"]);
    expect(first.rejected).toEqual([]);
    expect(await rowCount(parser.name, id)).toBe(1);
    expect((await env.DB.prepare("SELECT classification FROM inbound_emails WHERE provider = ?1 AND provider_message_id = ?2").bind(parser.name, id).first())?.classification).toBe("reply");

    const again = routed(raw, `<${id}@prospect.example>`);
    await worker.email?.(again as unknown as ForwardableEmailMessage, testEnv({ "inbox:enabled": "true" }), ctx);
    expect(again.forwardedTo).toEqual([]);
    expect(await rowCount(parser.name, id)).toBe(1);
  });

  it("rejects routed mail with the inbox off and no forward address, recording nothing", async () => {
    const parser = jsonParser();
    const worker = createWorker(config, { inboundEmail: { parser: () => parser } });
    const off = routed(JSON.stringify({ providerMessageId: uid("off") }), `<${uid("off")}@prospect.example>`);
    await worker.email?.(off as unknown as ForwardableEmailMessage, testEnv({}), ctx);
    expect(off.rejected).toEqual([NOT_ACCEPTING_TEXT]);
    expect(parser.parsed).toBe(0);
  });

  it("forwards instead of rejecting with the inbox off, still recording nothing", async () => {
    const parser = jsonParser();
    const worker = createWorker(config, { inboundEmail: { parser: () => parser, forwardTo: () => "inbox-copy@acme.example" } });
    const message = routed(JSON.stringify({ providerMessageId: uid("fwd") }), `<${uid("fwd")}@prospect.example>`);
    await worker.email?.(message as unknown as ForwardableEmailMessage, testEnv({ "inbox:enabled": "false" }), ctx);
    expect(message.forwardedTo).toEqual(["inbox-copy@acme.example"]);
    expect(message.rejected).toEqual([]);
    expect(parser.parsed).toBe(0);
  });

  it("throws after recording when the forward failed, so a redelivery retries it, and rejects mail intake cannot record", async () => {
    const parser = jsonParser();
    const worker = createWorker(config, { inboundEmail: { parser: () => parser, forwardTo: "inbox-copy@acme.example" } });
    const id = uid("fwd-fail");
    const message = routed(JSON.stringify({ providerMessageId: id, from: { email: `${uid("lee")}@prospect.example` } }), `<${id}@prospect.example>`);
    message.forward = () => Promise.reject(new Error("destination not verified"));
    await expect(worker.email?.(message as unknown as ForwardableEmailMessage, testEnv({ "inbox:enabled": "true" }), ctx)).rejects.toThrow(/could not be forwarded/);
    expect(await rowCount(parser.name, id)).toBe(1);

    const bare = createWorker(config, { inboundEmail: { parser: () => parser } });
    const unparseable = routed(JSON.stringify({ providerMessageId: uid("bad-sender"), from: { email: "not an address" } }), `<${uid("bad")}@prospect.example>`);
    await bare.email?.(unparseable as unknown as ForwardableEmailMessage, testEnv({ "inbox:enabled": "true" }), ctx);
    expect(unparseable.rejected).toEqual([NOT_ACCEPTING_TEXT]);
  });

  it("throws when a message cannot be parsed or recorded, so the failure is visible", async () => {
    const parser = jsonParser();
    const worker = createWorker(config, { inboundEmail: { parser: () => parser } });
    await expect(worker.email?.(routed("not json", `<${uid("bad")}@prospect.example>`) as unknown as ForwardableEmailMessage, testEnv({ "inbox:enabled": "true" }), ctx)).rejects.toThrow(/could not be parsed/);
    const id = uid("unrecorded");
    const message = routed(JSON.stringify({ providerMessageId: id, from: { email: `${uid("lee")}@prospect.example` } }), `<${id}@prospect.example>`);
    await expect(worker.email?.(message as unknown as ForwardableEmailMessage, testEnv({ "inbox:enabled": "true" }, failingOn(env.DB, /INSERT INTO inbound_emails/)), ctx)).rejects.toThrow(/could not be recorded/);
    const missing = createWorker(config, { inboundEmail: { parser: () => undefined } });
    await expect(missing.email?.(routed("{}", "<x@prospect.example>") as unknown as ForwardableEmailMessage, testEnv({ "inbox:enabled": "true" }), ctx)).rejects.toThrow(/no parser/);
  });
});
