// GTM-agents: read a deployment's wrangler.jsonc and answer the questions `gtm doctor` asks of it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BindingSpec } from "@gtm-agents/core/config";
import { parseJsonc } from "./jsonc.ts";

export type WranglerConfig = Record<string, unknown>;

export interface LoadedWranglerConfig {
  path: string;
  /** The top-level config, or the selected environment's block when an environment is named. */
  config: WranglerConfig;
  root: WranglerConfig;
}

export function findWranglerConfig(dir: string): string | null {
  for (const name of ["wrangler.jsonc", "wrangler.json"]) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return null;
}

export function loadWranglerConfig(dir: string, env?: string): LoadedWranglerConfig {
  const path = findWranglerConfig(dir);
  if (!path) throw new Error(`no wrangler.jsonc or wrangler.json in ${dir}`);
  const root = parseJsonc(readFileSync(path, "utf8")) as WranglerConfig;
  if (!env) return { path, config: root, root };
  const envs = (root.env ?? {}) as Record<string, WranglerConfig>;
  const block = envs[env];
  if (!block) throw new Error(`wrangler config has no environment named "${env}"`);
  return { path, config: block, root };
}

const asArray = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);
const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * Whether the config declares a binding of the right kind (and Durable Object class). Pass the
 * top-level config as `root` when `config` is an environment block: Wrangler inherits `assets`
 * into environments, but not bindings.
 */
export function hasBinding(config: WranglerConfig, spec: BindingSpec, root: WranglerConfig = config): boolean {
  if (spec.kind === "assets") return asObject(config.assets ?? root.assets).binding === spec.name;
  switch (spec.kind) {
    case "d1_databases":
    case "kv_namespaces":
    case "r2_buckets":
    case "vectorize":
      return asArray(config[spec.kind]).some((b) => b.binding === spec.name);
    case "ai":
      return asObject(config.ai).binding === spec.name;
    case "durable_objects":
      return asArray(asObject(config.durable_objects).bindings).some((b) => b.name === spec.name && (!spec.className || b.class_name === spec.className));
    case "queues.producers":
      return asArray(asObject(config.queues).producers).some((b) => b.binding === spec.name);
  }
}

/** Dotted paths of every string value that still holds a ${...} placeholder. */
export function placeholderPaths(value: unknown, path = ""): string[] {
  if (typeof value === "string") return value.includes("${") ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => placeholderPaths(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => placeholderPaths(v, path ? `${path}.${k}` : k));
  }
  return [];
}

/** Queues that have a producer but no consumer in this config. */
export function queuesWithoutConsumers(config: WranglerConfig): string[] {
  const queues = asObject(config.queues);
  const consumed = new Set(asArray(queues.consumers).map((c) => String(c.queue)));
  return asArray(queues.producers)
    .map((p) => String(p.queue))
    .filter((q) => !consumed.has(q));
}

/** Durable Object classes bound in the config but missing from the migrations. */
export function unmigratedClasses(config: WranglerConfig, root: WranglerConfig): string[] {
  const bound = asArray(asObject(config.durable_objects).bindings).map((b) => String(b.class_name));
  const names = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const migrated = new Set(asArray(root.migrations).flatMap((m) => [...names(m.new_sqlite_classes), ...names(m.new_classes)]));
  return bound.filter((c) => !migrated.has(c));
}
