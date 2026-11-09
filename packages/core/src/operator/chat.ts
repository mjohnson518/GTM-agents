// GTM-agents: the chat queue consumer: one operator message in, one reply out.
//
// The webhook verifies, allowlists, deduplicates and enqueues; this consumer does the slow work off
// the webhook path. For each message it checks the allowlist and the agent flag again (the config
// or the flag may have changed while the message waited), then:
//   - `batch-release-<id>-<code>` releases a waiting cold batch through the send function, once
//     per message, without the model;
//   - a sequence command (`sequence-release-<id>-<code>`, `sequence-resume-<contact id>`,
//     `channel-done-<id>`, `channel-skip-<id>`) runs once per message, without the model;
//   - a reply command (/replies, /reply_done, /reply_ignore, /reply_send, /reply_draft) runs once
//     per message, without the model;
//   - a report command (/scorecard, /report ...) reads and replies once per message, without the
//     model;
//   - a command (/clean, /status, /help) runs without the model;
//   - anything else runs one hub agent turn, sends the reply, and sends an approval request for
//     every draft the turn created, bound to that draft's digest.
// Every message is acknowledged after one attempt. A turn is not retried automatically: a retry
// would spend again, and the operator can simply ask again.
import type { GtmConfig } from "../config/schema.ts";
import type { ChatMessage, Env } from "../env.ts";
import type { FlagReader } from "../jobs/registry.ts";
import type { ModelGateway } from "../ports/model.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import type { SendOutreach } from "../sending/types.ts";
import { runHubTurn, type AgentLogger } from "../agents/hub.ts";
import { claimEffect } from "../events/effects.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { AGENT_DISABLED_TEXT, isAgentEnabled, isAllowedOperator } from "./access.ts";
import { requestDraftApproval } from "./approvals.ts";
import { parseCommand, parseReleaseCommand, runCommand, runReleaseCommand } from "./commands.ts";
// Sequences: follow-up release, resume and manual-touch commands, and the send function for steps.
import type { EmailProvider } from "../ports/email.ts";
import { senderDepsFromEnv } from "../sending/jobs.ts";
import { parseSequenceCommand, runSequenceCommand } from "../sequences/commands.ts";
import { createSequenceSender } from "../sequences/sender.ts";
// Replies: the reply commands, and the warm mailbox approved replies go out through.
import type { InboxProvider } from "../ports/email.ts";
import { isReplyCommand, runReplyCommand } from "../replies/commands.ts";
// Reports: the scorecard and the other reports on demand.
import { isReportCommand, runReportCommand } from "../reports/commands.ts";

export const RELEASE_EFFECT = "operator_batch_release";
export const REPLY_COMMAND_EFFECT = "operator_reply_command";
export const SEQUENCE_COMMAND_EFFECT = "operator_sequence_command";
export const REPORT_COMMAND_EFFECT = "operator_report_command";

export interface OperatorAgentOptions<E extends Env = Env> {
  config: GtmConfig;
  /** The operator channel. Undefined or a throw means it is not configured. */
  operator: (env: E) => OperatorChannel | undefined;
  /** The model gateway the hub agent calls. */
  model?: (env: E) => ModelGateway | undefined;
  /** The send function a released cold batch goes through. Without it, releases are refused. */
  sendOutreach?: (env: E) => SendOutreach | undefined;
  /**
   * The email provider released follow-up steps go out through (with every check the send function
   * runs; a step that must wait stays due for the sweep), and that looks up Message-IDs for
   * threading. Without it, sequence releases are refused.
   */
  email?: (env: E) => EmailProvider | undefined;
  /**
   * The warm mailbox the reply commands read threads from and send approved replies through
   * (docs/REPLIES.md). Without it, /reply_send refuses and replies are answered from the mail client.
   */
  inbox?: (env: E) => InboxProvider | undefined;
  maxRounds?: number;
  maxTokens?: number;
  /** The fetch web_fetch uses. Defaults to the global fetch. */
  fetch?: typeof fetch;
  now?: () => Date;
  logger?: AgentLogger;
}

const quiet: AgentLogger = {
  info: () => {},
  warn: (msg, data) => console.warn(JSON.stringify({ level: "warn", msg, scope: "operator", ...(data ?? {}) })),
  error: (msg, data) => console.error(JSON.stringify({ level: "error", msg, scope: "operator", ...(data ?? {}) })),
};

