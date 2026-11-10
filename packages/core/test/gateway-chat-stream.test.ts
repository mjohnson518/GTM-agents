// GTM-agents: the dashboard chat's streamed replies. Deltas are batched by time and size and never
// approach the frame limit; a later model call's answer replaces an earlier one; the turn ends
// showing exactly its final reply, which is all chat.history keeps; chat.abort stops the stream; a
// gateway that does not stream keeps the single delta. The model is scripted and all data is synthetic.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { recordingOperator, scriptedModel, toolStep, type ScriptStep, type ScriptedStreamOptions } from "../src/agents/testing.ts";
import { defineConfig } from "../src/config/define-config.ts";
import type { Env } from "../src/env.ts";
import { ChatStream, STREAM_MAX_CHARS, chunkText } from "../src/gateway/chat-stream.ts";
import type { ConnectionState, GatewayContext } from "../src/gateway/context.ts";
import { MAX_FRAME_BYTES, handleFrame } from "../src/gateway/dispatch.ts";
import type { ServerEvent } from "../src/gateway/protocol.ts";
import { createJobRegistry } from "../src/jobs/registry.ts";
import type { ModelGateway } from "../src/ports/model.ts";
import type { OperatorChannel } from "../src/ports/operator.ts";
import { acmeConfig } from "./fixtures.ts";

const EMAIL = "ops@acme.example";
const config = defineConfig({
  ...acmeConfig,
  admin: { accessTeamDomain: "acme.cloudflareaccess.com", accessAud: "a".repeat(64), allowedEmails: [EMAIL] },
  models: { roles: { strategist: "test-strategist" }, pricing: { "test-strategist": { inputCentsPerMTok: 400, outputCentsPerMTok: 2000 } } },
});
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Delta = Extract<ServerEvent, { event: "chat.delta" }>["data"];
const deltas = (events: ServerEvent[], turnId?: string): Delta[] =>
  events.flatMap((e) => (e.event === "chat.delta" && (turnId === undefined || e.data.turnId === turnId) ? [e.data] : []));

/** What a dashboard shows for a turn after these deltas. */
function shownText(events: ServerEvent[], turnId?: string): string {
  let text = "";
  for (const d of deltas(events, turnId)) text = d.reset ? d.text : text + d.text;
  return text;
}

function stream(options: { flushMs?: number; maxChars?: number } = {}) {
  const events: ServerEvent[] = [];
  const controller = new AbortController();
  const live = new ChatStream({ turnId: "turn-1", push: (e) => events.push(e), signal: controller.signal, ...options });
  return { events, controller, live };
}

describe("ChatStream", () => {
  it("batches pieces by time into a few deltas that add up to the answer", async () => {
    const s = stream({ flushMs: 20 });
    for (const piece of ["Acme ", "has ", "three ", "plans."]) s.live.text(piece, 1);
    expect(s.events).toHaveLength(0);
    await sleep(40);
    expect(deltas(s.events)).toEqual([{ turnId: "turn-1", text: "Acme has three plans." }]);
    s.live.finish("Acme has three plans.");
    expect(deltas(s.events)).toHaveLength(1);
  });

  it("flushes by size, keeps every frame far under the frame limit, and never splits a character", () => {
    const s = stream({ flushMs: 60_000 });
    const answer = `${"\u0001".repeat(9000)}${"\u{1F680}".repeat(3000)}`;
    for (const ch of answer) s.live.text(ch, 1);
    s.live.finish(answer);
    const frames = s.events.map((e) => new TextEncoder().encode(JSON.stringify(e)).length);
    expect(Math.max(...frames)).toBeLessThan(MAX_FRAME_BYTES / 4);
    expect(s.events.length).toBeLessThanOrEqual(Math.ceil(answer.length / STREAM_MAX_CHARS) + 2);
    expect(shownText(s.events)).toBe(answer);
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const d of deltas(s.events)) expect(lone.test(d.text)).toBe(false);
    expect(chunkText("ab\u{1F680}cd", 3)).toEqual(["ab", "\u{1F680}c", "d"]);
  });

  it("replaces an earlier call's answer once a later call writes real text, and only then", async () => {
    const s = stream({ flushMs: 5 });
    s.live.text("Reading the page.", 1);
    await sleep(15);
    s.live.text("\n", 2);
    await sleep(15);
    expect(shownText(s.events)).toBe("Reading the page.");
    s.live.text("Acme has three plans.", 2);
    await sleep(15);
    expect(deltas(s.events).at(-1)).toEqual({ turnId: "turn-1", text: "\nAcme has three plans.", reset: true });
    s.live.finish("Acme has three plans.");
    expect(shownText(s.events)).toBe("Acme has three plans.");
  });

  it("ends with exactly the final reply: the rest when it continues what was shown, the whole reply otherwise", async () => {
    const a = stream({ flushMs: 5 });
    a.live.text("Three plans.", 1);
    await sleep(15);
    a.live.finish("Three plans.\n\nNote: this session has read a web page.");
    expect(deltas(a.events).at(-1)).toEqual({ turnId: "turn-1", text: "\n\nNote: this session has read a web page." });
    expect(shownText(a.events)).toBe("Three plans.\n\nNote: this session has read a web page.");

    const b = stream({ flushMs: 5 });
    b.live.text("  Three plans.", 1);
    await sleep(15);
    b.live.finish("Three plans.");
    expect(deltas(b.events).at(-1)).toEqual({ turnId: "turn-1", text: "Three plans.", reset: true });

    const c = stream({ flushMs: 5 });
    c.live.text("Partial", 1);
    await sleep(15);
    c.live.finish("");
    expect(shownText(c.events)).toBe("");
    c.live.text("late", 1);
    await sleep(15);
    expect(shownText(c.events)).toBe("");
  });

  it("pushes nothing more once the turn is aborted, until the final reply", async () => {
    const s = stream({ flushMs: 5 });
    s.live.text("Acme ", 1);
    await sleep(15);
    s.controller.abort();
    s.live.text("has three plans.", 1);
    await sleep(15);
    expect(shownText(s.events)).toBe("Acme ");
    s.live.finish("The model call failed: the model call was cancelled");
    expect(shownText(s.events)).toBe("The model call failed: the model call was cancelled");
  });
});

