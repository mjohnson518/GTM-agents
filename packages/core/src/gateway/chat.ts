// GTM-agents: chat with the hub agent from the dashboard.
//
// A message runs the same hub turn as the operator chat (agents/hub.ts): the same tools, taint rules,
// budgets and turn ceiling, in a session of its own per operator email. It runs only while
// operator:agent_enabled is on. /clean, /status and /help work as in the chat. Every other command
// (release, sequence, meeting, autonomy, experiment, lifecycle follow-up and learning commands, and
// any command an optional module contributed) does not run here and never reaches the model: it
// stays in the operator chat, where it is shown with its code. An autonomy proposal is dismissed
// here with Reject in the proposals view, and learnings are decided there too. Drafts a turn
// creates go to the operator chat for approval, the same request a turn there makes.
//
// When the model gateway streams (ModelGateway.stream), the answer arrives as it is written: the hub
// loop hands its text to a ChatStream (chat-stream.ts), which pushes batched chat.delta events and,
// when the turn ends, makes the dashboard show exactly the final reply before chat.done. Tool calls,
// budgets, the turn ceiling and cost records run exactly as without streaming. chat.abort aborts the
// turn's signal, which stops the model's stream and every further delta. A gateway that does not
// stream, and every command, answers with one chat.delta carrying the whole reply, then chat.done.
// History keeps only final replies, never streamed pieces.
import { sessionKeyFor } from "../agents/sessions.ts";
import { runHubTurn } from "../agents/hub.ts";
import { parseAutonomyCommand } from "../autonomy/commands.ts";
import { parseConvertCommand } from "../convert/commands.ts";
import { parseExperimentCommand } from "../experiments/commands.ts";
import { parseLearningCommand } from "../learning/commands.ts";
import { parseFollowupCommand } from "../lifecycle/followup-commands.ts";
import { AGENT_DISABLED_TEXT, isAgentEnabled } from "../operator/access.ts";
import { requestDraftApproval } from "../operator/approvals.ts";
import { parseCommand, parseReleaseCommand, runCommand } from "../operator/commands.ts";
import { matchModuleCommand, moduleHelpLines } from "../operator/module-commands.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { parseSequenceCommand } from "../sequences/commands.ts";
import { ChatStream } from "./chat-stream.ts";
import { RpcError, type GatewayContext, type Handler } from "./context.ts";
import { tryBuild } from "./wiring.ts";

const BASIC_COMMANDS = new Set(["clean", "status", "help", "start"]);

export function dashboardChatId(email: string): string {
  return `dashboard:${email}`;
}

function finish(ctx: GatewayContext, turnId: string, text: string, status: "completed" | "aborted" | "failed", message?: string): void {
  if (text) ctx.push({ event: "chat.delta", data: { turnId, text } });
  ctx.push({ event: "chat.done", data: { turnId, status, ...(message ? { message } : {}) } });
}

/**
 * Drafts a dashboard turn saved go to the operator chat for approval, exactly as a turn there does:
 * the same approval request, bound to each draft's digest, in the first allowlisted chat. Returns
 * what the dashboard says about them. Nothing is ever sent from here.
 */
async function requestApprovals(ctx: GatewayContext, draftIds: readonly string[]): Promise<string> {
  const ids = draftIds.join(", ");
  const channel = tryBuild(ctx.wiring.operator, ctx.env);
  const chatId = ctx.wiring.config.operator.allowedChatIds[0];
  if (!channel || !chatId) return `Drafts saved: ${ids}. No operator chat is configured to approve them in, so they stay pending; nothing was sent.`;
  const failed: string[] = [];
  for (const id of draftIds) {
    try {
      const result = await requestDraftApproval({ db: ctx.env.DB, shown: ctx.env.KV, operator: channel, now: ctx.now }, id, chatId);
      if (!result.ok) failed.push(id);
    } catch {
      failed.push(id);
    }
  }
  if (failed.length === 0) return `Drafts saved: ${ids}. Each is waiting for your approval in the operator chat; nothing was sent.`;
  return `Drafts saved: ${ids}. The approval request for ${failed.join(", ")} could not be shown in the operator chat, so ${failed.length === 1 ? "it stays" : "they stay"} pending; nothing was sent.`;
}

