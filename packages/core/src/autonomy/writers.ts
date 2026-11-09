// GTM-agents: the outbound writer registry: every module that writes text a prospect reads, the
// action class its text is sent under, and the hermetic eval that scores it.
//
// A class whose actions put text in front of a prospect may be proposed for promotion only when
// every writer of that class is listed here with an eval (evalGap). A class with no listed writer
// has no eval by definition and is never proposed. The evals live in tests/evals/ and run in the
// pre-commit hook and in CI (`npm run eval`), never in the Worker, so a deployed build has passed
// them; tests/evals/writers.eval.ts fails when a writer listed here with an eval has no suite
// there. This map is static code: nothing the agent can call writes it, and changing it is a code
// change a person reviews. A value in KV saying "the eval passed" would be something a tool or a
// mistaken script could set.
//
// Adding a writer: list it here with its classes, add its suite to tests/evals/writers.eval.ts
// (deterministic scorers from scorers.ts, and a fake model for a model-based writer), and point
// evalFile at that file.
import type { ActionClass } from "./levels.ts";

export interface OutboundWriter {
  id: string;
  /** What it writes. */
  writes: string;
  /** The module that produces the text. */
  module: string;
  /** The classes its text is sent under. */
  actionClasses: readonly ActionClass[];
  /** How the text is produced. */
  source: "template" | "model" | "fixed";
  /** The eval that scores it, as a path from the repository root, or null when none does yet. */
  evalFile: string | null;
}

export const WRITER_EVAL_FILE = "tests/evals/writers.eval.ts";

export const OUTBOUND_WRITERS: readonly OutboundWriter[] = Object.freeze([
  {
    id: "cold-intro",
    writes: "the cold first touch, rendered from the operator's approved template",
    module: "packages/core/src/outreach/compose.ts",
    actionClasses: ["cold_batch"],
    source: "template",
    evalFile: WRITER_EVAL_FILE,
  },
  {
    id: "follow-up-steps",
    writes: "the cold sequence's follow-up steps, threaded under the first email",
    module: "packages/core/src/sequences/compose.ts",
    actionClasses: ["cold_batch"],
    source: "template",
    evalFile: WRITER_EVAL_FILE,
  },
  {
    id: "reply-drafter",
    writes: "answers to replies, written by the writer model from approved material",
    module: "packages/core/src/replies/draft.ts",
    actionClasses: ["reply_send", "reply_demo_link", "reply_question"],
    source: "model",
    evalFile: WRITER_EVAL_FILE,
  },
  {
    id: "meeting-recap",
    writes: "the note after a held meeting",
    module: "packages/core/src/convert/drafts.ts",
    actionClasses: ["post_meeting_followup"],
    source: "fixed",
    evalFile: WRITER_EVAL_FILE,
  },
  {
    id: "meeting-rebook",
    writes: "the note after a no-show or a cancelled meeting",
    module: "packages/core/src/convert/drafts.ts",
    actionClasses: ["rebook"],
    source: "fixed",
    evalFile: WRITER_EVAL_FILE,
  },
  {
    id: "post-demo-follow-ups",
    writes: "the two follow-ups after a held meeting, on day 4 and day 10",
    module: "packages/core/src/convert/drafts.ts",
    actionClasses: ["post_meeting_followup"],
    source: "fixed",
    evalFile: WRITER_EVAL_FILE,
  },
  {
    id: "operator-agent-drafts",
    writes: "drafts the operator asks the chat agent for",
    module: "packages/core/src/tools/drafts-create.ts",
    actionClasses: ["other"],
    source: "model",
    evalFile: null,
  },
] satisfies OutboundWriter[]);

/** The writers whose text is sent under a class. */
export function writersFor(actionClass: string): OutboundWriter[] {
  return OUTBOUND_WRITERS.filter((w) => (w.actionClasses as readonly string[]).includes(actionClass));
}

/** Why a class cannot be promoted for lack of an eval, or null when every writer of it has one. Pure. */
export function evalGap(actionClass: string): string | null {
  const writers = writersFor(actionClass);
  if (writers.length === 0) return `no outbound writer is registered for ${actionClass}, so no eval covers its text`;
  const missing = writers.filter((w) => !w.evalFile);
  if (missing.length > 0) return `no eval covers ${missing.map((w) => w.id).join(", ")}, which writes ${actionClass}'s text`;
  return null;
}