class Kv {
  readonly map = new Map<string, string>([
    ["admin:enabled", "true"],
    ["operator:agent_enabled", "true"],
  ]);
  get = async (k: string) => this.map.get(k) ?? null;
  put = async (k: string, v: string) => void this.map.set(k, v);
  delete = async (k: string) => void this.map.delete(k);
}

function harness(model: ModelGateway, email = `ops+${crypto.randomUUID().slice(0, 8)}@acme.example`, options: { operator?: OperatorChannel; chatIds?: string[] } = {}) {
  const kv = new Kv();
  const events: ServerEvent[] = [];
  const deferred: Array<Promise<unknown>> = [];
  const admin = {
    ...config,
    admin: { accessTeamDomain: "acme.cloudflareaccess.com", accessAud: "a".repeat(64), allowedEmails: [email], allowedOrigins: [] },
    ...(options.chatIds ? { operator: { ...config.operator, allowedChatIds: options.chatIds, allowedUserIds: options.chatIds } } : {}),
  };
  const state: ConnectionState = { email, sub: "u", expiresAt: Date.now() + 3_600_000, connected: true, subscribed: false, rl: { start: Date.now(), requests: 0, mutations: 0, chats: 0 } };
  const ctx: GatewayContext = {
    env: { DB: env.DB, KV: kv } as unknown as Env,
    wiring: { config: admin, registry: () => createJobRegistry([]), lifecycle: false, model: () => model, agent: {}, extensions: {}, ...(options.operator ? { operator: () => options.operator } : {}) },
    state,
    now: () => new Date(),
    actor: `operator:${email}`,
    flags: { get: (k) => kv.get(k) },
    push: (e) => events.push(e),
    broadcast: (e) => events.push(e),
    defer: (t) => deferred.push(t),
    turns: new Map(),
    audit: {},
  };
  let n = 0;
  const call = async <T = unknown>(method: string, params?: unknown) => {
    const out = await handleFrame(JSON.stringify({ id: `r${(n += 1)}`, method, params }), ctx);
    return JSON.parse(out.reply ?? "{}") as { result?: T; error?: { code: string; message: string } };
  };
  const settle = async () => {
    while (deferred.length > 0) await Promise.all(deferred.splice(0));
  };
  return { events, call, settle };
}

const spaced = (ms: number, extra: ScriptedStreamOptions = {}): ScriptedStreamOptions => ({ chunkChars: 4, between: () => sleep(ms), ...extra });

