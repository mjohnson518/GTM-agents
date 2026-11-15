// GTM-agents: `gtm doctor`, a health report for a deployment: bindings, the per-minute cron trigger,
// the jobs and chat queues, configuration, adapter manifests, required secrets, webhook registration, the email footer and
// unsubscribe secret, the halt flag and kill switch, and every feature flag. Offline by default;
// --remote also asks Cloudflare (through Wrangler) for the deployed secrets and the stop flags'
// values (the halt and both kill-switch keys) and operator:chat_batching, and resolves the sending domain's SPF, DKIM and DMARC
// records over DNS over HTTPS (lib/dns.ts).
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { REQUIRED_BINDINGS, type GtmConfig } from "@gtm-agents/core/config";
import { FLAGS } from "@gtm-agents/core/flags";
import { SCHEDULER_CRON, isFlagOn, normalizeCron } from "@gtm-agents/core/jobs";
import type { AdapterManifest } from "@gtm-agents/core/ports";
import { dnsChecks, type DnsFetch } from "../lib/dns.ts";
import { EXIT, spawnRunner, type CommandRunner, type Io } from "../lib/io.ts";
import { loadDeploymentConfig } from "../lib/project.ts";
import { DEFAULT_ADAPTERS_DIR, deployedSecretNames, devVarNames, loadAdapterManifests, requiredSecretNames } from "../lib/secrets.ts";
import { cronTriggers, environmentPlaceholders, hasBinding, loadWranglerConfig, queuesWithoutConsumers, unmigratedClasses, type LoadedWranglerConfig } from "../lib/wrangler-config.ts";
import { envLabel, kvBulkGet, wranglerAt, wranglerEnv, type Wrangler } from "../lib/wrangler.ts";

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
  /** The fetch the --remote DNS checks use. Default: the global fetch. */
  fetch?: DnsFetch;
}

const USAGE = "Usage: gtm doctor [--config <dir>] [--env staging|production] [--remote]";

/** The KV flags that stop work, with what a set value means. */
const STOP_FLAGS = [
  { key: "system:halt", name: "halt flag", whenSet: "the system is halted; every job and send is stopped" },
  { key: "outreach:cold-pause:critical", name: "kill switch (critical)", whenSet: "cold outreach is paused by the operator" },
  { key: "outreach:cold-pause", name: "kill switch", whenSet: "cold outreach is paused" },
] as const;

export async function doctorCommand(args: string[], io: Io, options: DoctorOptions = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, options: { config: { type: "string" }, env: { type: "string" }, remote: { type: "boolean", default: false } } });
  } catch (err) {
    io.err(`gtm doctor: ${(err as Error).message}`);
    io.err(USAGE);
    return EXIT.usage;
  }
  const dir = resolve(io.cwd, parsed.values.config ?? ".");
  const env = wranglerEnv(parsed.values.env);
  const checks = await runChecks(dir, env, parsed.values.remote === true, {
    runner: options.runner ?? spawnRunner,
    adaptersDir: options.adaptersDir ?? DEFAULT_ADAPTERS_DIR,
    fetch: options.fetch ?? ((url, init) => globalThis.fetch(url, init)),
  });

  io.out(`gtm doctor: ${relative(io.cwd, dir) || "."} (${envLabel(env)})`);
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) io.out(`${c.status.padEnd(4)}  ${c.name.padEnd(width)}  ${c.detail}`);
  printFlags(io);
  const failed = checks.filter((c) => c.status === "FAIL").length;
  const warned = checks.filter((c) => c.status === "WARN").length;
  io.out(`gtm doctor: ${failed} failed, ${warned} warning(s)`);
  return failed ? EXIT.failed : EXIT.ok;
}

