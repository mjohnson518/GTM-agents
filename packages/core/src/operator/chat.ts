// GTM-agents: the chat queue consumer: operator messages in, replies out.
//
// The webhook verifies, allowlists, deduplicates and enqueues; this consumer does the slow work off
// the webhook path. It handles a delivered batch as runs, in delivery order (planChatRuns): every
// message is its own run, except that with operator:chat_batching on, adjacent messages for the
// model from the same operator in the same session share one run, up to CHAT_RUN_MAX_CHARS of text.
// A command always runs alone, so a run never crosses one (a /clean between two messages keeps them
// apart). A merged run is one hub turn on the messages joined by a blank line, with one reply, one
// turn ceiling and one run row. Which messages go to the model is decided by routeChatText, the
// same matcher the handler below uses, so the two cannot disagree.
//
// For each run it checks the allowlist and the agent flag again (the config or the flag may have
// changed while the message waited), then:
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
//   - a command (/clean, /status, /timers, /help) runs without the model;
//   - a command an optional module contributed (`commands`, module-commands.ts) runs once per
//     message, without the model, after every built-in command has had its turn. A built-in name
//     is never matched as a module command. A handler that throws is answered with a generic
//     error and an audit row, never with its error text;
//   - anything else runs one hub agent turn, sends the reply, and sends an approval request for
//     every draft the turn created, bound to that draft's digest. Each message of the run is
//     claimed on its own before the turn, and one claimed already (a redelivery) is left out.
//     While operator:timers_enabled is on, the turn is offered timer_set, and while
//     operator:notes_enabled is on, note_save and notes_read with the saved notes loaded.
// A message the operator_timers job queued (it carries a timerId) is a timer's turn, and takes none
// of the routes above: it always runs alone, its text is never read, and it is never matched as a
// command. The consumer reads the timer's row, checks it can still fire (still waiting, its operator
// still allowed, the agent and timers on, its session not cleared since it was set), claims it once,
// and runs one hub turn in that session starting at the taint the timer carries (processTimerRun).
// That turn is offered timer_set only when the timer carries no taint, so a tainted timer cannot re-arm.
// Every message is acknowledged after one attempt. A turn is not retried automatically: a retry
// would spend again, and the operator can simply ask again.
import type { GtmConfig } from "../config/schema.ts";
import type { ChatMessage, Env } from "../env.ts";
import type { FlagReader } from "../jobs/registry.ts";
import type { ModelGateway } from "../ports/model.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import type { SendOutreach } from "../sending/types.ts";
import { runHubTurn, type AgentLogger } from "../agents/hub.ts";
import { STORED_MESSAGE_MAX_CHARS } from "../agents/sessions.ts";
import { claimEffect } from "../events/effects.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { AGENT_DISABLED_TEXT, isAgentEnabled, isAllowedOperator, isChatBatchingEnabled, isNotesEnabled, isTimersEnabled } from "./access.ts";
// Timers: later turns the agent set for itself (docs/OPERATOR.md#timers).
import { loadTimer, minuteUtc, timerEffectKey, timerTurnText, transitionTimer, type TimerStatus } from "../agents/timers.ts";
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
export const TIMER_TURN_EFFECT = "operator_timer_turn";
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
  /**
   * True when the Worker registers the operator_timers job (createWorker sets it). Without the job a
   * timer would never fire or expire, so timer_set is offered only with it and operator:timers_enabled.
   */
  timers?: boolean;
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
  if (b.timerId !== undefined && (typeof b.timerId !== "string" || b.timerId.length === 0)) return false;
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

type Parsed<F extends (text: string) => unknown> = NonNullable<ReturnType<F>>;

/** Where one operator message goes: a command, each matched in the order the handler tries them, or a model turn. */
export type ChatRoute<E extends Env = Env> =
  | { kind: "release"; command: Parsed<typeof parseReleaseCommand> }
  | { kind: "sequence"; command: Parsed<typeof parseSequenceCommand> }
  | { kind: "convert"; command: Parsed<typeof parseConvertCommand> }
  | { kind: "autonomy"; command: Parsed<typeof parseAutonomyCommand> }
  | { kind: "experiment"; command: Parsed<typeof parseExperimentCommand> }
  | { kind: "followup"; command: Parsed<typeof parseFollowupCommand> }
  | { kind: "learning"; command: Parsed<typeof parseLearningCommand> }
  | { kind: "reply"; command: Parsed<typeof parseCommand> }
  | { kind: "report"; command: Parsed<typeof parseCommand> }
  | { kind: "module"; matched: MatchedModuleCommand<E> }
  | { kind: "command"; command: Parsed<typeof parseCommand> }
  | { kind: "turn" };

