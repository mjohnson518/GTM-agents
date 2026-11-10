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
//   - a meeting command (/meetings, `meeting-held-<code>`, `meeting-noshow-<code>`,
//     `meeting-notes-<code>`, `meeting-link-<code>`, `meeting-unlink-<code>`, `prep-<contact>`) runs
//     once per message, without the model;
//   - a report command (/scorecard, /report ...) reads and replies once per message, without the
//     model;
//   - an autonomy command (`autonomy-status`, `autonomy-set <class> <0-3>`,
//     `autonomy-confirm-<id>-<code>`) runs once per message, without the model. These are the only
//     way a level is raised from the chat, and only an allowlisted operator reaches them;
//   - an experiment command (`experiment-create`, `experiment-start <id>`,
//     `experiment-start-<id>-<code>`, `exp-approve-<id>`, `ab-dashboard` and the rest in
//     experiments/commands.ts) runs once per message, without the model. Experiments start and
//     proposals apply only from here;
//   - a lifecycle follow-up command (`fu-approve-<id>`, `fu-reject-<id>`) runs once per message,
//     without the model. An approved follow-up goes through the send function after every check
//     runs again (lifecycle/followup-commands.ts);
//   - a self-improvement command (`learning-list`, `learning-show <id>`,
//     `learning-approve-<id>-<code>`, `learning-reject-<id>`, `learnings`, `objection-list`,
//     `objection-answer`, `voice-build`, `voice-status`, `fitness`) runs once per message, without
//     the model. Proposals apply only from here or the dashboard, bound to the detail shown;
//   - a command (/clean, /status, /help) runs without the model;
//   - a command an optional module contributed (`commands`, module-commands.ts) runs once per
//     message, without the model, after every built-in command has had its turn. A built-in name
//     is never matched as a module command. A handler that throws is answered with a generic
//     error and an audit row, never with its error text;
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
// Convert: the meeting commands and the prep brief on demand.
import { parseConvertCommand, runConvertCommand } from "../convert/commands.ts";
// Autonomy: the level commands (docs/AUTONOMY.md).
import { parseAutonomyCommand, runAutonomyCommand } from "../autonomy/commands.ts";
// Experiments: create, start (two steps), stop, proposals and the A/B dashboard (docs/EXPERIMENTS.md).
import { parseExperimentCommand, runExperimentCommand } from "../experiments/commands.ts";
// Lifecycle follow-ups: approve or drop a follow-up drafted for a product user.
import { parseFollowupCommand, runFollowupCommand } from "../lifecycle/followup-commands.ts";
import { servedTemplates } from "../experiments/jobs.ts";
import type { TemplateFile } from "../templates/store.ts";
// Self-improvement: proposals apply only from here or the dashboard, bound to the detail shown (docs/LEARNING.md).
import { parseLearningCommand, runLearningCommand } from "../learning/commands.ts";
// Optional modules: commands they contribute, matched before the model.
import { writeAudit } from "../events/audit.ts";
import { matchModuleCommand, moduleHelpLines, type MatchedModuleCommand, type ModuleCommand } from "./module-commands.ts";

export const RELEASE_EFFECT = "operator_batch_release";
export const REPLY_COMMAND_EFFECT = "operator_reply_command";
export const SEQUENCE_COMMAND_EFFECT = "operator_sequence_command";
export const REPORT_COMMAND_EFFECT = "operator_report_command";
export const CONVERT_COMMAND_EFFECT = "operator_convert_command";
export const AUTONOMY_COMMAND_EFFECT = "operator_autonomy_command";
export const EXPERIMENT_COMMAND_EFFECT = "operator_experiment_command";
export const FOLLOWUP_COMMAND_EFFECT = "operator_followup_command";
export const LEARNING_COMMAND_EFFECT = "operator_learning_command";
export const MODULE_COMMAND_EFFECT = "operator_module_command";
/** What the operator reads when a module command throws. Its error text is never shown. */
export const MODULE_COMMAND_FAILED_TEXT = "That command could not be completed. Nothing more was done; send it again to retry, and check the Worker's logs if it keeps failing.";

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
  /** The reply window given to createReplyJobs, so /scorecard counts owed replies the same way. */
  owedWindowDays?: number;
  /** The fetch web_fetch uses. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /**
   * Templates bundled with the Worker, when the deployment bundles them for the cold batch, so the
   * experiment commands check against the same copy the batch sends. Without them, templates are
   * served from KV.
   */
  templates?: readonly TemplateFile[];
  /**
   * Commands contributed by optional modules (packages/modules). Each is matched before the model,
   * after the allowlist, the agent flag and every built-in command; /help lists their help lines.
   */
  commands?: ReadonlyArray<ModuleCommand<E>>;
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

/**
 * Run a matched module command once per message and return the reply. Never throws: a throwing
 * handler is answered with MODULE_COMMAND_FAILED_TEXT and leaves an audit row naming the module.
 * A redelivered message returns null: it was handled already, so nothing runs and nothing is sent.
 */
