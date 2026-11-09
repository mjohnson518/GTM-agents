// GTM-agents: `gtm setup`, which creates a deployment's Cloudflare resources and fills their ids and
// names into wrangler.jsonc.
//
// For one environment (production, the top level, or a named block such as staging) it:
//   1. reads wrangler.jsonc and finds the D1 database, KV namespace, R2 bucket, Vectorize index and
//      queues that still need a resource, deriving each missing name from the Worker's name and the
//      binding (my-agent-db, my-agent-kv, my-agent-memory, my-agent-events, ...);
//   2. asks Cloudflare, read-only, whether a resource with that name already exists. One the file
//      already names is reused; one the file does not name yet is adopted only with
//      --reuse-existing, because it may belong to another deployment with the same Worker name;
//   3. shows the plan and asks before changing anything (or proceeds with --yes);
//   4. creates what is missing, then writes the ids and names into wrangler.jsonc by replacing only
//      the placeholder strings, so comments and formatting survive. The file is not written if it
//      changed while setup ran.
// A second run finds everything in place and plans nothing. Afterwards it prints the secrets that
// are still missing as `wrangler secret put` lines. It never reads or prints a secret value.
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { EXIT, spawnRunner, type CommandRunner, type Io } from "../lib/io.ts";
import { parseJsonc } from "../lib/jsonc.ts";
import { pathKey, replaceStrings, stringSpans, type JsonPathPart, type Replacement, type StringSpan } from "../lib/jsonc-edit.ts";
import { loadDeploymentConfig } from "../lib/project.ts";
import { DEFAULT_ADAPTERS_DIR, deployedSecretNames, loadAdapterManifests, requiredSecretNames, secretPutLine } from "../lib/secrets.ts";
import { findWranglerConfig, isFilled, loadWranglerConfig, workerName, type LoadedWranglerConfig } from "../lib/wrangler-config.ts";
import { envLabel, failureLine, parseJsonOutput, wranglerAt, wranglerEnv, type Wrangler } from "../lib/wrangler.ts";

export interface SetupOptions {
  runner?: CommandRunner;
  adaptersDir?: string;
}

const USAGE = `Usage: gtm setup [--config <dir>] [--env staging|production] [--yes] [--reuse-existing] [--base-url <https-origin>]
                 [--vector-dimensions <n>] [--vector-metric cosine|euclidean|dot-product]`;

export const DEFAULT_VECTOR_DIMENSIONS = 1536;
const METRICS = ["cosine", "euclidean", "dot-product"];
/** Queue, D1, R2 and Vectorize names: lowercase letters, digits and hyphens, at most 63 characters. */
const RESOURCE_NAME = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;

type Kind = "d1" | "kv" | "r2" | "vectorize" | "queue";

const LABELS: Record<Kind, string> = { d1: "D1 database", kv: "KV namespace", r2: "R2 bucket", vectorize: "Vectorize index", queue: "queue" };

interface Resource {
  kind: Kind;
  /** The name (or, for KV, the title) the resource has or will have. */
  name: string;
  exists: boolean;
  /** The id Wrangler config needs (D1 and KV), once known. */
  id?: string;
  /** Extra detail for the plan line. */
  note?: string;
  /** How to create a Vectorize index. */
  vector?: { dimensions: number; metric: string };
  /** True when setup derived the name; false when wrangler.jsonc already names the resource. */
  derived: boolean;
  /** For an existing Vectorize index: its dimensions, when they differ from the ones asked for. */
  mismatch?: string;
}

interface Fill {
  /** Path inside the environment's block. */
  path: JsonPathPart[];
  value: () => string | undefined;
  /** The resource the value comes from, if any. */
  resource?: Resource;
}

interface Plan {
  resources: Resource[];
  fills: Fill[];
  /** Placeholders setup does not fill. */
  remaining: string[];
  problems: string[];
}

