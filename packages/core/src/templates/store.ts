// GTM-agents: serve templates at runtime, under the same rules as the brain.
//
// The deployment's templates live in KV: a lock (`templates:lock`) recording the SHA-256 of each
// approved file's exact bytes, and each file under `template:file:<id>`. A template is served only
// when all of these hold:
//   1. the lock names it, and its bytes hash to the lock entry;
//   2. it parses, its frontmatter says `status: approved`, and its id matches the file name;
//   3. it passes the structural checks (validateTemplateFile) with no errors, links checked against
//      the company's domain.
// Anything else is skipped and named, so editing a file without re-locking takes it out of use.
// Templates are independent: one skipped template never takes the others with it. The loader never
// throws; a KV error serves nothing and says so.
import { z } from "zod";
import { sha256Hex } from "../shared/hash.ts";
import type { ParsedTemplate } from "./parse.ts";
import type { TemplateFrontmatter } from "./schema.ts";
import { validateTemplateFile } from "./validate.ts";

export const TEMPLATES_LOCK_KEY = "templates:lock";
export const templateFileKey = (id: string): string => `template:file:${id}`;

const FILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

export const templateLockSchema = z.strictObject({
  version: z.literal(1),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  files: z.record(z.string().regex(FILE_NAME), z.string().regex(/^[0-9a-f]{64}$/)),
});
export type TemplateLock = z.output<typeof templateLockSchema>;

export interface TemplateFile {
  /** The file name, `<id>.md`. */
  name: string;
  content: string;
}

export interface ServedTemplate {
  id: string;
  meta: TemplateFrontmatter;
  subject: string;
  body: string;
  /** SHA-256 of the file's exact bytes: ties each draft to the version it was built from. */
  sha256: string;
}

export interface TemplateLoad {
  templates: ServedTemplate[];
  skipped: Array<{ file: string; reason: string }>;
  /** Set when nothing could be read at all, for example a KV error. */
  error?: string;
}

/** Build the lock for a set of approved template files. */
export async function computeTemplateLock(files: readonly TemplateFile[]): Promise<TemplateLock> {
  const entries = await Promise.all(files.map(async (f) => [f.name, await sha256Hex(f.content)] as const));
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = await sha256Hex(entries.map(([name, h]) => `${name} ${h}\n`).join(""));
  return { version: 1, hash, files: Object.fromEntries(entries) };
}

/** Parse a template lock's JSON text. Null when missing or malformed. */
export function parseTemplateLock(text: string | null | undefined): TemplateLock | null {
  if (!text) return null;
  try {
    const parsed = templateLockSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function serve(parsed: ParsedTemplate, sha256: string): ServedTemplate | string {
  if (!parsed.meta) return "the frontmatter does not parse";
  if (parsed.meta.status !== "approved") return "the template is a draft";
  const errors = parsed.issues.filter((i) => i.severity === "error");
  if (errors.length > 0) return `it fails validation: ${errors[0]?.message ?? "error"}`;
  return { id: parsed.meta.id, meta: parsed.meta, subject: parsed.subject, body: parsed.body, sha256 };
}

/**
 * Serve a set of files already in hand (for example bundled with the Worker) under the same rules,
 * except the lock: every approved, valid file is served.
 */
export async function serveTemplateFiles(files: readonly TemplateFile[], options: { companyDomain?: string } = {}): Promise<TemplateLoad> {
  const out: TemplateLoad = { templates: [], skipped: [] };
  for (const file of files) {
    if (!FILE_NAME.test(file.name)) {
      out.skipped.push({ file: file.name, reason: "not a template file name" });
      continue;
    }
    const served = serve(validateTemplateFile(file.name, file.content, options), await sha256Hex(file.content));
    if (typeof served === "string") out.skipped.push({ file: file.name, reason: served });
    else out.templates.push(served);
  }
  return out;
}

/** Load every servable template from KV. Never throws. */
export async function loadTemplates(kv: { get(key: string): Promise<string | null> } | undefined | null, options: { companyDomain?: string } = {}): Promise<TemplateLoad> {
  if (!kv) return { templates: [], skipped: [], error: "no KV binding" };
  try {
    const lock = parseTemplateLock(await kv.get(TEMPLATES_LOCK_KEY));
    if (!lock) return { templates: [], skipped: [], error: "no template lock is uploaded" };
    const out: TemplateLoad = { templates: [], skipped: [] };
    for (const [name, expected] of Object.entries(lock.files)) {
      const content = await kv.get(templateFileKey(name.replace(/\.md$/, "")));
      if (content === null) {
        out.skipped.push({ file: name, reason: "the file is not uploaded" });
        continue;
      }
      const sha256 = await sha256Hex(content);
      if (sha256 !== expected) {
        out.skipped.push({ file: name, reason: "the file changed after it was locked" });
        continue;
      }
      const served = serve(validateTemplateFile(name, content, options), sha256);
      if (typeof served === "string") out.skipped.push({ file: name, reason: served });
      else out.templates.push(served);
    }
    return out;
  } catch {
    return { templates: [], skipped: [], error: "the templates could not be read" };
  }
}