async function runModuleCommand<E extends Env>(options: OperatorAgentOptions<E>, env: E, message: ChatMessage, matched: MatchedModuleCommand<E>, log: AgentLogger): Promise<string | null> {
  // Queue delivery is at least once: a redelivered command must not run twice.
  if (!(await claimEffect(env.DB, message.updateId, MODULE_COMMAND_EFFECT))) {
    log.warn("redelivered module command was not run again", { updateId: message.updateId, module: matched.module });
    return null;
  }
  const now = options.now?.() ?? new Date();
  try {
    const text = await matched.handler({ env, now, actor: `operator:${message.userId}`, sessionKey: message.sessionKey });
    return typeof text === "string" && text.trim() !== "" ? text : "Done.";
  } catch (error) {
    log.error("module command failed", { module: matched.module, error: sanitizeErrorMessage(error) });
    await writeAudit(env.DB, { agentId: "operator", action: "module_command_failed", details: { module: matched.module.slice(0, 40), update: message.updateId.slice(0, 120) }, now });
    return MODULE_COMMAND_FAILED_TEXT;
  }
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
    // Convert: the meeting commands and the prep brief on demand, once per message.
    const convertCommand = parseConvertCommand(message.text);
    if (convertCommand) {
      if (!(await claimEffect(env.DB, message.updateId, CONVERT_COMMAND_EFFECT))) {
        log.warn("redelivered meeting command was not run again", { updateId: message.updateId });
        return;
      }
      let text: string;
      try {
        text = await runConvertCommand(
          { db: env.DB, flags, config: options.config, operator: channel, shown: env.KV, chatId: message.chatId, userId: message.userId, ...(options.now ? { now: options.now } : {}), log },
          convertCommand,
        );
      } catch (error) {
        text = `That command could not be completed (${sanitizeErrorMessage(error)}). Nothing was sent; send it again to retry.`;
      }
      await reply(text);
      return;
    }
    // Autonomy: levels are set only here, by an allowlisted operator, in two steps; once per message.
    const autonomyCommand = parseAutonomyCommand(message.text);
    if (autonomyCommand) {
      if (!(await claimEffect(env.DB, message.updateId, AUTONOMY_COMMAND_EFFECT))) {
        log.warn("redelivered autonomy command was not run again", { updateId: message.updateId });
        return;
      }
      let text: string;
      try {
        text = await runAutonomyCommand({ db: env.DB, kv: env.KV, flags, config: options.config, userId: message.userId, ...(options.now ? { now: options.now } : {}) }, autonomyCommand);
      } catch (error) {
        text = `That command could not be completed (${sanitizeErrorMessage(error)}). Nothing changed; send it again to retry.`;
      }
      await reply(text);
      return;
    }
    // Experiments: experiments start in two steps and proposals apply only from here; once per message.
    const experimentCommand = parseExperimentCommand(message.text);
    if (experimentCommand) {
      if (!(await claimEffect(env.DB, message.updateId, EXPERIMENT_COMMAND_EFFECT))) {
        log.warn("redelivered experiment command was not run again", { updateId: message.updateId });
        return;
      }
      let text: string;
      try {
        text = await runExperimentCommand(
          { db: env.DB, kv: env.KV, flags, templates: servedTemplates(env.KV, options.config, flags, options.templates), userId: message.userId, ...(options.now ? { now: options.now } : {}) },
          experimentCommand,
        );
      } catch (error) {
        text = `That command could not be completed (${sanitizeErrorMessage(error)}). Nothing changed; send it again to retry.`;
      }
      await reply(text);
      return;
    }
    // Lifecycle follow-ups: an approval sends through the send function after every check; once per message.
    const followupCommand = parseFollowupCommand(message.text);
    if (followupCommand) {
      if (!(await claimEffect(env.DB, message.updateId, FOLLOWUP_COMMAND_EFFECT))) {
        log.warn("redelivered follow-up command was not run again", { updateId: message.updateId });
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
        text = await runFollowupCommand(
          { db: env.DB, flags, config: options.config, send, operator: channel, chatId: message.chatId, userId: message.userId, ...(options.now ? { now: options.now } : {}), log },
          followupCommand,
        );
      } catch (error) {
        text = `That command could not be completed (${sanitizeErrorMessage(error)}). Nothing more was sent; send it again to retry.`;
      }
      await reply(text);
      return;
    }
    // Self-improvement: list, show, approve and reject proposals, objection answers and the voice profile; once per message.
    const learningCommand = parseLearningCommand(message.text);
    if (learningCommand) {
      if (!(await claimEffect(env.DB, message.updateId, LEARNING_COMMAND_EFFECT))) {
        log.warn("redelivered learning command was not run again", { updateId: message.updateId });
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
        text = await runLearningCommand({ db: env.DB, kv: env.KV, flags, ...(inbox ? { inbox } : {}), userId: message.userId, ...(options.now ? { now: options.now } : {}) }, learningCommand);
      } catch (error) {
        text = `That command could not be completed (${sanitizeErrorMessage(error)}). Nothing was applied; send it again to retry.`;
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
        text = await runReportCommand({ db: env.DB, flags, ...(options.now ? { now: options.now } : {}), ...(options.owedWindowDays !== undefined ? { owedWindowDays: options.owedWindowDays } : {}) }, command);
      } catch (error) {
        text = `That report could not be built (${sanitizeErrorMessage(error)}). Send the command again to retry.`;
      }
      await reply(text);
      return;
    }
    // Optional modules: a command a module contributed, once per message, never to the model.
    const moduleCommand = matchModuleCommand(options.commands, message.text);
    if (moduleCommand) {
      const text = await runModuleCommand(options, env, message, moduleCommand, log);
      if (text !== null) await reply(text);
      return;
    }
    if (command) {
      let text: string;
      try {
        text = await runCommand(
          {
            db: env.DB,
            agentName: options.config.agent.name,
            strategistModel: options.config.models.roles.strategist,
            moduleHelpLines: moduleHelpLines(options.commands),
            ...(options.now ? { now: options.now } : {}),
          },
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