/** The trigger check: exactly one cron trigger, every minute. */
export function triggerCheck(crons: readonly string[]): Check {
  const perMinute = crons.findIndex((c) => normalizeCron(c) === SCHEDULER_CRON);
  if (perMinute === -1) {
    return { status: "FAIL", name: "cron trigger", detail: `no per-minute trigger ("${SCHEDULER_CRON}"), so no scheduled job ever runs; set "triggers": { "crons": ["${SCHEDULER_CRON}"] }` };
  }
  const extra = crons.filter((_c, i) => i !== perMinute);
  if (extra.length > 0) {
    return { status: "FAIL", name: "cron trigger", detail: `keep only "${SCHEDULER_CRON}": the extra trigger(s) ${extra.map((c) => `"${c}"`).join(", ")} run the jobs due in their minutes a second time` };
  }
  return { status: "PASS", name: "cron trigger", detail: "one per-minute trigger; each minute runs the jobs whose schedule matches it" };
}

const asArray = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);
const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * The jobs queue check. Without a JOBS_QUEUE producer, due jobs run inside the cron invocation
 * (that is fine, and said so). With one, its queue needs a consumer, or no scheduled job would ever
 * run; one job per batch, a dead-letter queue and a consumer on that dead-letter queue are expected.
 */
export function jobsQueueCheck(config: Record<string, unknown>): Check {
  const queues = asObject(config.queues);
  const producer = asArray(queues.producers).find((p) => p.binding === "JOBS_QUEUE");
  if (!producer) {
    return { status: "INFO", name: "jobs queue", detail: "no JOBS_QUEUE binding, so due jobs run inside the cron invocation (4 at a time, a 14-minute budget per minute); add it so each job runs in its own invocation" };
  }
  const name = typeof producer.queue === "string" ? producer.queue : "";
  const consumers = asArray(queues.consumers);
  const consumer = consumers.find((c) => c.queue === name);
  if (!consumer) return { status: "FAIL", name: "jobs queue", detail: `JOBS_QUEUE sends to ${name}, but no consumer reads it, so no scheduled job would ever run; add a consumer for it` };
  const problems: string[] = [];
  if (consumer.max_batch_size !== 1) problems.push("set max_batch_size to 1, so each job gets its own invocation and wall time");
  const retries = typeof consumer.max_retries === "number" ? consumer.max_retries : 3;
  if (retries > 1) problems.push(`max_retries is ${retries}; 0 or 1 is enough, because a delivered job is claimed per minute and never runs twice`);
  const dlq = typeof consumer.dead_letter_queue === "string" ? consumer.dead_letter_queue : "";
  if (dlq === "") problems.push("add a dead_letter_queue, so a job that could not be claimed is recorded and paged instead of dropped");
  else if (!consumers.some((c) => c.queue === dlq)) problems.push(`add a consumer for its dead-letter queue ${dlq}, so dead-lettered jobs are recorded and paged`);
  if (problems.length) return { status: "WARN", name: "jobs queue", detail: `${name}: ${problems.join("; ")}` };
  return { status: "PASS", name: "jobs queue", detail: `due jobs go to ${name} once scheduler:queue_enabled is on, one job per consumer invocation, with dead-letter queue ${dlq}` };
}

/** The flag that lets messages sent in a row share one turn (docs/OPERATOR.md#messages-sent-in-a-row). */
export const CHAT_BATCHING_FLAG = "operator:chat_batching";
/** What Cloudflare uses for a consumer's max_batch_size when wrangler.jsonc leaves it out. */
const QUEUE_DEFAULT_BATCH_SIZE = 10;

/**
 * The chat queue check. The webhook puts each operator message on the queue CHAT_QUEUE sends to, and
 * its consumer answers it; without the binding, a message is answered inside its webhook request,
 * which suits local development. One delivery at a time keeps a chat's turns in order, and
 * operator:chat_batching merges messages only when a delivery can hold more than one. `batching` is
 * the flag's deployed value when it was read (--remote): a flag that is on while every delivery
 * holds one message does nothing, which is a warning.
 */