const asArray = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);
const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** A value setup may fill: an empty string or a ${...} placeholder. */
const needsValue = (v: unknown): v is string => typeof v === "string" && (v === "" || v.includes("${"));
const slug = (binding: string): string => binding.toLowerCase().replace(/_+/g, "-");
/** A binding name from config, or the fallback when it is missing or not a string. */
const bindingName = (value: unknown, fallback: string): string => (typeof value === "string" && value !== "" ? value : fallback);

/** Name a resource after a placeholder token, for a queue no producer binding names: ${STAGING_EVENTS_DLQ_NAME} -> events-dlq. */
function tokenSlug(value: string): string {
  const token = /\$\{([A-Za-z0-9_]+)\}/.exec(value)?.[1] ?? "resource";
  return slug(token.replace(/^STAGING_/, "").replace(/_(?:NAME|ID)$/, ""));
}

export async function setupCommand(args: string[], io: Io, options: SetupOptions = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        config: { type: "string" },
        env: { type: "string" },
        yes: { type: "boolean", default: false },
        "reuse-existing": { type: "boolean", default: false },
        "base-url": { type: "string" },
        "vector-dimensions": { type: "string" },
        "vector-metric": { type: "string" },
      },
    });
  } catch (err) {
    io.err(`gtm setup: ${(err as Error).message}`);
    io.err(USAGE);
    return EXIT.usage;
  }
  const dir = resolve(io.cwd, parsed.values.config ?? ".");
  const env = wranglerEnv(parsed.values.env);
  const dimensions = Number(parsed.values["vector-dimensions"] ?? DEFAULT_VECTOR_DIMENSIONS);
  const metric = parsed.values["vector-metric"] ?? "cosine";
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4096) {
    io.err("gtm setup: --vector-dimensions must be a whole number from 1 to 4096 (it must match your embedding model)");
    return EXIT.usage;
  }
  if (!METRICS.includes(metric)) {
    io.err(`gtm setup: --vector-metric must be one of ${METRICS.join(", ")}`);
    return EXIT.usage;
  }
  let baseUrl: string | undefined;
  if (parsed.values["base-url"] !== undefined) {
    baseUrl = httpsOrigin(parsed.values["base-url"]);
    if (!baseUrl) {
      io.err("gtm setup: --base-url must be an https origin such as https://agent.acme.example (no path)");
      return EXIT.usage;
    }
  }

  const path = findWranglerConfig(dir);
  if (!path) {
    io.err(`gtm setup: no wrangler.jsonc or wrangler.json in ${dir}`);
    return EXIT.usage;
  }
  const original = readFileSync(path, "utf8");
  let loaded: LoadedWranglerConfig;
  let spans: StringSpan[];
  try {
    loaded = loadWranglerConfig(dir, env);
    spans = stringSpans(original);
  } catch (err) {
    io.err(`gtm setup: ${(err as Error).message}`);
    return EXIT.usage;
  }
  const worker = workerName(loaded, env);
  const prefix: JsonPathPart[] = env ? ["env", env] : [];
  const blockSpans = new Map<string, StringSpan>();
  for (const s of spans) {
    const inBlock = env ? s.path[0] === "env" && s.path[1] === env : s.path[0] !== "env";
    if (inBlock) blockSpans.set(pathKey(s.path.slice(prefix.length)), s);
  }

  const show = relative(io.cwd, dir) || ".";
  io.out(`gtm setup: ${show} (${envLabel(env)}, Worker ${worker})`);

  const plan = planResources(loaded.config, worker, { dimensions, metric, baseUrl });
  const filledPaths = new Set(plan.fills.map((f) => pathKey(f.path)));
  for (const [key, span] of blockSpans) {
    if (span.value.includes("${") && !filledPaths.has(key)) plan.remaining.push(key);
  }
  if (plan.problems.length) {
    for (const p of plan.problems) io.err(`gtm setup: ${p}`);
    return EXIT.failed;
  }

  // Read-only lookups first: nothing is created until the whole plan is known.
  const wrangler = wranglerAt(options.runner ?? spawnRunner, dir);
  try {
    await lookUp(wrangler, plan.resources);
  } catch (err) {
    io.err(`gtm setup: ${(err as Error).message}; nothing was created`);
    return EXIT.failed;
  }
  // Adopting a resource that wrangler.jsonc does not name yet could mean taking over another
  // deployment's database or namespace (two deployments with the same Worker name), so it needs
  // an explicit --reuse-existing. A resource the file already names is this deployment's.
  const adopted = plan.resources.filter((r) => r.exists && r.derived);
  const refusals = [
    ...plan.resources.filter((r) => r.mismatch).map((r) => `the existing ${LABELS[r.kind]} ${r.name} has ${r.mismatch}; its dimensions cannot change, so pass matching --vector-dimensions and --vector-metric, or name another index in wrangler.jsonc`),
    ...(parsed.values["reuse-existing"] ? [] : adopted.map((r) => `a ${LABELS[r.kind]} named ${r.name} already exists in this account; if it belongs to this deployment, rerun with --reuse-existing, otherwise give this Worker a different name`)),
  ];
  if (refusals.length) {
    printPlan(io, plan.resources, plan.fills);
    for (const r of refusals) io.err(`gtm setup: ${r}`);
    io.err("gtm setup: nothing was created or written");
    return EXIT.failed;
  }

  const toCreate = plan.resources.filter((r) => !r.exists);
  const fills = plan.fills.filter((f) => blockSpans.has(pathKey(f.path)));
  printPlan(io, plan.resources, fills);
  if (toCreate.length === 0 && fills.length === 0) {
    io.out("Nothing to do: every resource exists, and its ids and names are in wrangler.jsonc.");
  } else {
    if (!parsed.values.yes) {
      if (!io.confirm) {
        io.err("gtm setup: there is no terminal to confirm on; rerun with --yes to apply this plan");
        return EXIT.usage;
      }
      const question = `${toCreate.length ? `Create ${toCreate.length} resource(s) and write` : "Write"} ${fills.length} value(s) to ${basename(path)}?`;
      if (!(await io.confirm(question))) {
        io.out("gtm setup: nothing was changed.");
        return EXIT.ok;
      }
    }
    const createFailure = await createAll(wrangler, toCreate, io);
    if (toCreate.some((r) => r.kind === "d1" || r.kind === "kv")) {
      try {
        await lookUp(wrangler, plan.resources.filter((r) => (r.kind === "d1" || r.kind === "kv") && r.id === undefined));
      } catch (err) {
        io.err(`gtm setup: could not read back the new ids: ${(err as Error).message}`);
      }
    }
    const written = writeFills(io, path, original, prefix, blockSpans, fills);
    if (createFailure || !written) {
      io.err("gtm setup: stopped before finishing; fix the error above and run gtm setup again (it reuses what exists)");
      return EXIT.failed;
    }
  }

  if (plan.remaining.length) {
    io.out("");
    io.out("Still to fill in by hand in wrangler.jsonc:");
    for (const key of plan.remaining) io.out(`  ${key}${key === "vars.AGENT_BASE_URL" ? "   (or pass --base-url https://<your-host>)" : ""}`);
  }
  const producers = asArray(asObject(loaded.config.queues).producers);
  const chatIndex = producers.findIndex((p) => p.binding === "CHAT_QUEUE");
  const chatQueue = producers[chatIndex]?.queue;
  const chatName = isFilled(chatQueue) ? chatQueue : plan.fills.find((f) => pathKey(f.path) === `queues.producers[${chatIndex}].queue`)?.value();
  if (chatName) {
    io.out("");
    io.out(`The chat queue is ${chatName}; list it in agent.chatQueue in src/index.ts so chat turns reach the operator agent directly.`);
  }

  await printSecrets(io, dir, env, wrangler, options.adaptersDir ?? DEFAULT_ADAPTERS_DIR);
  io.out("");
  io.out("Next:");
  const flag = env ? ` --env ${env}` : "";
  io.out(`  npx gtm migrate${flag}         apply the D1 migrations`);
  io.out(`  npx gtm brain upload${flag}    upload the locked brain and templates`);
  io.out(`  npx gtm deploy${flag}          check, migrate and deploy`);
  return EXIT.ok;
}

