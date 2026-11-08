// GTM-agents: the brain's components, the tasks that read them, and their byte budgets.
// docs/BRAIN-SCHEMA.md is the reference.

export const COMPONENT_IDS = [
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
}

export const TASK_SPECS: Readonly<Record<BrainTask, TaskSpec>> = {
  fit: { budgetBytes: 2048, components: ["icp"] },
  sourcing: { budgetBytes: 4096, components: ["icp", "signals", "hiring", "keyword-portfolio"] },
  judge: { budgetBytes: 4096, components: ["voice", "facts", "message-pillars"] },
  account: { budgetBytes: 4096, components: ["personas", "influencers"] },
  outreach: { budgetBytes: 6144, components: ["personas", "message-pillars", "voice", "facts"] },
  strategist: { budgetBytes: 6144, components: ["market-profile", "icp", "personas", "message-pillars", "competitors", "commercial"] },
  close: { budgetBytes: 6144, components: ["facts", "commercial"] },
  replies: { budgetBytes: 8192, components: ["facts", "objections", "competitors", "voice", "stack"] },
};

/** The tasks that read a component. */
export function tasksReading(component: ComponentId): BrainTask[] {
  return TASKS.filter((t) => TASK_SPECS[t].components.includes(component));
}

export function isComponentId(value: string): value is ComponentId {
  return (COMPONENT_IDS as readonly string[]).includes(value);
}

export const LOCK_FILE = "brain.lock.json";
