// GTM-agents: assemble the brain slice a task reads. Components are added whole, in priority
// order, while they fit the task's byte budget; anything missing is named, with an instruction
// not to fill it in from memory.
import { TASK_SPECS, type BrainTask, type ComponentId } from "./components.ts";
import type { BrainItem } from "./parse.ts";

export interface BrainSlice {
  task: BrainTask;
  version: string;
  /** The text to place in the prompt. Empty when nothing is served. */
  text: string;
  included: ComponentId[];
  missing: ComponentId[];
  bytes: number;
}

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;

function formatValue(value: unknown): string {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/** Render one approved component as a compact block: one line per item. */
export function renderComponent(component: ComponentId, version: number, items: BrainItem[]): string {
  const lines = items
    .filter((item) => item.value)
    .map((item) => {
      const fields = Object.entries(item.value ?? {})
        .map(([k, v]) => `${k}: ${formatValue(v)}`)
        .join("; ");
      return `- ${item.id}: ${fields}`;
    });
  return [`### ${component} (v${version})`, ...lines].join("\n");
}

export function headerLine(version: string, task: BrainTask): string {
  return `GTM BRAIN (version ${version}, operator-approved; task: ${task})`;
}

export function missingLine(missing: readonly ComponentId[]): string {
  return `Missing from the brain for this task: ${missing.join(", ")}. Do not fill these in from memory; say what is unknown.`;
}

/**
 * Build the slice for a task from the components that may be served (approved, locked and
 * verified), each already rendered with renderComponent.
 */
export function assembleSlice(task: BrainTask, version: string, servable: ReadonlyMap<ComponentId, string>): BrainSlice {
  const spec = TASK_SPECS[task];
  const header = headerLine(version, task);
  const reserve = byteLength(`\n\n${missingLine(spec.components)}`);
  const included: ComponentId[] = [];
  const blocks: string[] = [];
  let used = byteLength(header);

  for (const component of spec.components) {
    const block = servable.get(component);
    if (block === undefined) continue;
    const cost = byteLength(`\n\n${block}`);
    if (used + cost + reserve <= spec.budgetBytes) {
      included.push(component);
      blocks.push(block);
      used += cost;
    }
  }

  // Even when nothing is served, the slice names what is missing, so a model never fills gaps from memory.
  const missing = spec.components.filter((c) => !included.includes(c));
  const text = [header, ...blocks, ...(missing.length ? [missingLine(missing)] : [])].join("\n\n");
  return { task, version, text, included, missing, bytes: byteLength(text) };
}

/** The bytes a component adds to any slice that includes it, for budget validation. */
export function componentCost(block: string): number {
  return byteLength(`\n\n${block}`);
}

/** The fixed overhead of a task's slice (header plus the worst-case missing line). */
export function sliceOverhead(task: BrainTask): number {
  const spec = TASK_SPECS[task];
  return byteLength(headerLine("000000000000", task)) + byteLength(`\n\n${missingLine(spec.components)}`);
}