function httpsOrigin(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Work out, from the environment's block alone, which resources it needs and which strings to fill. */
function planResources(config: Record<string, unknown>, worker: string, opts: { dimensions: number; metric: string; baseUrl: string | undefined }): Plan {
  const plan: Plan = { resources: [], fills: [], remaining: [], problems: [] };
  const byKey = new Map<string, Resource>();
  const resource = (kind: Kind, name: string, derived: boolean, extra: Partial<Resource> = {}): Resource => {
    const key = `${kind}:${name}`;
    let r = byKey.get(key);
    if (r) {
      if (!derived) r.derived = false;
    } else {
      r = { kind, name, exists: false, ...extra, derived };
      byKey.set(key, r);
      plan.resources.push(r);
      if (kind !== "kv" && !RESOURCE_NAME.test(name)) {
        plan.problems.push(`"${name}" is not a valid ${LABELS[kind]} name (lowercase letters, digits and hyphens, 3 to 63 characters); set the name in wrangler.jsonc yourself, or use a shorter Worker name`);
      }
    }
    return r;
  };
  const constant = (value: string) => () => value;

  asArray(config.d1_databases).forEach((db, i) => {
    if (isFilled(db.database_id)) return;
    if (!needsValue(db.database_id)) {
      plan.problems.push(`d1_databases[${i}] has no database_id string to fill; add "database_id": "\${DB_ID}"`);
      return;
    }
    const name = isFilled(db.database_name) ? db.database_name : `${worker}-${slug(bindingName(db.binding, "db"))}`;
    const r = resource("d1", name, !isFilled(db.database_name));
    if (needsValue(db.database_name)) plan.fills.push({ path: ["d1_databases", i, "database_name"], value: constant(name), resource: r });
    plan.fills.push({ path: ["d1_databases", i, "database_id"], value: () => r.id, resource: r });
  });

  asArray(config.kv_namespaces).forEach((kv, i) => {
    if (isFilled(kv.id)) return;
    if (!needsValue(kv.id)) {
      plan.problems.push(`kv_namespaces[${i}] has no id string to fill; add "id": "\${KV_ID}"`);
      return;
    }
    const r = resource("kv", `${worker}-${slug(bindingName(kv.binding, "kv"))}`, true);
    plan.fills.push({ path: ["kv_namespaces", i, "id"], value: () => r.id, resource: r });
  });

  asArray(config.r2_buckets).forEach((bucket, i) => {
    const name = isFilled(bucket.bucket_name) ? bucket.bucket_name : `${worker}-${slug(bindingName(bucket.binding, "bucket"))}`;
    const r = resource("r2", name, !isFilled(bucket.bucket_name));
    if (needsValue(bucket.bucket_name)) plan.fills.push({ path: ["r2_buckets", i, "bucket_name"], value: constant(name), resource: r });
  });

  asArray(config.vectorize).forEach((index, i) => {
    const name = isFilled(index.index_name) ? index.index_name : `${worker}-${slug(bindingName(index.binding, "memory"))}`;
    const r = resource("vectorize", name, !isFilled(index.index_name), { note: `${opts.dimensions} dimensions, ${opts.metric}`, vector: { dimensions: opts.dimensions, metric: opts.metric } });
    if (needsValue(index.index_name)) plan.fills.push({ path: ["vectorize", i, "index_name"], value: constant(name), resource: r });
  });

  // Queues: one placeholder can appear in a producer, a consumer and a dead-letter setting; each
  // distinct placeholder becomes one queue.
  const queues = asObject(config.queues);
  const byToken = new Map<string, string>();
  const queueName = (value: unknown, derive: () => string): string | undefined => {
    if (isFilled(value)) return value;
    if (!needsValue(value)) return undefined;
    if (value !== "" && byToken.has(value)) return byToken.get(value);
    const name = derive();
    if (value !== "") byToken.set(value, name);
    return name;
  };
  asArray(queues.producers).forEach((p, i) => {
    const name = queueName(p.queue, () => `${worker}-${slug(bindingName(p.binding, "queue").replace(/_QUEUE$/i, ""))}`);
    if (!name) return;
    const r = resource("queue", name, !isFilled(p.queue));
    if (needsValue(p.queue)) plan.fills.push({ path: ["queues", "producers", i, "queue"], value: constant(name), resource: r });
  });
  asArray(queues.consumers).forEach((c, i) => {
    const name = queueName(c.queue, () => `${worker}-${tokenSlug(String(c.queue))}`);
    if (!name) return;
    const r = resource("queue", name, !isFilled(c.queue));
    if (needsValue(c.queue)) plan.fills.push({ path: ["queues", "consumers", i, "queue"], value: constant(name), resource: r });
    if (c.dead_letter_queue !== undefined) {
      const dlq = queueName(c.dead_letter_queue, () => `${name}-dlq`);
      if (!dlq) return;
      const d = resource("queue", dlq, !isFilled(c.dead_letter_queue));
      if (needsValue(c.dead_letter_queue)) plan.fills.push({ path: ["queues", "consumers", i, "dead_letter_queue"], value: constant(dlq), resource: d });
    }
  });

  const vars = asObject(config.vars);
  if (opts.baseUrl && needsValue(vars.AGENT_BASE_URL)) {
    plan.fills.push({ path: ["vars", "AGENT_BASE_URL"], value: constant(opts.baseUrl) });
  }
  return plan;
}

/**
 * Find which resources exist, read-only. D1 databases, KV namespaces, R2 buckets and Vectorize
 * indexes come from Wrangler's list commands; a queue is looked up by name, because Wrangler lists
 * only the first page of queues. Throws when Cloudflare cannot be asked, so nothing is created on
 * a guess.
 */
async function lookUp(wrangler: Wrangler, resources: Resource[]): Promise<void> {
  const of = (kind: Kind) => resources.filter((r) => r.kind === kind);
  if (of("d1").length) {
    const list = await listJson(wrangler, ["d1", "list", "--json"], "D1 databases");
    for (const r of of("d1")) {
      const found = list.find((d) => d.name === r.name);
      r.exists = found !== undefined;
      if (found && typeof found.uuid === "string") r.id = found.uuid;
    }
  }
  if (of("kv").length) {
    const list = await listJson(wrangler, ["kv", "namespace", "list"], "KV namespaces");
    for (const r of of("kv")) {
      const found = list.find((n) => n.title === r.name);
      r.exists = found !== undefined;
      if (found && typeof found.id === "string") r.id = found.id;
    }
  }
  // `r2 bucket list` reads one page and ignores the config's account, so each bucket is looked up by name.
  for (const r of of("r2")) {
    const result = await wrangler(["r2", "bucket", "info", r.name, "--json"]);
    const output = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`);
    if (result.code === 0) r.exists = true;
    else if (/specified bucket does not exist|\b10006\b/i.test(output)) r.exists = false;
    else throw new Error(`could not look up R2 bucket ${r.name}: ${failureLine(result)}`);
  }
  if (of("vectorize").length) {
    const list = await listJson(wrangler, ["vectorize", "list", "--json"], "Vectorize indexes");
    for (const r of of("vectorize")) {
      const found = list.find((v) => v.name === r.name);
      r.exists = found !== undefined;
      const config = asObject(found?.config);
      if (found && typeof config.dimensions === "number") {
        const metric = typeof config.metric === "string" ? config.metric : "unknown metric";
        r.note = `${config.dimensions} dimensions, ${metric}`;
        const differs = r.vector && (config.dimensions !== r.vector.dimensions || (typeof config.metric === "string" && config.metric !== r.vector.metric));
        // Only an index setup would adopt is refused; one wrangler.jsonc already names is left as it is.
        if (differs && r.derived && r.vector) r.mismatch = `${config.dimensions} dimensions and ${metric}, not the ${r.vector.dimensions} and ${r.vector.metric} asked for`;
      }
    }
  }
  for (const r of of("queue")) {
    const result = await wrangler(["queues", "info", r.name]);
    const output = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`);
    if (result.code === 0 && output.split("\n").some((line) => line.trim() === `Queue Name: ${r.name}`)) r.exists = true;
    else if (/does not exist/i.test(output)) r.exists = false;
    else throw new Error(`could not look up queue ${r.name}: ${failureLine(result)}`);
  }
}

