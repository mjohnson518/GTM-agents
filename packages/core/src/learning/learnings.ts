// GTM-agents: the learnings document: proven insights, writing rules, objection handling and
// template performance, written only through approved proposals.
//
// The document is the set of applied learning proposals, grouped by section, so the database is its
// one source and a person approved every line of it, byte for byte. Mutation constraints, checked
// when a snippet is proposed and again when it is applied:
//   - a snippet meets snippetProblems (one to 400 characters, no link, no address, no em or en dash,
//     no injection pattern, nothing the content lint blocks);
//   - a section holds at most SECTION_MAX_ENTRIES entries and SECTION_MAX_BYTES bytes; a full
//     section takes a new entry only as a replacement of an existing one.
// The text is operator-approved, so prompts may carry it as trusted context.
import { intact, listLearningProposals } from "./proposals.ts";

export { LEARNING_SECTIONS, SECTION_MAX_BYTES, SECTION_MAX_ENTRIES, isLearningSection, type LearningSection } from "./sections.ts";
import { isLearningSection, LEARNING_SECTIONS, SECTION_MAX_BYTES, SECTION_MAX_ENTRIES, type LearningSection } from "./sections.ts";

export interface LearningEntry {
  id: string;
  section: LearningSection;
  text: string;
  appliedAt: string;
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

/**
 * Every applied entry, oldest first. A row whose stored fields no longer render to the digest that
 * was approved, or whose section column disagrees with what was approved, is dropped. Throws on a
 * database error.
 */
export async function learningEntries(db: D1Database): Promise<LearningEntry[]> {
  const applied = await listLearningProposals(db, { status: "applied", kinds: ["learning"], limit: 200 });
  const out: LearningEntry[] = [];
  for (const p of applied) {
    const payload = p.payload as { section?: unknown; text?: unknown };
    if (!isLearningSection(payload.section) || p.section !== payload.section || !(await intact(p))) continue;
    out.push({ id: p.shortId, section: payload.section, text: p.text, appliedAt: p.appliedAt ?? "" });
  }
  return out.sort((a, b) => (a.appliedAt < b.appliedAt ? -1 : a.appliedAt > b.appliedAt ? 1 : a.id < b.id ? -1 : 1));
}

/** Whether a section can take `text`, replacing the entry `replaces` when given. Null means it can. */
export function sectionRoom(entries: readonly LearningEntry[], section: LearningSection, text: string, replaces?: string | null): string | null {
  const kept = entries.filter((e) => e.section === section && e.id !== replaces);
  if (replaces && kept.length === entries.filter((e) => e.section === section).length) return `entry ${replaces} is not in ${section}`;
  if (kept.length + 1 > SECTION_MAX_ENTRIES) return `${section} already holds ${SECTION_MAX_ENTRIES} entries; replace one instead`;
  const total = kept.reduce((sum, e) => sum + bytes(e.text) + 3, 0) + bytes(text) + 3;
  if (total > SECTION_MAX_BYTES) return `${section} would exceed ${SECTION_MAX_BYTES} bytes; replace an entry instead`;
  return null;
}

/** The learnings document as prompt text, or "" when nothing is applied. Empty on a read error. */
export async function learningsText(db: D1Database, sections: readonly LearningSection[] = LEARNING_SECTIONS): Promise<string> {
  let entries: LearningEntry[];
  try {
    entries = await learningEntries(db);
  } catch {
    return "";
  }
  const blocks: string[] = [];
  for (const section of sections) {
    const lines = entries.filter((e) => e.section === section).map((e) => `- ${e.text}`);
    if (lines.length > 0) blocks.push([`## ${section}`, ...lines].join("\n"));
  }
  return blocks.length > 0 ? ["LEARNINGS (operator-approved)", ...blocks].join("\n\n") : "";
}
