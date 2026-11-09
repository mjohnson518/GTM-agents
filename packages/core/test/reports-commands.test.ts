// GTM-agents: tests for the report commands in the operator chat: what each returns, that they never
// reach the model, and that a redelivered message runs one once. Every value is synthetic.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordingOperator } from "../src/agents/testing.ts";
import { defineConfig } from "../src/config/index.ts";
import type { Env } from "../src/env.ts";
import { processChatMessage } from "../src/operator/chat.ts";
import { helpText, parseCommand } from "../src/operator/commands.ts";
import { flagReader } from "../src/outreach/testing.ts";
import { isReportCommand, runReportCommand } from "../src/reports/commands.ts";
import { acmeConfig } from "./fixtures.ts";

const db = env.DB;
const NOW = new Date("2020-06-17T12:00:00.000Z");
const OPERATOR = "7310002";
const config = defineConfig({ ...acmeConfig, operator: { allowedChatIds: [OPERATOR], allowedUserIds: [OPERATOR] } });
const run = (text: string) => {
  const command = parseCommand(text);
  if (!command) throw new Error(`not a command: ${text}`);
  return runReportCommand({ db, flags: flagReader({}), now: () => NOW }, command);
};

describe("the report commands", () => {
  it("are /scorecard and /report, and the help text lists them", () => {
    expect(isReportCommand("scorecard")).toBe(true);
    expect(isReportCommand("report")).toBe(true);
    expect(isReportCommand("reply_done")).toBe(false);
    expect(helpText("Avery")).toContain("/scorecard");
    expect(helpText("Avery")).toContain("/report conversion");
  });

  it("show each report as of now", async () => {
    expect(await run("/scorecard")).toContain("GTM scorecard for 2020-06-16 (UTC)");
    expect(await run("/report conversion")).toContain("Conversion, first touches sent 2020-05-18 to 2020-06-16 (UTC)");
    expect(await run("/report conversion template")).toMatch(/^Conversion by template/);
    expect(await run("/report funnel")).toContain("Funnel digest for 2020-06-10 to 2020-06-16 (UTC)");
    expect(await run("/report cost")).toContain("Spend for 2020-06-16 (UTC): $0.00");
    expect(await run("/report holdout")).toContain("Holdout lift, contacts who entered");
  });

  it("explain themselves for anything else", async () => {
    expect(await run("/report")).toContain("/report conversion");
    expect(await run("/report weather")).toContain("/report conversion");
    expect(await run("/report conversion tier")).toContain("Unknown dimension");
    expect(await run("/report funnel now please")).toContain("/report conversion");
  });
});

describe("the report commands in the chat", () => {
  beforeEach(async () => {
    await env.KV.put("operator:agent_enabled", "true");
  });
  afterEach(async () => {
    await env.KV.delete("operator:agent_enabled");
  });

  it("answer without the model, once per message", async () => {
    const operator = recordingOperator();
    const options = {
      config,
      operator: () => operator.channel,
      model: () => {
        throw new Error("the model must not be called");
      },
      now: () => NOW,
    };
    const message = { updateId: `operator:${OPERATOR}:${crypto.randomUUID()}`, chatId: OPERATOR, userId: OPERATOR, sessionKey: OPERATOR, text: "/scorecard" };
    await processChatMessage(options, env as unknown as Env, message);
    await processChatMessage(options, env as unknown as Env, message);
    expect(operator.messages).toHaveLength(1);
    expect(operator.messages[0]?.text).toContain("GTM scorecard for 2020-06-16 (UTC)");
    expect(operator.messages[0]?.chatId).toBe(OPERATOR);
  });
});
