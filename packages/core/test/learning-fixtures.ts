// GTM-agents: synthetic fixtures for the self-improvement tests: a served Acme brain in an in-memory
// KV namespace, and a model gateway that answers by role.
import { memoryKv } from "../src/agents/testing.ts";
import { BRAIN_LOCK_KEY, brainFileKey } from "../src/brain/load.ts";
import { computeLock } from "../src/brain/lock.ts";
import type { CompletionRequest, ModelGateway, ModelRole } from "../src/ports/model.ts";
import { replyTestConfig } from "../src/replies/testing.ts";
import { brainFile, factsBody, personasBody, pillarsBody } from "./fixtures.ts";

export const LEARN_MODEL = "learn-test-model";

/** The synthetic Acme config with every role the loops use priced. */
export const learnConfig = () =>
  replyTestConfig({
    models: {
      roles: { strategist: LEARN_MODEL, judge: LEARN_MODEL, writer: LEARN_MODEL, worker: LEARN_MODEL, triage: LEARN_MODEL },
      pricing: { [LEARN_MODEL]: { inputCentsPerMTok: 1, outputCentsPerMTok: 1 } },
    },
  });

/** A served brain: each file under its key, and a lock over all of them. */
export async function servedBrain(extra: Record<string, string> = {}) {
  const files: Record<string, string> = {
    personas: brainFile("personas", personasBody),
    facts: brainFile("facts", factsBody),
    "message-pillars": brainFile("message-pillars", pillarsBody),
    ...extra,
  };
  const kv = memoryKv();
  for (const [component, content] of Object.entries(files)) await kv.put(brainFileKey(component as never), content);
  const lock = await computeLock(Object.entries(files).map(([c, content]) => ({ name: `${c}.md`, content })));
  await kv.put(BRAIN_LOCK_KEY, JSON.stringify(lock));
  return { kv, files };
}

export type RoleAnswer = string | ((request: CompletionRequest) => string);

/** A gateway that answers each role from a table, and records every request. */
export function roleModel(answers: Partial<Record<ModelRole, RoleAnswer>>): ModelGateway & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    name: "role-model",
    requests,
    complete(request) {
      requests.push(request);
      const answer = answers[request.role];
      if (answer === undefined) return Promise.reject(new Error(`no answer for ${request.role}`));
      const text = typeof answer === "function" ? answer(request) : answer;
      return Promise.resolve({ text, toolCalls: [], stopReason: "end", usage: { inputTokens: 100, outputTokens: 50 }, model: LEARN_MODEL });
    },
    embed: () => Promise.reject(new Error("no embeddings")),
  };
}
