// GTM-agents: the brain's components, the tasks that read them, and their byte budgets.
// docs/BRAIN-SCHEMA.md is the reference.

export const COMPONENT_IDS = [
  "product",
  "market-profile",
  "personas",
  "icp",
  "message-pillars",
  "objections",
  "competitors",
  "influencers",
  "keyword-portfolio",
  "voice",
  "signals",
  "stack",
  "hiring",
  "facts",
  "commercial",
] as const;
export type ComponentId = (typeof COMPONENT_IDS)[number];

export const TASKS = ["fit", "sourcing", "judge", "account", "outreach", "strategist", "close", "replies"] as const;
export type BrainTask = (typeof TASKS)[number];

export interface TaskSpec {
  budgetBytes: number;
  /** Components in priority order. */
  components: readonly ComponentId[];
  /**
   * Components the task reads when they are served, after the ones above, within their own extra
   * allowance (optionalBytes on top of budgetBytes). One that is not served is not named as missing,
   * so a brain without it gives exactly the slice it gave before the component existed.
   */
  optional?: readonly ComponentId[];
  optionalBytes?: number;
}

export const TASK_SPECS: Readonly<Record<BrainTask, TaskSpec>> = {
  fit: { budgetBytes: 2048, components: ["icp"], optional: ["product"], optionalBytes: 1536 },
  sourcing: { budgetBytes: 4096, components: ["icp", "signals", "hiring", "keyword-portfolio"] },
  judge: { budgetBytes: 4096, components: ["voice", "facts", "message-pillars"] },
  account: { budgetBytes: 4096, components: ["personas", "influencers"] },
  outreach: { budgetBytes: 6144, components: ["personas", "message-pillars", "voice", "facts"] },
  strategist: { budgetBytes: 6144, components: ["market-profile", "icp", "personas", "message-pillars", "competitors", "commercial"], optional: ["product"], optionalBytes: 1536 },
  close: { budgetBytes: 6144, components: ["facts", "commercial"] },
  replies: { budgetBytes: 8192, components: ["facts", "objections", "competitors", "voice", "stack"] },
};

/** Every component a task reads: its required ones in priority order, then its optional ones. */
export function taskComponents(task: BrainTask): readonly ComponentId[] {
  const spec = TASK_SPECS[task];
  return [...spec.components, ...(spec.optional ?? [])];
}

/** The most bytes a slice of `task` may use once `component` is in it. */
export function budgetFor(task: BrainTask, component: ComponentId): number {
  const spec = TASK_SPECS[task];
  return spec.optional?.includes(component) ? spec.budgetBytes + (spec.optionalBytes ?? 0) : spec.budgetBytes;
}

/** The tasks that read a component. */
export function tasksReading(component: ComponentId): BrainTask[] {
  return TASKS.filter((t) => taskComponents(t).includes(component));
}

export function isComponentId(value: string): value is ComponentId {
  return (COMPONENT_IDS as readonly string[]).includes(value);
}

export const LOCK_FILE = "brain.lock.json";