export function chatQueueCheck(config: Record<string, unknown>, batching?: boolean): Check {
  const queues = asObject(config.queues);
  const producer = asArray(queues.producers).find((p) => p.binding === "CHAT_QUEUE");
  if (!producer) {
    return { status: "INFO", name: "chat queue", detail: "no CHAT_QUEUE binding, so each operator message is answered inside its webhook request; fine for local development, add it for a deployment" };
  }
  const name = typeof producer.queue === "string" ? producer.queue : "";
  const consumer = asArray(queues.consumers).find((c) => c.queue === name);
  if (!consumer) return { status: "FAIL", name: "chat queue", detail: `CHAT_QUEUE sends to ${name}, but no consumer reads it, so no operator message would ever be answered; add a consumer for it` };
  const size = typeof consumer.max_batch_size === "number" ? consumer.max_batch_size : QUEUE_DEFAULT_BATCH_SIZE;
  const problems: string[] = [];
  if (consumer.max_concurrency !== 1) {
    const now = typeof consumer.max_concurrency === "number" ? `it is ${consumer.max_concurrency}` : "unset, Cloudflare runs several at once when the queue backs up";
    problems.push(`set max_concurrency to 1 (${now}), so one delivery runs at a time and a chat's turns stay in order`);
  }
  if (batching === true && size <= 1) problems.push(`${CHAT_BATCHING_FLAG} is on, but max_batch_size is 1, so messages are never delivered together and never share a turn; raise it (3 to 5) or turn the flag off`);
  if (problems.length) return { status: "WARN", name: "chat queue", detail: `${name}: ${problems.join("; ")}` };
  const flag = batching === undefined ? ` (pass --remote to read ${CHAT_BATCHING_FLAG})` : "";
  if (size <= 1) return { status: "PASS", name: "chat queue", detail: `${name}: one message per delivery, so each gets its own turn; ${CHAT_BATCHING_FLAG} has no effect until max_batch_size is above 1${flag}` };
  const merging = batching === false ? `${CHAT_BATCHING_FLAG} is off, so each is still its own turn` : `with ${CHAT_BATCHING_FLAG} on, adjacent messages for the model share a turn${flag}`;
  return { status: "PASS", name: "chat queue", detail: `${name}: up to ${size} messages per delivery, put in the order they were sent; ${merging}; runs a delivery could not start in time go back to the queue` };
}

