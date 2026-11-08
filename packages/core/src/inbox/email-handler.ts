// GTM-agents: the Worker's email() entry point, for mail Cloudflare Email Routing delivers to the
// deployment.
//
//   createWorker(config, { inboundEmail: { parser: (env) => createAdapter(...), forwardTo: "avery@acme.example" } })
//
// For each routed message, in order:
//   1. with a forward address configured, a copy goes there first, so a person still receives
//      mail the Worker takes in. The forward is claimed in the effects ledger by the message's id,
//      envelope, date and size, so a redelivered message is not forwarded twice (if the ledger
//      cannot be read, the copy is forwarded anyway: a duplicate beats a lost message). A forward
//      that fails makes the handler throw once recording is done, so a redelivery retries it;
//   2. with inbox:enabled off (or unreadable), nothing is recorded. A message that was not
//      forwarded is rejected, so its sender learns it was not delivered instead of it vanishing;
//   3. the parser (the email-cloudflare adapter) turns the raw message into an InboundMessage;
//   4. it is recorded through the same intake as polled mail (intake.ts): dedup, classification,
//      body storage and the deterministic rules. A message that cannot be parsed or recorded makes
//      the handler throw, so the failure shows in Email Routing's activity log instead of passing
//      silently. A message intake skips as unparseable is rejected unless it was forwarded.
// Mail arriving this way is recorded even while the system is halted: recording and its rules can
// only stop or hold mail, never send it, and refusing it would lose a reply.
import type { GtmConfig } from "../config/schema.ts";
import type { Env } from "../env.ts";
import { claimEffect, releaseEffect } from "../events/effects.ts";
import type { JobLogger } from "../jobs/registry.ts";
import type { InboundMessage } from "../ports/email.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { kvFlags } from "../sending/flags.ts";
import { sha256Hex } from "../shared/hash.ts";
import { inboxEnabled } from "./flags.ts";
import { recordInbound, type IntakeResult } from "./intake.ts";

export const FORWARD_EFFECT = "inbox_forward";
export const NOT_ACCEPTING_TEXT = "This address is not accepting mail right now.";

/** What Email Routing hands the email() handler, as much of it as a parser needs. */
export interface RoutedEmail {
  /** The envelope sender (SMTP MAIL FROM). Empty for a delivery report. */
  from: string;
  /** The envelope recipient. */
  to: string;
  raw: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string;
  rawSize?: number;
}

/** An inbound-only adapter that turns a routed message into an InboundMessage. */
export interface RoutedEmailParser {
  readonly name: string;
  /** Throws AdapterError("invalid") for a message it cannot read. */
  parseRouted(message: RoutedEmail): Promise<InboundMessage>;
}

/** The slice of Cloudflare's ForwardableEmailMessage the handler uses. */
export interface RoutedEmailMessage extends RoutedEmail {
  readonly headers: Headers;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<unknown>;
}

export interface InboundEmailOptions<E> {
  /** Build the parser for one message. Return undefined when it is not configured. */
  parser: (env: E) => RoutedEmailParser | undefined;
  operator?: (env: E) => OperatorChannel | undefined;
  /** A verified Email Routing destination that receives a copy of every message. */
  forwardTo?: string | ((env: E) => string | undefined);
  logger?: JobLogger;
  now?: () => Date;
}

export type InboundEmailHandler<E> = (message: RoutedEmailMessage, env: E, ctx: ExecutionContext) => Promise<void>;

const resolve = <E, T>(factory: T | ((env: E) => T | undefined) | undefined, env: E): T | undefined => {
  try {
    return typeof factory === "function" ? (factory as (env: E) => T | undefined)(env) : factory;
  } catch {
    return undefined;
  }
};

/**
 * A stable key for one routed message: its Message-ID together with its envelope, Date and size,
 * so a sender reusing another message's id does not suppress that message's forward.
 */
async function forwardKey(message: RoutedEmailMessage): Promise<string> {
  const id = (message.headers.get("message-id") ?? "").trim().slice(0, 998);
  return `inbox:forward:${await sha256Hex(`${id}|${message.from}|${message.to}|${message.headers.get("date") ?? ""}|${message.rawSize ?? ""}`)}`;
}

/** The email() handler for a deployment that receives mail through Email Routing. */
export function createInboundEmailHandler<E extends Env>(config: GtmConfig, options: InboundEmailOptions<E>): InboundEmailHandler<E> {
  const log = options.logger;
  return async (message, env) => {
    const now = (options.now ?? (() => new Date()))();
    const enabled = await inboxEnabled(kvFlags(env.KV));
    const forwardTo = resolve<E, string>(options.forwardTo, env);
    let forwarded = false;
    let forwardFailed = false;
    if (forwardTo) {
      const key = await forwardKey(message);
      let claimed: boolean;
      try {
        claimed = await claimEffect(env.DB, key, FORWARD_EFFECT);
      } catch {
        claimed = true;
      }
      if (claimed) {
        try {
          await message.forward(forwardTo);
          forwarded = true;
        } catch (error) {
          forwardFailed = true;
          await releaseEffect(env.DB, key, FORWARD_EFFECT);
          log?.error("a routed message could not be forwarded", { error: sanitizeErrorMessage(error) });
        }
      } else {
        forwarded = true;
      }
    }

    if (!enabled) {
      if (forwardFailed) throw new Error("the routed message could not be forwarded");
      if (!forwarded) message.setReject(NOT_ACCEPTING_TEXT);
      return;
    }

    const parser = resolve<E, RoutedEmailParser>(options.parser, env);
    if (!parser) throw new Error("inbound email is on, but no parser is configured (inboundEmail.parser returned nothing)");
    let parsed: InboundMessage;
    try {
      parsed = await parser.parseRouted(message);
    } catch (error) {
      log?.error("a routed message could not be parsed", { error: sanitizeErrorMessage(error) });
      throw new Error("the routed message could not be parsed", { cause: error });
    }
    const result: IntakeResult = await recordInbound(
      {
        db: env.DB,
        bucket: env.BUCKET ?? null,
        kv: env.KV ?? null,
        config,
        provider: parser.name,
        operator: resolve(options.operator, env),
        now,
        ...(log ? { log } : {}),
      },
      [parsed],
    );
    if (result.failed > 0) throw new Error("the routed message could not be recorded");
    // Recording is deduplicated, so failing now lets a redelivery retry the forward safely.
    if (forwardFailed) throw new Error("the routed message was recorded but could not be forwarded");
    // A message intake could not record honestly (an unparseable sender or id) would otherwise
    // vanish: reject it unless a person already has a copy.
    if (result.unparseable > 0 && !forwarded) message.setReject(NOT_ACCEPTING_TEXT);
  };
}
