// GTM-agents: chat with the hub agent from the dashboard.
//
// A message runs the same hub turn as the operator chat (agents/hub.ts): the same tools, taint rules,
// budgets and turn ceiling, in a session of its own per operator email. It runs only while
// operator:agent_enabled is on. /clean, /status and /help work as in the chat; the release and
// confirm commands do not run here: they stay in the operator chat, where their codes are shown.
// Drafts a turn creates wait for approval in the drafts view. The model gateway does not stream, so
// a turn's answer arrives as one chat.delta followed by chat.done.
import { sessionKeyFor } from "../agents/sessions.ts";
import { runHubTurn } from "../agents/hub.ts";
import { parseAutonomyCommand } from "../autonomy/commands.ts";
import { parseConvertCommand } from "../convert/commands.ts";
import { parseExperimentCommand } from "../experiments/commands.ts";
import { AGENT_DISABLED_TEXT, isAgentEnabled } from "../operator/access.ts";
import { parseCommand, parseReleaseCommand, runCommand } from "../operator/commands.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { parseSequenceCommand } from "../sequences/commands.ts";
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

export const chatSend: Handler<"chat.send"> = async (p, ctx) => {
  if (!(await isAgentEnabled(ctx.flags))) throw new RpcError("unavailable", AGENT_DISABLED_TEXT);
  const chatId = dashboardChatId(ctx.state.email);
  const session = { sessionKey: sessionKeyFor(chatId), chatId };
  const turnId = crypto.randomUUID();
  const text = p.text;

  if (parseReleaseCommand(text) || parseSequenceCommand(text) || parseConvertCommand(text) || parseAutonomyCommand(text) || parseExperimentCommand(text)) {
    ctx.audit.kind = "command_refused";
    ctx.defer(Promise.resolve().then(() => finish(ctx, turnId, "That command runs from the operator chat, where its code is shown. Nothing was run.", "completed")));
    return { turnId };
  }
  const command = parseCommand(text);
  if (command) {
    ctx.audit.kind = "command";
    ctx.defer(
      (async () => {
        if (!BASIC_COMMANDS.has(command.name)) return finish(ctx, turnId, `/${command.name} runs from the operator chat or its own view here. Nothing was run.`, "completed");
        try {
          const reply = await runCommand({ db: ctx.env.DB, agentName: ctx.wiring.config.agent.name, strategistModel: ctx.wiring.config.models.roles.strategist, now: ctx.now }, command, session);
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
          { ...session, text, signal: controller.signal },
        );
        const drafts = result.drafts.length > 0 ? `\n\nDrafts saved for approval: ${result.drafts.map((d) => d.id).join(", ")}. Review them in the drafts view; nothing was sent.` : "";
        finish(ctx, turnId, `${result.reply}${drafts}`, controller.signal.aborted ? "aborted" : "completed");
      } catch (error) {
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