async function runChecks(dir: string, env: string | undefined, remote: boolean, deps: Required<DoctorOptions>): Promise<Check[]> {
  const checks: Check[] = [];
  const wrangler: Wrangler = wranglerAt(deps.runner, dir);

  // Wrangler configuration. The chat queue check is re-run with the flag's value under --remote.
  let loaded: LoadedWranglerConfig | undefined;
  let chatQueue: { index: number; config: Record<string, unknown> } | undefined;
  try {
    loaded = loadWranglerConfig(dir, env);
  } catch (err) {
    checks.push({ status: "FAIL", name: "wrangler config", detail: (err as Error).message });
  }
  if (loaded) {
    const missing = REQUIRED_BINDINGS.filter((b) => !hasBinding(loaded.config, b, loaded.root));
    checks.push(
      missing.length
        ? { status: "FAIL", name: "bindings", detail: `missing: ${missing.map((b) => `${b.name} (${b.purpose})`).join(", ")}` }
        : { status: "PASS", name: "bindings", detail: `all ${REQUIRED_BINDINGS.length} required bindings are declared` },
    );
    checks.push(triggerCheck(cronTriggers(loaded.config, loaded.root)));
    checks.push(jobsQueueCheck(loaded.config));
    chatQueue = { index: checks.push(chatQueueCheck(loaded.config)) - 1, config: loaded.config };
    const unmigrated = unmigratedClasses(loaded.config, loaded.root);
    if (unmigrated.length) checks.push({ status: "FAIL", name: "durable objects", detail: `no migration creates: ${unmigrated.join(", ")}` });
    const orphans = queuesWithoutConsumers(loaded.config);
    if (orphans.length) checks.push({ status: "WARN", name: "queues", detail: `no consumer for: ${orphans.join(", ")}` });
    const placeholders = environmentPlaceholders(loaded);
    checks.push(
      placeholders.length
        ? { status: "WARN", name: "placeholders", detail: `${placeholders.length} value(s) still hold \${...} placeholders (${placeholders.slice(0, 3).join(", ")}${placeholders.length > 3 ? ", ..." : ""}); run gtm setup${env ? ` --env ${env}` : ""}` }
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
  let manifests: AdapterManifest[] = [];
  if (config) {
    const loadedManifests = loadAdapterManifests(dir, config, deps.adaptersDir);
    manifests = loadedManifests.manifests;
    checks.push(...loadedManifests.checks);
    if (loadedManifests.checks.length === 0) checks.push({ status: "INFO", name: "adapters", detail: "no adapters are enabled yet" });
  }

  // Secrets.
  const required = requiredSecretNames(manifests);
  if (remote) {
    const deployed = await deployedSecretNames(wrangler, env);
    if ("error" in deployed) {
      checks.push({ status: "FAIL", name: "secrets", detail: `could not list the deployed secrets: ${deployed.error}` });
    } else {
      const missing = required.filter((n) => !deployed.names.has(n));
      checks.push(
        missing.length
          ? { status: "FAIL", name: "secrets", detail: `missing: ${missing.join(", ")}; set each with wrangler secret put` }
          : { status: "PASS", name: "secrets", detail: `all ${required.length} required secrets are set` },
      );
    }
  } else {
    const devVars = devVarNames(dir);
    const local = devVars ? ` (.dev.vars sets ${required.filter((n) => devVars.has(n)).length} of them for local development)` : "";
    checks.push({ status: "INFO", name: "secrets", detail: `required: ${required.join(", ")}${local}; pass --remote to verify the deployed secrets` });
  }

  // Webhook registration.
  const operator = manifests.find((m) => m.ports.includes("OperatorChannel"));
  checks.push(
    operator
      ? { status: "WARN", name: "webhooks", detail: `${operator.name} needs its webhook registered once the Worker is deployed (docs/OPERATOR.md, "Register the webhook")` }
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

  // Sending-domain DNS: SPF, DKIM and DMARC. Reported only; a lookup that fails is a WARN.
  const sendingDomain = config?.sending?.domain;
  if (config && typeof sendingDomain === "string") {
    if (remote) {
      checks.push(...(await dnsChecks(sendingDomain, config.company.domain, config.sending.dkimSelector, deps.fetch)));
    } else {
      checks.push({ status: "INFO", name: "DNS", detail: `SPF, DKIM and DMARC for ${sendingDomain}; pass --remote to resolve them` });
    }
  }

  // Halt flag and kill switch. Read together; an unreadable store counts as stopped.
  if (remote) {
    let values: Map<string, string | null> | undefined;
    try {
      values = await kvBulkGet(wrangler, [...STOP_FLAGS.map((f) => f.key), CHAT_BATCHING_FLAG], env);
    } catch {
      values = undefined;
    }
    const batching = values?.get(CHAT_BATCHING_FLAG);
    if (chatQueue && batching !== undefined) checks[chatQueue.index] = chatQueueCheck(chatQueue.config, isFlagOn(batching));
    for (const f of STOP_FLAGS) {
      const value = values?.get(f.key);
      if (values === undefined || value === undefined) {
        checks.push({ status: "FAIL", name: f.name, detail: `could not read ${f.key}; until it can be read, the system treats itself as stopped` });
      } else if (value === null) {
        checks.push({ status: "PASS", name: f.name, detail: `${f.key} is unset` });
      } else {
        checks.push({ status: "WARN", name: f.name, detail: `${f.whenSet}: ${value.trim().slice(0, 200)}` });
      }
    }
  } else {
    checks.push({ status: "INFO", name: "halt and kill switch", detail: "system:halt, outreach:cold-pause:critical and outreach:cold-pause live in KV; unset means running; pass --remote to read them" });
  }
  return checks;
}

function printFlags(io: Io): void {
  io.out("");
  io.out("Flags (defaults; unset flags use these values; gtm flags list shows the deployed values):");
  const width = Math.max(...FLAGS.map((f) => f.key.length));
  for (const f of FLAGS) io.out(`  ${f.key.padEnd(width)}  ${(f.default ?? "unset").padEnd(8)}  ${f.description}`);
  io.out("");
}