async function listJson(wrangler: Wrangler, args: string[], what: string): Promise<Array<Record<string, unknown>>> {
  const result = await wrangler(args);
  if (result.code !== 0) throw new Error(`could not list ${what}: ${failureLine(result)}`);
  let parsed: unknown;
  try {
    parsed = parseJsonOutput(result.stdout);
  } catch {
    throw new Error(`could not read the list of ${what}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`could not read the list of ${what}`);
  return parsed as Array<Record<string, unknown>>;
}

function printPlan(io: Io, resources: Resource[], fills: Fill[]): void {
  const fillsFor = (r: Resource) => fills.filter((f) => f.resource === r).length;
  const lines: string[] = [];
  for (const r of resources) {
    const label = LABELS[r.kind].padEnd(16);
    const note = r.note ? ` (${r.note})` : "";
    if (!r.exists) lines.push(`  create  ${label} ${r.name}${note}`);
    else if (fillsFor(r) > 0 || r.derived) lines.push(`  reuse   ${label} ${r.name}${note}${r.id ? `, id ${r.id}` : ""}${r.derived ? " (already in this account)" : ""}`);
    // The bucket name is the one name the template sets before setup ever runs (Wrangler validates
    // its format), so an existing bucket under it may be another deployment's: say so.
    else if (r.kind === "r2") lines.push(`  reuse   ${label} ${r.name}${note} (named in wrangler.jsonc and already in this account; make sure it is this deployment's)`);
    else lines.push(`  exists  ${label} ${r.name}${note}`);
  }
  for (const f of fills) if (!f.resource) lines.push(`  fill    ${pathKey(f.path)} = ${f.value() ?? ""}`);
  if (lines.length === 0) return;
  io.out("Plan:");
  for (const l of lines) io.out(l);
  if (fills.length) io.out(`  ${fills.length} value(s) will be written to wrangler.jsonc.`);
}

/** Create each missing resource in turn. Returns true when one failed (the rest are not attempted). */
async function createAll(wrangler: Wrangler, toCreate: Resource[], io: Io): Promise<boolean> {
  for (const r of toCreate) {
    const result = await wrangler(createArgs(r));
    if (result.code !== 0) {
      io.err(`gtm setup: could not create ${LABELS[r.kind]} ${r.name}: ${failureLine(result)}`);
      return true;
    }
    r.exists = true;
    io.out(`created ${LABELS[r.kind]} ${r.name}`);
  }
  return false;
}

/**
 * The Wrangler command that creates one resource. --update-config=false stops Wrangler from editing
 * wrangler.jsonc itself; setup writes the file, surgically, once everything is known. No --env is
 * passed: Wrangler would prefix KV titles with it, and the names here are already per environment.
 */
function createArgs(r: Resource): string[] {
  switch (r.kind) {
    case "d1":
      return ["d1", "create", r.name, "--update-config=false"];
    case "kv":
      return ["kv", "namespace", "create", r.name, "--update-config=false"];
    case "r2":
      return ["r2", "bucket", "create", r.name, "--update-config=false"];
    case "vectorize":
      return ["vectorize", "create", r.name, `--dimensions=${r.vector?.dimensions ?? DEFAULT_VECTOR_DIMENSIONS}`, `--metric=${r.vector?.metric ?? "cosine"}`, "--update-config=false"];
    case "queue":
      return ["queues", "create", r.name];
  }
}

/**
 * Replace the placeholder strings with their values and write the file atomically. Refuses when the
 * file changed since setup read it, or when the edit would not parse back to the expected values;
 * either way it prints the values so they can be entered by hand. Returns false when it did not write.
 */
function writeFills(io: Io, path: string, original: string, prefix: JsonPathPart[], spans: Map<string, StringSpan>, fills: Fill[]): boolean {
  const replacements: Replacement[] = [];
  const expected: Array<{ path: JsonPathPart[]; value: string }> = [];
  const unresolved: string[] = [];
  for (const f of fills) {
    const span = spans.get(pathKey(f.path));
    const value = f.value();
    if (!span) continue;
    if (value === undefined) {
      unresolved.push(pathKey(f.path));
      continue;
    }
    replacements.push({ start: span.start, end: span.end, value });
    expected.push({ path: [...prefix, ...f.path], value });
  }
  if (replacements.length === 0) {
    if (unresolved.length) io.err(`gtm setup: no value yet for ${unresolved.join(", ")}`);
    return unresolved.length === 0;
  }
  const manual = () => {
    for (const e of expected) io.err(`  ${pathKey(e.path)} = ${e.value}`);
  };
  if (readFileSync(path, "utf8") !== original) {
    io.err(`gtm setup: ${basename(path)} changed while setup was running, so it was not written. Enter these values yourself, or run gtm setup again:`);
    manual();
    return false;
  }
  const next = replaceStrings(original, replacements);
  let check: unknown;
  try {
    check = parseJsonc(next);
  } catch {
    check = undefined;
  }
  const valueAt = (root: unknown, p: JsonPathPart[]): unknown => p.reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as Record<string | number, unknown>)[key] : undefined), root);
  if (check === undefined || expected.some((e) => valueAt(check, e.path) !== e.value)) {
    io.err(`gtm setup: the edited ${basename(path)} did not read back as expected, so it was not written. Enter these values yourself:`);
    manual();
    return false;
  }
  // Write through a symlink to the real file, so a linked wrangler.jsonc gets the values.
  const target = realpathSync(path);
  const tmp = `${target}.gtm-setup.tmp`;
  try {
    writeFileSync(tmp, next);
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    io.err(`gtm setup: could not write ${basename(path)}: ${(err as Error).message}. Enter these values yourself:`);
    manual();
    return false;
  }
  io.out(`wrote ${replacements.length} value(s) to ${basename(path)}`);
  if (unresolved.length) io.err(`gtm setup: no value yet for ${unresolved.join(", ")}`);
  return unresolved.length === 0;
}

