// GTM-agents: writing a brain component file in the brain's format (docs/BRAIN-SCHEMA.md): the
// frontmatter, a title, then one `## <id>` section per item with `- key: value` lines. Every value is
// collapsed to a single line, so no value can add a field, an item or a heading. Pure, and safe to
// import from Node (the CLI) and from the Worker.
import type { ComponentId } from "./components.ts";

/** One item of a component: its id and its fields as the strings the file holds. */
export interface BrainItemInput {
  id: string;
  fields: Record<string, string>;
}

const TITLES: Partial<Record<ComponentId, string>> = { product: "Product", "message-pillars": "Message pillars", voice: "Voice", "market-profile": "Market profile", icp: "ICP", "keyword-portfolio": "Keyword portfolio" };

/** A component file in the brain's format. Field values are single lines; status defaults to approved. */
export function renderBrainFile(args: { component: ComponentId; version: number; updated: string; owner?: string | null; status?: "draft" | "approved"; items: readonly BrainItemInput[] }): string {
  const title = TITLES[args.component] ?? args.component.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  const lines = ["---", `component: ${args.component}`, `status: ${args.status ?? "approved"}`, `version: ${args.version}`, `updated: ${args.updated}`];
  if (args.owner) lines.push(`owner: ${args.owner.replace(/\s+/g, " ").trim()}`);
  lines.push("---", "", `# ${title}`);
  for (const item of args.items) {
    lines.push("", `## ${item.id}`);
    for (const [key, value] of Object.entries(item.fields)) lines.push(`- ${key}: ${value.replace(/\s+/g, " ").trim()}`);
  }
  return `${lines.join("\n")}\n`;
}
