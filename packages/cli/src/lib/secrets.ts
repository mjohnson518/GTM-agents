// GTM-agents: which secrets a deployment needs, and which of them are set. Required secrets are the
// core ones plus every enabled adapter's, read from the adapter manifests. Only names are ever read:
// `wrangler secret list` returns names, and .dev.vars is read for the names it sets, never values.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_SECRETS, type GtmConfig } from "@gtm-agents/core/config";
import { manifestSchema, type AdapterManifest } from "@gtm-agents/core/ports";
import { envArgs, failureLine, parseJsonOutput, type Wrangler } from "./wrangler.ts";

/** Where adapter manifests live when they are not installed in the deployment. */
export const DEFAULT_ADAPTERS_DIR = fileURLToPath(new URL("../../../adapters/", import.meta.url));

export interface ManifestCheck {
  status: "PASS" | "FAIL";
  name: string;
  detail: string;
}

/** Load and validate the manifest of every adapter enabled in gtm.config.ts. */
export function loadAdapterManifests(dir: string, config: GtmConfig, adaptersDir: string): { manifests: AdapterManifest[]; checks: ManifestCheck[] } {
  const manifests: AdapterManifest[] = [];
  const checks: ManifestCheck[] = [];
  const enabled = Object.entries(config.adapters)
    .filter(([, a]) => a.enabled)
    .map(([name]) => name);
  for (const name of enabled) {
    const path = [join(dir, "node_modules", "@gtm-agents", "adapters", name, "manifest.json"), join(adaptersDir, name, "manifest.json")].find((p) => existsSync(p));
    if (!path) {
      checks.push({ status: "FAIL", name: `adapter ${name}`, detail: "enabled in gtm.config.ts but no manifest.json was found" });
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      checks.push({ status: "FAIL", name: `adapter ${name}`, detail: `manifest.json is not valid JSON: ${(err as Error).message}` });
      continue;
    }
    const result = manifestSchema.safeParse(raw);
    if (!result.success) {
      checks.push({ status: "FAIL", name: `adapter ${name}`, detail: `manifest.json is invalid: ${result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` });
      continue;
    }
    manifests.push(result.data);
    checks.push({ status: "PASS", name: `adapter ${name}`, detail: `${result.data.ports.join(", ")}, ${Object.keys(result.data.tools).length} tool(s)` });
  }
  return { manifests, checks };
}

/** The required core secrets plus every loaded adapter's, without duplicates. */
export function requiredSecretNames(manifests: readonly AdapterManifest[]): string[] {
  return [...new Set([...CORE_SECRETS.filter((s) => s.required).map((s) => s.name), ...manifests.flatMap((m) => m.requiredSecrets)])];
}

/** Names that .dev.vars sets to a non-empty value, or null when there is no .dev.vars. Values are never kept. */
export function devVarNames(dir: string): Set<string> | null {
  const path = join(dir, ".dev.vars");
  if (!existsSync(path)) return null;
  const names = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => /^([A-Z][A-Z0-9_]*)=(.+)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null && (m[2] ?? "").trim() !== "")
    .map((m) => m[1] as string);
  return new Set(names);
}

/** The names of the deployed Worker's secrets, or an error message. */
export async function deployedSecretNames(wrangler: Wrangler, env: string | undefined): Promise<{ names: Set<string> } | { error: string }> {
  const result = await wrangler(["secret", "list", "--format", "json", ...envArgs(env)]);
  if (result.code !== 0) return { error: failureLine(result) };
  try {
    const parsed = parseJsonOutput(result.stdout);
    if (!Array.isArray(parsed)) return { error: "could not read the output of wrangler secret list" };
    return { names: new Set(parsed.map((s) => String((s as { name?: unknown }).name))) };
  } catch {
    return { error: "could not read the output of wrangler secret list" };
  }
}

/** The command that sets one secret. The value is typed at Wrangler's prompt, never passed here. */
export function secretPutLine(name: string, env: string | undefined): string {
  return `npx wrangler secret put ${name}${env ? ` --env ${env}` : ""}`;
}
