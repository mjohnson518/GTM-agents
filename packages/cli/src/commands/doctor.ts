// GTM-agents: `gtm doctor`, a health report for a deployment: bindings, configuration, adapter
// manifests, required secrets, webhook registration, the email footer and unsubscribe secret, the
// halt flag and kill switch, and every feature flag. Offline by default; --remote also asks
// Cloudflare (through Wrangler) for the deployed secrets and flag values.
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CORE_SECRETS, REQUIRED_BINDINGS, type GtmConfig } from "@gtm-agents/core/config";
import { FLAGS } from "@gtm-agents/core/flags";
import { manifestSchema, type AdapterManifest } from "@gtm-agents/core/ports";
import { EXIT, spawnRunner, type CommandRunner, type Io } from "../lib/io.ts";
import { loadDeploymentConfig } from "../lib/project.ts";
import { hasBinding, loadWranglerConfig, placeholderPaths, queuesWithoutConsumers, unmigratedClasses, type LoadedWranglerConfig } from "../lib/wrangler-config.ts";

export type CheckStatus = "PASS" | "WARN" | "FAIL" | "INFO";

export interface Check {
  status: CheckStatus;
  name: string;
  detail: string;
}

export interface DoctorOptions {
  runner?: CommandRunner;
  /** Where adapter manifests live when they are not installed in the deployment. */
  adaptersDir?: string;
}

const USAGE = "Usage: gtm doctor [--config <dir>] [--env <name>] [--remote]";
const DEFAULT_ADAPTERS_DIR = fileURLToPath(new URL("../../../adapters/", import.meta.url));

export async function doctorCommand(args: string[], io: Io, options: DoctorOptions = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, options: { config: { type: "string" }, env: { type: "string" }, remote: { type: "boolean", default: false } } });
  } catch (err) {
    io.err(`gtm doctor: ${(err as Error).message}`);
    io.err(USAGE);
    return EXIT.usage;
  }
  const dir = join(io.cwd, parsed.values.config ?? ".");
  const env = parsed.values.env;
  const checks = await runChecks(dir, env, parsed.values.remote === true, { runner: options.runner ?? spawnRunner, adaptersDir: options.adaptersDir ?? DEFAULT_ADAPTERS_DIR });

  io.out(`gtm doctor: ${relative(io.cwd, dir) || "."} (${env ?? "production"})`);
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) io.out(`${c.status.padEnd(4)}  ${c.name.padEnd(width)}  ${c.detail}`);
  printFlags(io);
  const failed = checks.filter((c) => c.status === "FAIL").length;
  const warned = checks.filter((c) => c.status === "WARN").length;
  io.out(`gtm doctor: ${failed} failed, ${warned} warning(s)`);
  return failed ? EXIT.failed : EXIT.ok;
}