describe("drafts a dashboard turn saves", () => {
  const drafting = () =>
    scriptedModel([toolStep({ name: "drafts_create", input: { recipient_email: "jane@globex.example", subject: "Flaky builds", body: "Hi Jane,\n\nA short note.\n\nAvery" } }), { text: "Saved a draft for Jane." }]);

  it("go to the operator chat for approval, bound to their digest, and nothing is sent", async () => {
    const operator = recordingOperator();
    const h = harness(drafting(), undefined, { operator: operator.channel, chatIds: ["1001"] });
    const sent = await h.call<{ turnId: string }>("chat.send", { text: "Draft a note to Jane at Globex." });
    await h.settle();
    const shown = shownText(h.events, sent.result?.turnId ?? "");
    expect(shown).toContain("waiting for your approval in the operator chat");
    expect(operator.approvals).toHaveLength(1);
    expect(operator.approvals[0]).toMatchObject({ chatId: "1001", kind: "send" });
    expect(operator.approvals[0]?.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stay pending, and the dashboard says so, when no operator chat is configured", async () => {
    const h = harness(drafting());
    const sent = await h.call<{ turnId: string }>("chat.send", { text: "Draft a note to Jane at Globex." });
    await h.settle();
    expect(shownText(h.events, sent.result?.turnId ?? "")).toContain("No operator chat is configured to approve them in, so they stay pending");
  });
});

describe("chat.send with a streaming model", () => {
  it("streams the reply in several batched deltas and keeps only the final reply in chat.history", async () => {
    const answer = "Acme has three plans: Starter, Team and Enterprise, each billed monthly.";
    const h = harness(scriptedModel([{ text: answer }], { stream: spaced(30) }));
    const sent = await h.call<{ turnId: string }>("chat.send", { text: "What plans does Acme have?" });
    const turnId = sent.result?.turnId ?? "";
    await h.settle();
    const pushed = deltas(h.events, turnId);
    expect(pushed.length).toBeGreaterThan(1);
    expect(pushed.length).toBeLessThan(Math.ceil(answer.length / 4));
    expect(shownText(h.events, turnId)).toBe(answer);
    expect(h.events.at(-1)).toEqual({ event: "chat.done", data: { turnId, status: "completed" } });
    const history = await h.call<Array<{ role: string; text: string }>>("chat.history", {});
    expect(history.result?.map((m) => [m.role, m.text])).toEqual([
      ["operator", "What plans does Acme have?"],
      ["agent", answer],
    ]);
  });

  it("shows a later call's answer in place of the text written before a tool call", async () => {
    const steps: ScriptStep[] = [{ ...toolStep({ name: "contacts_search", input: { query: "okafor" } }), text: "Let me look." }, { text: "No contacts at Acme yet." }];
    const h = harness(scriptedModel(steps, { stream: spaced(30) }));
    const sent = await h.call<{ turnId: string }>("chat.send", { text: "Who do we know at Acme?" });
    const turnId = sent.result?.turnId ?? "";
    await h.settle();
    expect(deltas(h.events, turnId).some((d) => d.reset === true)).toBe(true);
    expect(shownText(h.events, turnId)).toBe("No contacts at Acme yet.");
  });

  it("stops the stream on chat.abort, and ends showing the reply the history keeps", async () => {
    let abort: () => Promise<unknown> = () => Promise.resolve();
    const model = scriptedModel([{ text: "Acme has three plans, billed monthly, with a free trial." }], {
      stream: {
        chunkChars: 4,
        between: async (index) => {
          if (index === 2) await abort();
          else await sleep(5);
        },
      },
    });
    const h = harness(model);
    const sent = await h.call<{ turnId: string }>("chat.send", { text: "Plans?" });
    const turnId = sent.result?.turnId ?? "";
    abort = () => h.call("chat.abort", { turnId });
    await h.settle();
    const done = h.events.at(-1);
    expect(done?.event === "chat.done" && done.data.status).toBe("aborted");
    const history = await h.call<Array<{ role: string; text: string }>>("chat.history", {});
    const reply = history.result?.at(-1)?.text ?? "";
    expect(reply).toMatch(/cancelled/);
    expect(shownText(h.events, turnId)).toBe(reply);
    expect(deltas(h.events, turnId).map((d) => d.text).join("")).not.toContain("monthly");
  });

  it("keeps the single delta when the model gateway does not stream", async () => {
    const h = harness(scriptedModel([{ text: "Acme has three plans." }]));
    const sent = await h.call<{ turnId: string }>("chat.send", { text: "Plans?" });
    const turnId = sent.result?.turnId ?? "";
    await h.settle();
    expect(deltas(h.events, turnId)).toEqual([{ turnId, text: "Acme has three plans." }]);
    expect(h.events.at(-1)).toEqual({ event: "chat.done", data: { turnId, status: "completed" } });
  });
});
