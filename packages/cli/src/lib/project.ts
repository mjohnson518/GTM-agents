// GTM-agents: locate and load the pieces of a deployment the CLI works with.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { GtmConfig } from "@gtm-agents/core/config";

export interface FileContent {
  name: string;
  content: string;
}

/** Top-level files of a directory (no subdirectories), sorted by name. */
export function readFlatDir(dir: string): FileContent[] {
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, content: readFileSync(join(dir, name), "utf8") }));
}

/** Import a deployment's gtm.config.ts. Throws the ConfigError that defineConfig raises. */
export async function loadDeploymentConfig(dir: string): Promise<GtmConfig | null> {
  const path = join(dir, "gtm.config.ts");
  if (!existsSync(path)) return null;
  const mod = (await import(pathToFileURL(path).href)) as { default?: GtmConfig };
  if (!mod.default) throw new Error(`${path} has no default export; export default defineConfig({ ... })`);
  return mod.default;
}

export interface BrainLocation {
  brainDir: string;
  templatesDir: string | null;
  /** Where a gtm.config.ts may live, for the company domain. */
  configDir: string;
}

/**
 * Resolve the brain and templates folders. With no argument: ./brain and ./templates. With a
 * directory: that directory is the brain; templates are its templates/ subfolder, or the sibling
 * templates/ folder when the directory is named brain.
 */
export function locateBrain(cwd: string, dirArg: string | undefined, templatesArg: string | undefined): BrainLocation {
  const brainDir = dirArg ? resolve(cwd, dirArg) : join(cwd, "brain");
  const candidates = templatesArg
    ? [resolve(cwd, templatesArg)]
    : dirArg
      ? [join(brainDir, "templates"), ...(basename(brainDir) === "brain" ? [join(dirname(brainDir), "templates")] : [])]
      : [join(cwd, "templates")];
  const templatesDir = candidates.find((d) => existsSync(d) && statSync(d).isDirectory()) ?? null;
  const configDir = basename(brainDir) === "brain" ? dirname(brainDir) : dirArg ? brainDir : cwd;
  return { brainDir, templatesDir, configDir };
}
