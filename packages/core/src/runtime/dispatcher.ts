// GTM-agents: the tool dispatcher. Every tool call, from any agent, runs through executeToolCall.
//
// In order:
//   0. validate the call: the name must be a tool-name string, and the input is snapshotted once
//      as plain JSON, which every check and the handler then share;
//   1. classify the tool from the registry (an undeclared name is full taint, gate metadata);
//   2. the action gate: refuse when the session's taint has reached the tool's gate;
//   3. the human-only check: refuse without an operator approval of this exact input;
//   4. egress: every URL in an egress tool's input must pass validateUrl, and at full taint the
//      input may not carry data out (an email address, an encoded blob, a long query string);
//   5. the pre-call checks, where rate limits and budgets plug in; a check that throws refuses;
//   6. run the handler (a name with no handler is not run);
//   7. raise the session's taint to the tool's taint, any taint the handler reports and, for
//      delegation tools, any marker in the result. A delegation that reports neither, or fails,
//      raises the caller to full taint. Taint rises on failure too, because an error message can
//      carry remote text;
//   8. sanitize the output, fencing it whenever the call's effective taint is above none.
// A refused call never invokes its handler and never raises the session's taint.
import { ALLOWED, blocked, checkActionGate, checkHumanApproval, type BlockCode, type GateResult, type HumanApproval, type Refusal } from "../security/action-gate.ts";
import { preserveTaintMarker, readTaintMarker } from "../security/delegation-taint.ts";
import { safeToolName } from "../security/fence.ts";
import type { ToolRegistry } from "../security/registry.ts";
import { sanitizeErrorMessage, sanitizeToolOutput } from "../security/sanitize.ts";
import { maxTaintLevel, raiseTaint, toTaintLevel, type TaintLevel, type TaintedSession } from "../security/taint.ts";
import type { ToolClass } from "../security/tool-classes.ts";
import { checkEgress, findUrls, validateUrl } from "../security/url-validator.ts";

export interface ToolCall {
  name: string;
  input: unknown;
}

/** The session a call runs in. The dispatcher raises `taint` in place; it never lowers it. */
export interface ToolSession extends TaintedSession {
  readonly id?: string;
}

export interface ToolHandlerContext {
  /** The session's taint when the call started. A delegation starts its worker here. */
  taint: TaintLevel;
  signal?: AbortSignal;
}

/** A handler returns text, or text plus extra taint it observed (a worker's final taint). */
export type ToolHandlerResult = string | { text: string; taint?: TaintLevel };

export type ToolHandler = (input: Record<string, unknown>, ctx: ToolHandlerContext) => Promise<ToolHandlerResult>;

/** A check that runs after the security gates and before the handler, such as a rate limit. */
export type PreCallCheck = (call: ToolCall, cls: ToolClass, session: Readonly<ToolSession>) => GateResult | Promise<GateResult>;

export interface DispatcherDeps {
  registry: ToolRegistry;
  handlers: Readonly<Record<string, ToolHandler>>;
  checks?: readonly PreCallCheck[];
  logger?: { warn(msg: string, data?: Record<string, unknown>): void };
}

/** Set by the trusted caller (the operator path), never taken from model output. */
export interface CallOptions {
  approval?: HumanApproval;
  signal?: AbortSignal;
}

export type DispatchResult =
  | { status: "ok"; content: string; taint: TaintLevel; redactions: number; truncated: boolean }
  | { status: "blocked"; code: BlockCode; content: string; taint: TaintLevel }
  | { status: "error"; content: string; taint: TaintLevel };

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * One JSON snapshot of the input. Every check and the handler see this same plain data, so an
 * input with getters or a Proxy cannot show the checks one value and the handler another.
 */
function snapshot(input: unknown): Record<string, unknown> | null {
  try {
    const copy = JSON.parse(JSON.stringify(input)) as unknown;
    return isPlainObject(copy) ? copy : null;
  } catch {
    return null;
  }
}