export const chatSend: Handler<"chat.send"> = async (p, ctx) => {
  if (!(await isAgentEnabled(ctx.flags))) throw new RpcError("unavailable", AGENT_DISABLED_TEXT);
  const chatId = dashboardChatId(ctx.state.email);
  const session = { sessionKey: sessionKeyFor(chatId), chatId };
  const turnId = crypto.randomUUID();
  const text = p.text;

  const autonomy = parseAutonomyCommand(text);
  const learning = parseLearningCommand(text);
  // A command is never a task for the model: one that does not run here is refused, not passed on.
  const elsewhere =
    parseReleaseCommand(text) || parseSequenceCommand(text) || parseConvertCommand(text) || autonomy || parseExperimentCommand(text) || parseFollowupCommand(text) || learning || matchModuleCommand(ctx.wiring.commands, text);
  if (elsewhere) {
    ctx.audit.kind = "command_refused";
    const refusal =
      autonomy?.kind === "dismiss"
        ? "Dismiss an autonomy proposal with Reject in the Proposals view, or send this command in the operator chat. Nothing was run."
        : learning
          ? "Learning proposals are listed, approved and rejected in the Proposals view, or with this command in the operator chat. Nothing was run."
          : "That command runs from the operator chat, where its code is shown. Nothing was run.";
    ctx.defer(Promise.resolve().then(() => finish(ctx, turnId, refusal, "completed")));
    return { turnId };
  }
  const command = parseCommand(text);
  if (command) {
    ctx.audit.kind = "command";
    ctx.defer(
      (async () => {
        if (!BASIC_COMMANDS.has(command.name)) return finish(ctx, turnId, `/${command.name} runs from the operator chat or its own view here. Nothing was run.`, "completed");
        try {
          const reply = await runCommand(
            { db: ctx.env.DB, agentName: ctx.wiring.config.agent.name, strategistModel: ctx.wiring.config.models.roles.strategist, moduleHelpLines: moduleHelpLines(ctx.wiring.commands), now: ctx.now },
            command,
            session,
          );
          finish(ctx, turnId, reply, "completed");
        } catch (error) {
          finish(ctx, turnId, "", "failed", sanitizeErrorMessage(error));
        }
      })(),
    );
    return { turnId };
  }

  const model = tryBuild(ctx.wiring.model, ctx.env);
  if (!model) throw new RpcError("unavailable", "no model gateway is configured for this deployment");
  for (const turn of ctx.turns.values()) if (turn.email === ctx.state.email) throw new RpcError("conflict", "a turn is still running; wait for it or abort it");
  const controller = new AbortController();
  ctx.turns.set(turnId, { controller, email: ctx.state.email });
  ctx.audit.kind = "turn";
  const live = model.stream ? new ChatStream({ turnId, push: ctx.push, signal: controller.signal }) : null;
  ctx.defer(
    (async () => {
      try {
        const result = await runHubTurn(
          {
            db: ctx.env.DB,
            kv: ctx.env.KV,
            flags: ctx.flags,
            config: ctx.wiring.config,
            model,
            ...(ctx.wiring.agent.fetch ? { fetch: ctx.wiring.agent.fetch } : {}),
            ...(ctx.wiring.agent.maxRounds !== undefined ? { maxRounds: ctx.wiring.agent.maxRounds } : {}),
            ...(ctx.wiring.agent.maxTokens !== undefined ? { maxTokens: ctx.wiring.agent.maxTokens } : {}),
            now: ctx.now,
          },
          { ...session, text, signal: controller.signal, ...(live ? { onText: (piece: string, round: number) => live.text(piece, round) } : {}) },
        );
        const drafts = result.drafts.length > 0 ? `\n\n${await requestApprovals(ctx, result.drafts.map((d) => d.id))}` : "";
        const reply = `${result.reply}${drafts}`;
        live?.finish(reply);
        finish(ctx, turnId, live ? "" : reply, controller.signal.aborted ? "aborted" : "completed");
      } catch (error) {
        live?.finish("");
        finish(ctx, turnId, "", controller.signal.aborted ? "aborted" : "failed", sanitizeErrorMessage(error));
      } finally {
        ctx.turns.delete(turnId);
      }
    })(),
  );
  return { turnId };
};

export const chatHistory: Handler<"chat.history"> = async (p, ctx) => {
  const chatId = dashboardChatId(ctx.state.email);
  const { results } = await ctx.env.DB.prepare("SELECT role, content, created_at FROM chat_messages WHERE session_key = ?1 ORDER BY id DESC LIMIT ?2")
    .bind(sessionKeyFor(chatId), p.limit ?? 40)
    .all<{ role: string; content: string; created_at: string }>();
  const out: Array<{ role: "operator" | "agent"; text: string; at: string }> = [];
  for (const r of results.reverse()) {
    let text: unknown;
    try {
      text = (JSON.parse(r.content) as { text?: unknown }).text;
    } catch {
      text = undefined;
    }
    if (typeof text === "string") out.push({ role: r.role === "user" ? "operator" : "agent", text, at: r.created_at });
  }
  return out;
};

export const chatAbort: Handler<"chat.abort"> = (p, ctx) => {
  const turn = ctx.turns.get(p.turnId);
  ctx.audit.turnId = p.turnId;
  // Only the operator who started a turn can abort it.
  if (!turn || turn.email !== ctx.state.email) return Promise.resolve({ aborted: false });
  turn.controller.abort();
  return Promise.resolve({ aborted: true });
};
