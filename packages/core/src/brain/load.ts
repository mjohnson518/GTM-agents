// GTM-agents: load the brain slice for a task at runtime.
//
// `gtm brain upload` writes the lock and each approved file to KV. Here, a component is served only
// if its bytes hash to its lock entry, its frontmatter says approved and names the right component,
// it parses cleanly, and it passes the single-file content rules (no URLs outside url fields, no
// prices outside commercial). Anything else is named as missing. The loader never throws: on any
// error the slice carries no brain content and names every component as missing.
import { assembleSlice, renderComponent, type BrainSlice } from "./assemble.ts";
import { TASK_SPECS, type BrainTask, type ComponentId } from "./components.ts";
import { brainVersion, parseLock, sha256Hex } from "./lock.ts";
import { parseBrainFile } from "./parse.ts";
import { contentRuleIssues } from "./validate.ts";

/** The slice of a KV namespace the loader needs. Cloudflare's KVNamespace satisfies it. */
export interface KVReader {
  get(key: string): Promise<string | null>;
}

export const BRAIN_LOCK_KEY = "brain:lock";
export const brainFileKey = (component: ComponentId) => `brain:file:${component}`;

export async function loadBrain(env: { KV: KVReader }, task: BrainTask): Promise<BrainSlice> {
  try {
    if (!Object.hasOwn(TASK_SPECS, task)) {
      return { task, version: "unlocked", text: "", included: [], missing: [], bytes: 0 };
    }
    const spec = TASK_SPECS[task];
    const lock = parseLock(await env.KV.get(BRAIN_LOCK_KEY).catch(() => null));
    if (!lock) return assembleSlice(task, brainVersion(null), new Map());
    const servable = new Map<ComponentId, string>();
    await Promise.all(
      spec.components.map(async (component) => {
        const expected = lock.files[`${component}.md`];
        if (!expected) return;
        const content = await env.KV.get(brainFileKey(component));
        if (content === null || (await sha256Hex(content)) !== expected) return;
        const parsed = parseBrainFile(`${component}.md`, content);
        if (parsed.frontmatter?.status !== "approved") return;
        if ([...parsed.issues, ...contentRuleIssues(parsed)].some((i) => i.severity === "error")) return;
        servable.set(component, renderComponent(component, parsed.frontmatter.version, parsed.items));
      }),
    );
    return assembleSlice(task, brainVersion(lock), servable);
  } catch {
    return safeEmpty(task);
  }
}

function safeEmpty(task: BrainTask): BrainSlice {
  try {
    return assembleSlice(task, "unlocked", new Map());
  } catch {
    return { task, version: "unlocked", text: "", included: [], missing: [], bytes: 0 };
  }
}