function egressGate(name: string, input: Record<string, unknown>, cls: ToolClass, taint: TaintLevel): GateResult {
  if (!cls.egress) return ALLOWED;
  const urls = findUrls(input);
  if (!urls) return blocked("egress", name, "the input is too large or too deeply nested to check.");
  for (const url of urls) {
    const check = validateUrl(url);
    if (!check.ok) return blocked("unsafe_url", name, `${check.reason}.`);
  }
  if (taint !== "full") return ALLOWED;
  const egress = checkEgress(cls.egress, input);
  return egress.ok ? ALLOWED : blocked("egress", name, `this session holds raw untrusted text and ${egress.reason}. Try again without that data.`);
}

export async function executeToolCall(deps: DispatcherDeps, session: ToolSession, call: ToolCall, options: CallOptions = {}): Promise<DispatchResult> {
  session.taint = toTaintLevel(session.taint);
  const taint = session.taint;
  const refuse = (gate: Refusal): DispatchResult => {
    try {
      deps.logger?.warn("tool call refused", { tool: safeToolName(call.name), code: gate.code, taint });
    } catch {
      // Logging is bookkeeping: it never changes the outcome.
    }
    return { status: "blocked", code: gate.code, content: gate.message, taint };
  };

  // The name must be a plain tool-name string, so the registry and the handler table see the same key.
  const name: unknown = call.name;
  if (typeof name !== "string" || !TOOL_NAME.test(name)) {
    return refuse(blocked("invalid_input", "unknown", "the tool name is not a valid tool name."));
  }
  const input = snapshot(call.input);
  if (!input) return refuse(blocked("invalid_input", name, "the input must be a JSON object."));
  const cls = deps.registry.classify(name);
  const checked: ToolCall = { name, input };

  const gates: Array<() => GateResult | Promise<GateResult>> = [
    () => checkActionGate(name, cls, taint),
    () => checkHumanApproval(name, cls, input, options.approval),
    () => egressGate(name, input, cls, taint),
    ...(deps.checks ?? []).map((check) => () => check(checked, cls, session)),
  ];
  for (const gate of gates) {
    let result: GateResult;
    try {
      result = await gate();
    } catch {
      result = blocked("check_failed", name, "a safety check could not be completed, so the call was refused.");
    }
    if (!result.allowed) return refuse(result);
  }

  const handler = Object.hasOwn(deps.handlers, name) ? deps.handlers[name] : undefined;
  if (!handler) return refuse(blocked("unavailable", name, "no tool by that name is available."));

  let raw: string;
  let reported: TaintLevel | undefined;
  try {
    const result = await handler(input, { taint, signal: options.signal });
    raw = typeof result === "string" ? result : String(result.text);
    if (typeof result !== "string" && result.taint !== undefined) reported = toTaintLevel(result.taint);
  } catch (error) {
    // A failed delegation cannot report what its worker read, so the caller assumes the worst.
    const effective = cls.delegates ? "full" : cls.taint;
    raiseTaint(session, effective);
    const sanitized = sanitizeToolOutput(`Tool error: ${sanitizeErrorMessage(error)}`, {
      tool: name,
      taint: effective,
      toolNamePattern: deps.registry.toolNamePattern,
    });
    return { status: "error", content: sanitized.text, taint: session.taint };
  }

  let effective = maxTaintLevel(cls.taint, reported ?? "none");
  if (cls.delegates) {
    const marker = readTaintMarker(raw);
    // A delegation that reports neither a taint nor a marker is assumed to have read anything.
    effective = reported === undefined && marker === "none" ? "full" : maxTaintLevel(effective, marker);
  }
  raiseTaint(session, effective);
  const sanitized = sanitizeToolOutput(raw, { tool: name, taint: effective, toolNamePattern: deps.registry.toolNamePattern });
  const content = cls.delegates ? preserveTaintMarker(raw, sanitized.text) : sanitized.text;
  return { status: "ok", content, taint: session.taint, redactions: sanitized.redactions, truncated: sanitized.truncated };
}