/** Print the required secrets that are not set yet, as commands. Names only, never values. */
async function printSecrets(io: Io, dir: string, env: string | undefined, wrangler: Wrangler, adaptersDir: string): Promise<void> {
  io.out("");
  let config;
  try {
    config = await loadDeploymentConfig(dir);
  } catch (err) {
    io.out(`Secrets: gtm.config.ts could not be loaded (${(err as Error).message.split("\n")[0] ?? ""}), so the adapters' secrets are unknown; run gtm doctor.`);
    return;
  }
  const required = requiredSecretNames(config ? loadAdapterManifests(dir, config, adaptersDir).manifests : []);
  const deployed = await deployedSecretNames(wrangler, env);
  if ("error" in deployed) {
    io.out("Secrets: the deployed secrets could not be listed (normal before the first deploy). Set each required secret; Wrangler prompts for the value:");
    for (const name of required) io.out(`  ${secretPutLine(name, env)}`);
    return;
  }
  const missing = required.filter((n) => !deployed.names.has(n));
  if (missing.length === 0) {
    io.out(`Secrets: all ${required.length} required secrets are set.`);
    return;
  }
  io.out("Secrets still missing; set each one, and Wrangler prompts for the value:");
  for (const name of missing) io.out(`  ${secretPutLine(name, env)}`);
}
