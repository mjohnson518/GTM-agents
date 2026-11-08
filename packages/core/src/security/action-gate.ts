// GTM-agents: the action gate.
//
// The attack this stops: an attacker's page or email is read (the session becomes fully tainted),
// it carries an instruction, and the model calls a tool that sends, writes or spends. The gate
// refuses that call. It reads only the tool's class:
//   - a tool is refused when the session's taint has reached the tool's gate level, so a tool
//     refused at one level is refused at every higher level (gates never loosen as taint rises);
//   - an unknown tool is fully tainted and refused once anything untrusted has been read;
//   - a human-only tool runs only with an operator approval whose digest matches its exact input.
// Every refusal names the tool and tells the operator how to clear the session. The dispatcher in
// runtime/dispatcher.ts calls these checks before any tool runs; nothing else may run a tool.
import { toolInputDigest } from "./approval-digest.ts";
import { safeToolName } from "./fence.ts";
import { isRefusedAt, type TaintLevel } from "./taint.ts";
import type { ToolClass } from "./tool-classes.ts";

export type BlockCode = "tainted" | "human_only" | "egress" | "unsafe_url" | "check_failed" | "unavailable" | "invalid_input";

export interface Refusal {
  allowed: false;
  code: BlockCode;
  message: string;
}

export type GateResult = { allowed: true } | Refusal;

export const ALLOWED: GateResult = Object.freeze({ allowed: true });

const WHAT_WAS_READ: Record<Exclude<TaintLevel, "none">, string> = {
  metadata: "third-party text (subjects, snippets or search results)",
  structured: "values extracted from untrusted text",
  full: "raw untrusted text (a web page, an email body or similar)",
};

const CLEAR_SESSION =
  "The refusal lasts for the rest of this session, because that text is still in context. " +
  "The operator can start a clean session and ask again, or take the action by hand.";

export function blocked(code: BlockCode, tool: string, detail: string): Refusal {
  return { allowed: false, code, message: `[ACTION BLOCKED] ${safeToolName(tool)} was not run: ${detail}` };
}

/** The taint check: is a tool of this class refused in a session at `taint`? */
export function checkActionGate(tool: string, cls: ToolClass, taint: TaintLevel): GateResult {
  if (taint === "none" || !isRefusedAt(cls.gate, taint)) return ALLOWED;
  return blocked("tainted", tool, `this session has read ${WHAT_WAS_READ[taint]}, and ${safeToolName(tool)} is refused from ${cls.gate} taint up. ${CLEAR_SESSION}`);
}

/** An operator approval of one exact tool call, attached by the operator path, never by a model. */
export interface HumanApproval {
  digest: string;
}

/** The human-only check: a human-only tool needs an approval of this exact input. */
export async function checkHumanApproval(tool: string, cls: ToolClass, input: unknown, approval: HumanApproval | undefined): Promise<GateResult> {
  if (!cls.humanOnly) return ALLOWED;
  const detail = `${safeToolName(tool)} is human-only and runs only with an operator approval of this exact input.`;
  if (!approval) return blocked("human_only", tool, detail);
  try {
    if ((await toolInputDigest(tool, input)) === approval.digest) return ALLOWED;
  } catch {
    // An input that cannot be digested cannot match an approval.
  }
  return blocked("human_only", tool, `${detail} The approval does not match this input.`);
}