/**
 * Route one message by its text alone. It runs nothing and reads no binding, so the consumer can
 * tell a model turn from a command before anything happens, with the same matchers in the same
 * order the handler uses.
 */
export function routeChatText<E extends Env>(options: Pick<OperatorAgentOptions<E>, "commands">, text: string): ChatRoute<E> {
  const release = parseReleaseCommand(text);
  if (release) return { kind: "release", command: release };
  const sequence = parseSequenceCommand(text);
  if (sequence) return { kind: "sequence", command: sequence };
  const convert = parseConvertCommand(text);
  if (convert) return { kind: "convert", command: convert };
  const autonomy = parseAutonomyCommand(text);
  if (autonomy) return { kind: "autonomy", command: autonomy };
  const experiment = parseExperimentCommand(text);
  if (experiment) return { kind: "experiment", command: experiment };
  const followup = parseFollowupCommand(text);
  if (followup) return { kind: "followup", command: followup };
  const learning = parseLearningCommand(text);
  if (learning) return { kind: "learning", command: learning };
  const command = parseCommand(text);
  if (command && isReplyCommand(command.name)) return { kind: "reply", command };
  if (command && isReportCommand(command.name)) return { kind: "report", command };
  const matched = matchModuleCommand(options.commands, text);
  if (matched) return { kind: "module", matched };
  if (command) return { kind: "command", command };
  return { kind: "turn" };
}

/** The most operator text one merged run carries: what the session history keeps of one message, so a merged turn is never stored cut. */
export const CHAT_RUN_MAX_CHARS = STORED_MESSAGE_MAX_CHARS;
/** What joins the messages of a merged run into the turn's text. */
export const CHAT_RUN_SEPARATOR = "\n\n";

function sameSession(a: ChatMessage, b: ChatMessage): boolean {
  return a.sessionKey === b.sessionKey && a.chatId === b.chatId && a.userId === b.userId;
}

/**
 * Split delivered messages into runs, keeping their order. A message joins the run before it only
 * when `joinable` says both are for the model, they come from the same operator in the same session,
 * and the joined text stays within CHAT_RUN_MAX_CHARS; anything else starts a new run. With
 * `joinable` always false, every message is its own run. A timer's message (timerId) is always its
 * own run, whatever `joinable` says.
 */
export function planChatRuns<T>(items: readonly T[], bodyOf: (item: T) => ChatMessage, joinable: (text: string) => boolean): T[][] {
  const runs: T[][] = [];
  let open: { items: T[]; last: ChatMessage; chars: number } | undefined;
  for (const item of items) {
    const body = bodyOf(item);
    if (body.timerId !== undefined || !joinable(body.text)) {
      runs.push([item]);
      open = undefined;
      continue;
    }
    const chars = (open?.chars ?? 0) + CHAT_RUN_SEPARATOR.length + body.text.length;
    if (open && sameSession(open.last, body) && chars <= CHAT_RUN_MAX_CHARS) {
      open.items.push(item);
      open.last = body;
      open.chars = chars;
      continue;
    }
    open = { items: [item], last: body, chars: body.text.length };
    runs.push(open.items);
  }
  return runs;
}

/** Handle one queued operator message. Never throws. */
export async function processChatMessage<E extends Env>(options: OperatorAgentOptions<E>, env: E, message: ChatMessage): Promise<void> {
  await processChatRun(options, env, [message]);
}

/**
 * Handle one run from planChatRuns: a single message, or messages for the model from one operator
 * in one session, which share one hub turn. Never throws.
 */
