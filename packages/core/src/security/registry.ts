// GTM-agents: the tool registry. It merges core's tool classes with the tools that adapter manifests
// declare, and answers one question for the action gate: what class is this tool?
//
// Merging fails closed:
//   - a manifest tool that omits `gate` gets "metadata" (refused once anything untrusted is read);
//   - two sources declaring the same tool name is a configuration error, not a silent override;
//   - a name that nobody declared classifies as UNKNOWN_TOOL_CLASS (full taint, gate metadata);
//   - a tool in PERMANENT_HUMAN_TOOLS that is not declared humanOnly is a configuration error, and
//     one that nobody declared classifies as unknown and human-only.
import { manifestToolSchema } from "../ports/manifest-schema.ts";
import { GATE_LEVELS, TAINT_LEVELS } from "./taint.ts";
import { CORE_TOOL_CLASSES, PERMANENT_HUMAN_TOOLS, UNKNOWN_TOOL_CLASS, type ToolClass } from "./tool-classes.ts";

const TOOL_NAME = /^[a-z][a-z0-9_]*$/;

const UNKNOWN_PERMANENT_HUMAN_CLASS: ToolClass = Object.freeze({ ...UNKNOWN_TOOL_CLASS, humanOnly: true });

export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRegistryError";
  }
}

/** The part of an adapter manifest the registry reads. Parsed and unparsed manifests both fit. */
export interface ManifestTools {
  name: string;
  tools?: Readonly<Record<string, unknown>>;
}

export interface ToolRegistryOptions {
  /** Core's classes. Defaults to CORE_TOOL_CLASSES. */
  core?: Readonly<Record<string, ToolClass>>;
  /** Adapter and module manifests whose `tools` join the registry. */
  manifests?: readonly ManifestTools[];
}

export interface ToolRegistry {
  /** Every declared tool name, sorted. */
  readonly names: readonly string[];
  /** The declared class, or UNKNOWN_TOOL_CLASS. */
  classify(name: string): ToolClass;
  isDeclared(name: string): boolean;
  /** Where a tool was declared: "core" or the manifest's name. */
  sourceOf(name: string): string | undefined;
  /**
   * Matches any declared tool name that contains an underscore, as a whole word, for redacting
   * tool names out of untrusted text. Not global, so `.test()` is stateless. Null when there are none.
   */
  readonly toolNamePattern: RegExp | null;
}

function checkClass(name: string, source: string, cls: ToolClass): ToolClass {
  if (!TOOL_NAME.test(name)) throw new ToolRegistryError(`${source}: tool name "${name}" must be snake_case`);
  if (!(TAINT_LEVELS as readonly string[]).includes(cls.taint)) {
    throw new ToolRegistryError(`${source}: tool "${name}" has an unknown taint level`);
  }
  if (!(GATE_LEVELS as readonly string[]).includes(cls.gate)) {
    throw new ToolRegistryError(`${source}: tool "${name}" has an unknown gate level`);
  }
  return Object.freeze({ ...cls });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createToolRegistry(options: ToolRegistryOptions = {}): ToolRegistry {
  const classes = new Map<string, ToolClass>();
  const sources = new Map<string, string>();

  const add = (name: string, source: string, cls: ToolClass) => {
    const existing = sources.get(name);
    if (existing !== undefined) {
      throw new ToolRegistryError(`tool "${name}" is declared by both ${existing} and ${source}; rename one of them`);
    }
    classes.set(name, checkClass(name, source, cls));
    sources.set(name, source);
  };

  for (const [name, cls] of Object.entries(options.core ?? CORE_TOOL_CLASSES)) add(name, "core", cls);

  for (const manifest of options.manifests ?? []) {
    const source = `adapter "${manifest.name}"`;
    for (const [name, raw] of Object.entries(manifest.tools ?? {})) {
      const parsed = manifestToolSchema.safeParse(raw);
      if (!parsed.success) throw new ToolRegistryError(`${source}: tool "${name}" has an invalid declaration`);
      const { taint, gate, egress, humanOnly, rateCategory } = parsed.data;
      add(name, source, {
        taint,
        gate,
        ...(egress ? { egress } : {}),
        ...(humanOnly ? { humanOnly } : {}),
        ...(rateCategory ? { rateCategory } : {}),
      });
    }
  }

  for (const [name, actionClass] of Object.entries(PERMANENT_HUMAN_TOOLS)) {
    const cls = classes.get(name);
    if (cls && !cls.humanOnly) {
      throw new ToolRegistryError(`tool "${name}" performs the permanently human action ${actionClass} and must be declared humanOnly`);
    }
  }

  const names = Object.freeze([...classes.keys()].sort());
  const redactable = names.filter((n) => n.includes("_")).sort((a, b) => b.length - a.length);
  const toolNamePattern = redactable.length
    ? new RegExp(`\\b(?:${redactable.map(escapeRegExp).join("|")})\\b`, "i")
    : null;

  return Object.freeze({
    names,
    // An undeclared name that performs a permanently human action is still human-only.
    classify: (name: string) =>
      classes.get(name) ?? (Object.hasOwn(PERMANENT_HUMAN_TOOLS, name) ? UNKNOWN_PERMANENT_HUMAN_CLASS : UNKNOWN_TOOL_CLASS),
    isDeclared: (name: string) => classes.has(name),
    sourceOf: (name: string) => sources.get(name),
    toolNamePattern,
  });
}
