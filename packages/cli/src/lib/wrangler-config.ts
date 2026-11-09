// GTM-agents: read a deployment's wrangler.jsonc and answer the questions the CLI asks of it:
// bindings, placeholders, queues, Durable Object migrations, cron triggers and the Worker's name.
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

/**
 * Placeholders in the selected environment only. The top level holds the other environments under
 * "env", so production leaves that key out; an environment block never contains it.
 */
export function environmentPlaceholders(loaded: LoadedWranglerConfig): string[] {
  const { env: _others, ...own } = loaded.config;
  return placeholderPaths(loaded.config === loaded.root ? own : loaded.config);
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

/**
 * The cron triggers that apply. Wrangler inherits `triggers` into an environment that does not set
 * its own, so an environment block falls back to the top level.
 */
export function cronTriggers(config: WranglerConfig, root: WranglerConfig = config): string[] {
  const triggers = asObject(config.triggers ?? root.triggers);
  return Array.isArray(triggers.crons) ? triggers.crons.map(String) : [];
}

/** The deployed Worker's name: the environment's own name, or Wrangler's default `<name>-<env>`. */
export function workerName(loaded: LoadedWranglerConfig, env: string | undefined): string {
  const own = loaded.config.name;
  if (typeof own === "string" && own !== "") return own;
  const base = typeof loaded.root.name === "string" ? loaded.root.name : "worker";
  return env ? `${base}-${env}` : base;
}

/** The D1 binding's entry, if declared. */
export function d1Binding(config: WranglerConfig, binding: string): Record<string, unknown> | undefined {
  return asArray(config.d1_databases).find((b) => b.binding === binding);
}

/** The KV binding's entry, if declared. */
export function kvBinding(config: WranglerConfig, binding: string): Record<string, unknown> | undefined {
  return asArray(config.kv_namespaces).find((b) => b.binding === binding);
}

/** True for a string that still holds a ${...} placeholder. */
export function isPlaceholder(value: unknown): boolean {
  return typeof value === "string" && value.includes("${");
}

/** True for a non-empty string with no placeholder: a real id or name. */
export function isFilled(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !value.includes("${");
}

/** Null when the environment's KV binding has a real namespace id, otherwise why KV cannot be reached. */
export function kvReadiness(dir: string, env: string | undefined, binding = "KV"): string | null {
  try {
    const loaded = loadWranglerConfig(dir, env);
    const kv = kvBinding(loaded.config, binding);
    if (!kv) return `wrangler config declares no KV binding named ${binding}`;
    if (!isFilled(kv.id)) return `the ${binding} binding has no namespace id yet; run gtm setup${env ? ` --env ${env}` : ""} first`;
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}