export async function processChatRun<E extends Env>(options: OperatorAgentOptions<E>, env: E, run: readonly ChatMessage[]): Promise<void> {
  const message = run[0];
  if (!message) return;
  if (run.length > 1 && !run.every((m) => m.timerId === undefined && sameSession(message, m) && routeChatText(options, m.text).kind === "turn")) {
    // Only messages for the model from one session share a turn; anything else is handled one by one.
    for (const m of run) await processChatRun(options, env, [m]);
    return;
  }
  const log = options.logger ?? quiet;
  const channel = resolveChannel(options.operator, env);
  if (!channel) {
    log.warn("operator channel is not configured; a queued message was dropped", { updateIds: run.map((m) => m.updateId) });
    return;
  }
  if (message.timerId !== undefined) {
    await processTimerRun(options, env, message.timerId, channel, log);
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
    const route: ChatRoute<E> = run.length > 1 ? { kind: "turn" } : routeChatText(options, message.text);
    if (route.kind === "release") {
      const release = route.command;
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
    if (route.kind === "sequence") {
      const sequenceCommand = route.command;
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
    if (route.kind === "convert") {
      const convertCommand = route.command;
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
    if (route.kind === "autonomy") {
      const autonomyCommand = route.command;
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
    if (route.kind === "experiment") {
      const experimentCommand = route.command;
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
    if (route.kind === "followup") {
      const followupCommand = route.command;
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
    if (route.kind === "learning") {
      const learningCommand = route.command;
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
    // Replies: list and settle owed replies, and send approved ones, once per message.
    if (route.kind === "reply") {
      const command = route.command;
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
    if (route.kind === "report") {
      const command = route.command;
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
    if (route.kind === "module") {
      const text = await runModuleCommand(options, env, message, route.matched, log);
      if (text !== null) await reply(text);
      return;
    }
    if (route.kind === "command") {
      const command = route.command;
      let text: string;
      try {
        text = await runCommand(
          {
            db: env.DB,
            agentName: options.config.agent.name,
            strategistModel: options.config.models.roles.strategist,
            moduleHelpLines: moduleHelpLines(options.commands),
            flags,
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
    // Queue delivery is at least once: a redelivered message must not run (and spend on) a second
    // turn. Each message of a run is claimed on its own, so one already handled, alone or in an
    // earlier run, is left out of this turn.
    const claimed: ChatMessage[] = [];
    for (const m of run) {
      if (await claimEffect(env.DB, m.updateId, "operator_chat_turn")) claimed.push(m);
      else log.warn("redelivered chat message was not run again", { updateId: m.updateId });
    }
    if (claimed.length === 0) return;
    const timersOn = options.timers === true && (await isTimersEnabled(flags));
    const notesOn = await isNotesEnabled(flags);
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
        ...(timersOn ? { timers: { userId: message.userId } } : {}),
        ...(notesOn ? { notes: true } : {}),
      },
      { ...session, text: claimed.map((m) => m.text).join(CHAT_RUN_SEPARATOR) },
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
    log.error("operator message failed", { updateIds: run.map((m) => m.updateId), error: sanitizeErrorMessage(error) });
    await reply("Something went wrong while handling that message. Nothing was sent. Please try again.");
  }
}

/**
 * Run the turn a timer starts. Never throws. The queued message gave only the timer's id; everything
 * else comes from its row. A timer fires at most once: it moves to fired with a compare-and-set and
 * is claimed in the effects ledger before its turn. One that can no longer fire is settled without a
 * turn: cancelled when its operator is no longer allowed or its session was cleared since it was set,
 * expired when no model gateway is configured, and back to pending while the agent or timers are off
 * (it fires once both are on again, or expires if that comes too late).
 */
async function processTimerRun<E extends Env>(options: OperatorAgentOptions<E>, env: E, timerId: string, channel: OperatorChannel, log: AgentLogger): Promise<void> {
  const clock = () => options.now?.() ?? new Date();
  // Set once the turn is claimed: nothing is said to the operator about a timer that never ran.
  let chatId: string | undefined;
  const reply = async (text: string) => {
    if (!chatId) return;
    try {
      await channel.notify({ text, chatId });
    } catch (error) {
      log.warn("operator reply failed", { error: sanitizeErrorMessage(error) });
    }
  };
  try {
    const timer = await loadTimer(env.DB, timerId);
    if (!timer) {
      log.warn("a queued timer was not found; the message was dropped", { timerId: timerId.slice(0, 40) });
      return;
    }
    if (timer.status !== "pending" && timer.status !== "queued") {
      log.warn("a queued timer was already settled; the message was dropped", { timerId: timer.id, status: timer.status });
      return;
    }
    // Only the job queues a timer, and only once it is due; a message that arrives early fires nothing.
    if (!(Date.parse(timer.dueAt) <= clock().getTime())) {
      await transitionTimer(env.DB, timer.id, ["queued"], "pending", { queuedAt: null }, clock());
      log.warn("a timer's message arrived before it was due; it waits for the job", { timerId: timer.id });
      return;
    }
    const settle = (to: TimerStatus, reason: string) => transitionTimer(env.DB, timer.id, ["pending", "queued"], to, { reason }, clock());
    if (!isAllowedOperator(options.config.operator, timer.chatId, timer.userId)) {
      await settle("cancelled", "operator no longer allowed");
      log.warn("a timer whose operator is no longer allowed was cancelled", { timerId: timer.id });
      return;
    }
    const flags = flagsFromKv(env.KV);
    if (!(await isAgentEnabled(flags)) || !(await isTimersEnabled(flags))) {
      await transitionTimer(env.DB, timer.id, ["queued"], "pending", { queuedAt: null }, clock());
      return;
    }
    // A session cleared since the timer was set never runs it: its note belongs to the conversation
    // /clean ended. runHubTurn checks the same again when it loads the session.
    const session = await env.DB.prepare("SELECT cleared_at FROM chat_sessions WHERE session_key = ?1").bind(timer.sessionKey).first<{ cleared_at: string | null }>();
    if (!session || session.cleared_at !== timer.sessionClearedAt) {
      await settle("cancelled", "session cleared");
      return;
    }
    let model: ModelGateway | undefined;
    try {
      model = options.model?.(env);
    } catch {
      model = undefined;
    }
    if (!model) {
      await settle("expired", "no model gateway");
      log.warn("a timer expired because no model gateway is configured", { timerId: timer.id });
      return;
    }
    if (!(await transitionTimer(env.DB, timer.id, ["pending", "queued"], "fired", { firedAt: clock().toISOString() }, clock()))) return;
    if (!(await claimEffect(env.DB, timerEffectKey(timer.id), TIMER_TURN_EFFECT))) {
      log.warn("a timer's turn was claimed already; it was not run again", { timerId: timer.id });
      return;
    }
    chatId = timer.chatId;
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
        // A timer carrying taint cannot re-arm itself: its turn is not offered timer_set, so text a
        // note picked up from a record can never keep scheduling turns. A clean timer's turn can.
        ...(timer.taint === "none" && options.timers === true ? { timers: { userId: timer.userId } } : {}),
        ...((await isNotesEnabled(flags)) ? { notes: true } : {}),
      },
      { sessionKey: timer.sessionKey, chatId: timer.chatId, text: timerTurnText(timer), taintFloor: timer.taint, requireClearedAt: timer.sessionClearedAt },
    );
    if (turn.stop === "session_cleared") {
      chatId = undefined;
      await transitionTimer(env.DB, timer.id, ["fired"], "cancelled", { reason: "session cleared" }, clock());
      return;
    }
    try {
      await transitionTimer(env.DB, timer.id, ["fired"], "fired", { firedTurnId: turn.turnId }, clock());
    } catch {
      // Bookkeeping: the turn ran either way.
    }
    await reply(`Timer ${timer.id}, set ${minuteUtc(timer.createdAt)}:\n\n${turn.reply}`);
    for (const draft of turn.drafts) {
      const result = await requestDraftApproval(
        { db: env.DB, shown: env.KV, operator: channel, ...(options.now ? { now: options.now } : {}), logger: log },
        draft.id,
        timer.chatId,
      );
      if (!result.ok) await reply(`Draft ${draft.id} was saved, but its approval request could not be shown (${result.reason}). It stays pending.`);
    }
  } catch (error) {
    log.error("a timer's turn failed", { timerId: timerId.slice(0, 40), error: sanitizeErrorMessage(error) });
    await reply("Something went wrong while running that timer. Nothing was sent. Send /timers to see what is still waiting.");
  }
}

/**
 * The queue consumer for CHAT_QUEUE. Register it under the chat queue's name. Each run is
 * acknowledged once it has been handled, whatever happened; a malformed message is acknowledged and
 * dropped at once.
 */
export function createChatConsumer<E extends Env>(options: OperatorAgentOptions<E>): (batch: MessageBatch, env: E, ctx: ExecutionContext) => Promise<void> {
  return async (batch, env) => {
    const log = options.logger ?? quiet;
    const queued: Array<{ message: MessageBatch["messages"][number]; body: ChatMessage }> = [];
    for (const message of batch.messages) {
      if (isChatMessage(message.body)) queued.push({ message, body: message.body });
      else {
        log.warn("malformed chat queue message was dropped", { id: message.id });
        message.ack();
      }
    }
    // Merging needs two messages, so a lone message costs no flag read. Planning cannot fail today,
    // but if it ever did, every message would still be handled, each as its own run.
    let runs: Array<typeof queued>;
    try {
      const merge = queued.length > 1 && (await isChatBatchingEnabled(flagsFromKv(env.KV)));
      const joinable = merge ? (text: string) => routeChatText(options, text).kind === "turn" : () => false;
      runs = planChatRuns(queued, (q) => q.body, joinable);
    } catch (error) {
      log.warn("chat runs could not be planned; each message runs alone", { error: sanitizeErrorMessage(error) });
      runs = queued.map((q) => [q]);
    }
    for (const run of runs) {
      try {
        await processChatRun(options, env, run.map((q) => q.body));
      } finally {
        for (const q of run) q.message.ack();
      }
    }
  };
}