/** Flags from the KV binding. A missing binding or a read error throws, and each gate fails closed. */
export function flagsFromKv(kv: KVNamespace | undefined): FlagReader {
  return {
    get: async (key) => {
      if (!kv) throw new Error("the KV binding is missing");
      return kv.get(key);
    },
  };
}

/** Build the channel, treating a throw (a missing secret, bad options) as "not configured". */
export function resolveChannel<E extends Env>(factory: ((env: E) => OperatorChannel | undefined) | undefined, env: E): OperatorChannel | undefined {
  try {
    return factory?.(env) ?? undefined;
  } catch {
    return undefined;
  }
}

export function isChatMessage(body: unknown): body is ChatMessage {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  return ["updateId", "chatId", "userId", "sessionKey", "text"].every((k) => {
    const value = b[k];
    return typeof value === "string" && value.length > 0;
  });
}

/** Handle one queued operator message. Never throws. */
export async function processChatMessage<E extends Env>(options: OperatorAgentOptions<E>, env: E, message: ChatMessage): Promise<void> {
  const log = options.logger ?? quiet;
  const channel = resolveChannel(options.operator, env);
  if (!channel) {
    log.warn("operator channel is not configured; a queued message was dropped", { updateId: message.updateId });
    return;
  }
  const reply = async (text: string) => {
    try {
      await channel.notify({ text, chatId: message.chatId });
    } catch (error) {
      log.warn("operator reply failed", { error: sanitizeErrorMessage(error) });
    }
  };
  try {
    if (!isAllowedOperator(options.config.operator, message.chatId, message.userId)) {
      log.warn("queued message from a chat that is no longer allowed was dropped", { chatId: message.chatId });
      return;
    }
    const flags = flagsFromKv(env.KV);
    if (!(await isAgentEnabled(flags))) {
      await reply(AGENT_DISABLED_TEXT);
      return;
    }
    const session = { sessionKey: message.sessionKey, chatId: message.chatId };
    const release = parseReleaseCommand(message.text);
    if (release) {
      // Queue delivery is at least once: a redelivered release must not run twice. (Each draft is
      // also claimed before it is handed over, so even a second run could not send it again.)
      if (!(await claimEffect(env.DB, message.updateId, RELEASE_EFFECT))) {
        log.warn("redelivered release command was not run again", { updateId: message.updateId });
        return;
      }
      let send: SendOutreach | undefined;
      try {
        send = options.sendOutreach?.(env);
      } catch {
        send = undefined;
      }
      let text: string;
      try {
        text = await runReleaseCommand(
          { db: env.DB, flags, kv: env.KV, send, config: options.config, userId: message.userId, ...(options.now ? { now: options.now } : {}) },
          release,
        );
      } catch (error) {
        text = `That release could not be completed (${sanitizeErrorMessage(error)}). Drafts not yet handed over stay waiting; send the same command again to retry.`;
      }
      await reply(text);
      return;
    }
    // Sequences: follow-up release, resume and manual-touch commands, once per message.
    const sequenceCommand = parseSequenceCommand(message.text);
    if (sequenceCommand) {
      if (!(await claimEffect(env.DB, message.updateId, SEQUENCE_COMMAND_EFFECT))) {
        log.warn("redelivered sequence command was not run again", { updateId: message.updateId });
        return;
      }
      const provider = (() => {
        try {
          return options.email?.(env);
        } catch {
          return undefined;
        }
      })();
      const send = provider ? createSequenceSender(senderDepsFromEnv(env, { config: options.config, provider, operator: channel, ...(options.now ? { now: options.now } : {}) })) : undefined;
      let text: string;
      try {
        text = await runSequenceCommand(
          { db: env.DB, flags, kv: env.KV, config: options.config, send, provider, userId: message.userId, ...(options.now ? { now: options.now } : {}) },
          sequenceCommand,
        );
      } catch (error) {
        text = `That command could not be completed (${sanitizeErrorMessage(error)}). Nothing more was sent; send the same command again to retry.`;
      }
      await reply(text);
      return;
    }
    const command = parseCommand(message.text);
    // Replies: list and settle owed replies, and send approved ones, once per message.
    if (command && isReplyCommand(command.name)) {
      if (!(await claimEffect(env.DB, message.updateId, REPLY_COMMAND_EFFECT))) {
        log.warn("redelivered reply command was not run again", { updateId: message.updateId });
        return;
      }
      let inbox: InboxProvider | undefined;
      try {
        inbox = options.inbox?.(env);
      } catch {
        inbox = undefined;
      }
      let text: string;
      try {
        text = await runReplyCommand(
          {
            db: env.DB,
            kv: env.KV,
            shown: env.KV,
            flags,
            config: options.config,
            operator: channel,
            ...(inbox ? { inbox } : {}),
            unsubscribeSigningKey: env.UNSUBSCRIBE_SIGNING_KEY,
            baseUrl: env.AGENT_BASE_URL,
            ...(options.now ? { now: options.now } : {}),
            log,
          },
          command,
          { chatId: message.chatId, userId: message.userId },
        );
      } catch (error) {
        text = `That command could not be completed (${sanitizeErrorMessage(error)}). Send it again to retry.`;
      }
      await reply(text);
      return;
    }
    // Reports: the scorecard and the other reports on demand, read-only, once per message.
    if (command && isReportCommand(command.name)) {
      if (!(await claimEffect(env.DB, message.updateId, REPORT_COMMAND_EFFECT))) {
        log.warn("redelivered report command was not run again", { updateId: message.updateId });
        return;
      }
      let text: string;
      try {
        text = await runReportCommand({ db: env.DB, flags, ...(options.now ? { now: options.now } : {}) }, command);
      } catch (error) {
        text = `That report could not be built (${sanitizeErrorMessage(error)}). Send the command again to retry.`;
      }
      await reply(text);
      return;
    }
    if (command) {
      let text: string;
      try {
        text = await runCommand(
          { db: env.DB, agentName: options.config.agent.name, strategistModel: options.config.models.roles.strategist, ...(options.now ? { now: options.now } : {}) },
          command,
          session,
        );
      } catch (error) {
        text = `That command could not be completed: ${sanitizeErrorMessage(error)}`;
      }
      await reply(text);
      return;
    }

    let model: ModelGateway | undefined;
    try {
      model = options.model?.(env);
    } catch {
      model = undefined;
    }
    if (!model) {
      await reply("No model gateway is configured for this deployment, so I cannot work on tasks yet. Commands still work: send /help.");
      return;
    }
    // Queue delivery is at least once: a redelivered message must not run (and spend on) a second turn.
    if (!(await claimEffect(env.DB, message.updateId, "operator_chat_turn"))) {
      log.warn("redelivered chat message was not run again", { updateId: message.updateId });
      return;
    }
    const turn = await runHubTurn(
      {
        db: env.DB,
        kv: env.KV,
        flags,
        config: options.config,
        model,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.maxRounds !== undefined ? { maxRounds: options.maxRounds } : {}),
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options.now ? { now: options.now } : {}),
        logger: log,
      },
      { ...session, text: message.text },
    );
    await reply(turn.reply);
    for (const draft of turn.drafts) {
      const result = await requestDraftApproval(
        { db: env.DB, shown: env.KV, operator: channel, ...(options.now ? { now: options.now } : {}), logger: log },
        draft.id,
        message.chatId,
      );
      if (!result.ok) await reply(`Draft ${draft.id} was saved, but its approval request could not be shown (${result.reason}). It stays pending.`);
    }
  } catch (error) {
    log.error("operator message failed", { updateId: message.updateId, error: sanitizeErrorMessage(error) });
    await reply("Something went wrong while handling that message. Nothing was sent. Please try again.");
  }
}

/** The queue consumer for CHAT_QUEUE. Register it under the chat queue's name. */
export function createChatConsumer<E extends Env>(options: OperatorAgentOptions<E>): (batch: MessageBatch, env: E, ctx: ExecutionContext) => Promise<void> {
  return async (batch, env) => {
    for (const message of batch.messages) {
      try {
        if (isChatMessage(message.body)) await processChatMessage(options, env, message.body);
        else (options.logger ?? quiet).warn("malformed chat queue message was dropped", { id: message.id });
      } finally {
        message.ack();
      }
    }
  };
}