async function runChecks(dir: string, env: string | undefined, remote: boolean, deps: Required<DoctorOptions>): Promise<Check[]> {
  const checks: Check[] = [];

  // Wrangler configuration.
  let wrangler: LoadedWranglerConfig | undefined;
  try {
    wrangler = loadWranglerConfig(dir, env);
  } catch (err) {
    checks.push({ status: "FAIL", name: "wrangler config", detail: (err as Error).message });
  }
  if (wrangler) {
    const missing = REQUIRED_BINDINGS.filter((b) => !hasBinding(wrangler.config, b, wrangler.root));
    checks.push(
      missing.length
        ? { status: "FAIL", name: "bindings", detail: `missing: ${missing.map((b) => `${b.name} (${b.purpose})`).join(", ")}` }
        : { status: "PASS", name: "bindings", detail: `all ${REQUIRED_BINDINGS.length} required bindings are declared` },
    );
    const unmigrated = unmigratedClasses(wrangler.config, wrangler.root);
    if (unmigrated.length) checks.push({ status: "FAIL", name: "durable objects", detail: `no migration creates: ${unmigrated.join(", ")}` });
    const orphans = queuesWithoutConsumers(wrangler.config);
    if (orphans.length) checks.push({ status: "WARN", name: "queues", detail: `no consumer for: ${orphans.join(", ")}` });
    const placeholders = placeholderPaths(wrangler.config);
    checks.push(
      placeholders.length
        ? { status: "WARN", name: "placeholders", detail: `${placeholders.length} value(s) still hold \${...} placeholders (${placeholders.slice(0, 3).join(", ")}${placeholders.length > 3 ? ", ..." : ""}); run gtm setup` }
        : { status: "PASS", name: "placeholders", detail: "every resource id and name is filled in" },
    );
  }

  // Deployment configuration.
  let config: GtmConfig | null = null;
  try {
    config = await loadDeploymentConfig(dir);
    checks.push(
      config
        ? { status: "PASS", name: "gtm.config.ts", detail: `${config.company.name} (${config.company.domain}), agent ${config.agent.name}` }
        : { status: "FAIL", name: "gtm.config.ts", detail: `not found in ${dir}` },
    );
  } catch (err) {
    checks.push({ status: "FAIL", name: "gtm.config.ts", detail: (err as Error).message.split("\n").join(" ") });
  }

  // Adapters and their manifests.
  const manifests: AdapterManifest[] = [];
  const enabled = config ? Object.entries(config.adapters).filter(([, a]) => a.enabled).map(([name]) => name) : [];
  for (const name of enabled) {
    const path = [join(dir, "node_modules", "@gtm-agents", "adapters", name, "manifest.json"), join(deps.adaptersDir, name, "manifest.json")].find((p) => existsSync(p));
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
  if (config && enabled.length === 0) checks.push({ status: "INFO", name: "adapters", detail: "no adapters are enabled yet" });

  // Secrets.
  const required = [...new Set([...CORE_SECRETS.filter((s) => s.required).map((s) => s.name), ...manifests.flatMap((m) => m.requiredSecrets)])];
  if (remote) {
    checks.push(await remoteSecretsCheck(dir, env, required, deps.runner));
  } else {
    const devVars = readDevVars(dir);
    const local = devVars ? ` (.dev.vars sets ${required.filter((n) => devVars.has(n)).length} of them for local development)` : "";
    checks.push({ status: "INFO", name: "secrets", detail: `required: ${required.join(", ")}${local}; pass --remote to verify the deployed secrets` });
  }

  // Webhook registration.
  const operator = manifests.find((m) => m.ports.includes("OperatorChannel"));
  checks.push(
    operator
      ? { status: "WARN", name: "webhooks", detail: `${operator.name} needs its webhook registered; gtm setup does this` }
      : { status: "INFO", name: "webhooks", detail: "no operator channel adapter is enabled, so there is no webhook to register" },
  );

  // Email footer and unsubscribe.
  if (config) {
    const hasKey = required.includes("UNSUBSCRIBE_SIGNING_KEY");
    checks.push({
      status: config.sending.postalAddress && hasKey ? "PASS" : "FAIL",
      name: "footer and unsubscribe",
      detail: `postal footer is set; one-click unsubscribe links are signed with UNSUBSCRIBE_SIGNING_KEY${remote ? "" : " (verify it with --remote)"}`,
    });
  }

  // Halt flag and kill switch.
  if (remote) {
    checks.push(await remoteFlagCheck(dir, env, "system:halt", "halt flag", "the system is halted; every job and send is stopped", deps.runner));
    checks.push(await remoteFlagCheck(dir, env, "outreach:cold-pause:critical", "kill switch (critical)", "cold outreach is paused by the operator", deps.runner));
    checks.push(await remoteFlagCheck(dir, env, "outreach:cold-pause", "kill switch", "cold outreach is paused", deps.runner));
  } else {
    checks.push({ status: "INFO", name: "halt and kill switch", detail: "system:halt, outreach:cold-pause:critical and outreach:cold-pause live in KV; unset means running; pass --remote to read them" });
  }
  return checks;
}

function readDevVars(dir: string): Set<string> | null {
  const path = join(dir, ".dev.vars");
  if (!existsSync(path)) return null;
  const names = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((l) => /^([A-Z][A-Z0-9_]*)=(.+)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null && (m[2] ?? "").trim() !== "")
    .map((m) => m[1] as string);
  return new Set(names);
}

async function remoteSecretsCheck(dir: string, env: string | undefined, required: string[], runner: CommandRunner): Promise<Check> {
  const result = await runner("npx", ["wrangler", "secret", "list", "--format", "json", ...(env ? ["--env", env] : [])], { cwd: dir });
  if (result.code !== 0) return { status: "FAIL", name: "secrets", detail: `could not list the deployed secrets: ${result.stderr.trim().split("\n").pop() ?? "wrangler failed"}` };
  let names: Set<string>;
  try {
    names = new Set((JSON.parse(result.stdout) as Array<{ name: string }>).map((s) => s.name));
  } catch {
    return { status: "FAIL", name: "secrets", detail: "could not read the output of wrangler secret list" };
  }
  const missing = required.filter((n) => !names.has(n));
  return missing.length
    ? { status: "FAIL", name: "secrets", detail: `missing: ${missing.join(", ")}; set each with wrangler secret put` }
    : { status: "PASS", name: "secrets", detail: `all ${required.length} required secrets are set` };
}

async function remoteFlagCheck(dir: string, env: string | undefined, key: string, name: string, whenSet: string, runner: CommandRunner): Promise<Check> {
  const result = await runner("npx", ["wrangler", "kv", "key", "get", key, "--binding", "KV", "--remote", ...(env ? ["--env", env] : [])], { cwd: dir });
  const output = `${result.stdout}\n${result.stderr}`;
  if (/value not found/i.test(output)) return { status: "PASS", name, detail: `${key} is unset` };
  if (result.code !== 0) return { status: "FAIL", name, detail: `could not read ${key}; until it can be read, the system treats itself as stopped` };
  return { status: "WARN", name, detail: `${whenSet}: ${result.stdout.trim().slice(0, 200)}` };
}

function printFlags(io: Io): void {
  io.out("");
  io.out("Flags (defaults; unset flags use these values):");
  const width = Math.max(...FLAGS.map((f) => f.key.length));
  for (const f of FLAGS) io.out(`  ${f.key.padEnd(width)}  ${(f.default ?? "unset").padEnd(8)}  ${f.description}`);
  io.out("");
}
