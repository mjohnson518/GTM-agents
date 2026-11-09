// GTM-agents: the dashboard's system methods: status and health, the GTM cockpit (the kill switch and
// the deferred queue), the security audit, the redacted configuration, flags, cost, agents and the
// optional sources (fitness, link triage, the changelog).
//
// Every action goes through the module that owns it: pause and resume through the kill switch
// (sending/kill-switch.ts), replay through the deferred queue's replay (sending/deferred.ts), which
// sends through the same boundary and gates as every other send. Draining only cancels queued rows,
// so it can never cause a send.
import { EARNABLE_ACTION_CLASSES, PERMANENT_HUMAN, effectiveLevel } from "../autonomy/levels.ts";
import { levelFlagKey } from "../autonomy/store.ts";
import { MICRO_CENTS_PER_CENT } from "../budget/cost-ledger.ts";
import { readBudgetSettings } from "../budget/gate.ts";
import { isFlagOn } from "../jobs/loop.ts";
import { daysBefore } from "../metrics/window.ts";
import { measurementHealth } from "../metrics/health.ts";
import { countReplies, countSends } from "../metrics/outreach.ts";
import { MODEL_ROLES } from "../ports/model.ts";
import { readHalt } from "../security/halt.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { replayDeferred } from "../sending/deferred.ts";
import { DELIVERY_FLAGS, DELIVERY_LIMITS, readCap, readSwitch } from "../sending/flags.ts";
import { senderDepsFromEnv } from "../sending/jobs.ts";
import { pauseColdOutreach, readColdPause, resumeColdOutreach } from "../sending/kill-switch.ts";
import { HUB_TOOL_DEFINITIONS } from "../tools/index.ts";
import { FLAGS } from "../flags/registry.ts";
import { RpcError, shown, type GatewayContext, type Handler } from "./context.ts";
import { CONCRETE_FLAGS, checkFlagWrite, isEditableFlag } from "./flags.ts";
import type { SystemStatus } from "./protocol.ts";
import { tryBuild } from "./wiring.ts";

/** Rows a dashboard replay hands to the send boundary at most. */
export const REPLAY_MAX_ROWS = 50;
/** Queued rows a dashboard drain cancels at most per call. */
export const DRAIN_MAX_ROWS = 1000;
const MAX_CHANGELOG_BYTES = 256 * 1024;

const ADMIN_FLAG = "admin:enabled";

async function readFlag(ctx: GatewayContext, key: string): Promise<string | null> {
  try {
    return await ctx.flags.get(key);
  } catch {
    return null;
  }
}

export async function systemStatus(ctx: GatewayContext): Promise<SystemStatus> {
  const { env } = ctx;
  const now = ctx.now();
  const [halt, pause, flagsOn, failing, health] = await Promise.all([
    readHalt(env.KV),
    readColdPause(env.KV),
    Promise.all(FLAGS.filter((f) => f.kind === "boolean" && !f.key.includes("<")).map(async (f) => ((await readFlag(ctx, f.key)) === "true" ? f.key : null))).then((keys) =>
      keys.filter((k): k is string => k !== null),
    ),
    shown(async () => {
      const { results } = await env.DB.prepare(
        `SELECT r.task_name AS job, r.error AS error, r.started_at AS at FROM execution_runs r
          WHERE r.status = 'failed' AND r.trigger IN ('cron', 'rerun', 'manual') AND r.started_at >= ?1
            AND r.started_at = (SELECT MAX(x.started_at) FROM execution_runs x WHERE x.task_name = r.task_name AND x.status IN ('completed', 'failed'))
          ORDER BY r.started_at DESC LIMIT 20`,
      )
        .bind(new Date(now.getTime() - 86_400_000).toISOString())
        .all<{ job: string; error: string | null; at: string }>();
      return results;
    }),
    shown(() => measurementHealth(env.DB, now)),
  ]);
  return {
    halted: halt.halted,
    coldPause: { paused: pause.paused, ...(pause.severity ? { severity: pause.severity } : {}), ...(pause.reason ? { reason: pause.reason } : {}), ...(pause.since ? { since: pause.since } : {}) },
    flagsOn,
    failingJobs: (failing ?? []).map((r) => ({ job: r.job, ...(r.error ? { lastError: sanitizeErrorMessage(r.error).slice(0, 200) } : {}), at: r.at })),
    measurementHealthy: health !== null && !health.blocksReplyConclusions && !health.blocksProductConclusions,
  };
}

export const status: Handler<"status"> = (_p, ctx) => systemStatus(ctx);

/** Reachability only: health runs before connect, so it says nothing about the deployment. */
export const health: Handler<"health"> = async (_p, ctx) => {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  try {
    await ctx.env.DB.prepare("SELECT 1 AS one").first();
    checks.push({ name: "database", ok: true });
  } catch {
    checks.push({ name: "database", ok: false, detail: "the database did not answer" });
  }
  try {
    await ctx.env.KV.get(ADMIN_FLAG);
    checks.push({ name: "flags", ok: true });
  } catch {
    checks.push({ name: "flags", ok: false, detail: "the flag store did not answer" });
  }
  return { ok: checks.every((c) => c.ok), checks };
};

export const cockpitGet: Handler<"cockpit.get"> = async (_p, ctx) => {
  const { env } = ctx;
  const now = ctx.now();
  const week = daysBefore(now, 7);
  const fortnight = daysBefore(now, 14);
  const [state, domainCap, accountCap, deferred, sends, replies, discovery, coldBatch, delivery] = await Promise.all([
    systemStatus(ctx),
    shown(() => readCap(ctx.flags, DELIVERY_FLAGS.domainDailyCap, DELIVERY_LIMITS.domainDailyCap)),
    shown(() => readCap(ctx.flags, DELIVERY_FLAGS.accountWeeklyCap, DELIVERY_LIMITS.accountWeeklyCap)),
    shown(async () => {
      const { results } = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM deferred_sends GROUP BY status").all<{ status: string; n: number }>();
      return Object.fromEntries(results.map((r) => [r.status, Number(r.n)]));
    }),
    shown(() => countSends(env.DB, week)),
    shown(() => countReplies(env.DB, week)),
    shown(async () => {
      const { results } = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM candidates WHERE created_at >= ?1 GROUP BY status").bind(fortnight.from).all<{ status: string; n: number }>();
      return Object.fromEntries(results.map((r) => [r.status, Number(r.n)]));
    }),
    shown(() => readSwitch(ctx.flags, DELIVERY_FLAGS.coldBatchEnabled)),
    shown(() => readSwitch(ctx.flags, DELIVERY_FLAGS.enabled)),
  ]);
  return {
    halted: state.halted,
    coldPause: state.coldPause,
    coldBatchEnabled: coldBatch,
    deliveryEnabled: delivery,
    caps: { domainDaily: domainCap, accountWeekly: accountCap },
    deferredQueue: deferred,
    outreach7d: { sends, replies },
    discovery14d: discovery,
    replayAvailable: ctx.wiring.email !== undefined,
  };
};

export const cockpitPause: Handler<"cockpit.pause"> = async (p, ctx) => {
  if (!ctx.env.KV) throw new RpcError("unavailable", "the flag store is not bound");
  // The operator's pause is critical: automation never lifts it.
  await pauseColdOutreach(ctx.env.KV, { reason: p.reason, source: ctx.actor, severity: "critical" }, ctx.now());
  ctx.audit.severity = "critical";
  const next = await systemStatus(ctx);
  ctx.broadcast({ event: "status", data: next });
  return next;
};

export const cockpitResume: Handler<"cockpit.resume"> = async (_p, ctx) => {
  if (!ctx.env.KV) throw new RpcError("unavailable", "the flag store is not bound");
  const result = await resumeColdOutreach(ctx.env.KV, { liftCritical: true });
  if (!result.ok) throw new RpcError("conflict", result.refused);
  ctx.audit.previous = result.previous.severity ?? "none";
  const next = await systemStatus(ctx);
  ctx.broadcast({ event: "status", data: next });
  return next;
};

/** Cancel queued deferred sends. Cancelling can only stop mail, never send it. */
export const cockpitDrain: Handler<"cockpit.drain"> = async (p, ctx) => {
  const result = await ctx.env.DB.prepare(
    `UPDATE deferred_sends SET status = 'cancelled', last_error = ?1
      WHERE id IN (SELECT id FROM deferred_sends WHERE status = 'queued' ORDER BY next_attempt_at LIMIT ?2) AND status = 'queued'`,
  )
    .bind(`drained by ${ctx.actor}: ${p.reason}`.slice(0, 500), DRAIN_MAX_ROWS)
    .run();
  const cancelled = result.meta.changes ?? 0;
  ctx.audit.cancelled = cancelled;
  return { cancelled };
};

/** Replay due deferred sends now, through the same replay and send boundary as the scheduled job. */
export const cockpitReplay: Handler<"cockpit.replay"> = async (_p, ctx) => {
  const { env, wiring } = ctx;
  if (!(await readSwitch(ctx.flags, DELIVERY_FLAGS.enabled))) throw new RpcError("unavailable", `delivery is off (${DELIVERY_FLAGS.enabled}), so nothing was replayed`);
  const provider = tryBuild(wiring.email, env);
  if (!provider) throw new RpcError("unavailable", "no email provider is configured, so nothing was replayed");
  const operator = tryBuild(wiring.operator, env);
  const result = await replayDeferred({
    ...senderDepsFromEnv(env, { config: wiring.config, provider, ...(operator ? { operator } : {}), now: ctx.now }),
    flags: ctx.flags,
    maxRows: REPLAY_MAX_ROWS,
  });
  ctx.audit.claimed = result.claimed;
  ctx.audit.sent = result.sent;
  ctx.audit.requeued = result.requeued;
  ctx.audit.cancelled = result.cancelled;
  return { replayed: result.sent };
};

const SECRET_NAMES = ["GATEWAY_TOKEN", "UNSUBSCRIBE_SIGNING_KEY", "PRODUCT_WEBHOOK_SECRET", "PRODUCT_READ_SECRET", "MAIL_PUSH_SECRET", "GOOGLE_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"] as const;
const MIN_SECRET_CHARS = 32;

const secretSet = (env: Record<string, unknown>, name: string): boolean => typeof env[name] === "string" && (env[name]).length > 0;

export const securityAudit: Handler<"security.audit"> = async (_p, ctx) => {
  const env = ctx.env as unknown as Record<string, unknown>;
  const { config } = ctx.wiring;
  const out: Array<{ check: string; ok: boolean; detail: string }> = [];
  const add = (check: string, ok: boolean, detail: string) => out.push({ check, ok, detail });

  for (const [name, required] of [
    ["GATEWAY_TOKEN", true],
    ["UNSUBSCRIBE_SIGNING_KEY", true],
  ] as const) {
    const set = secretSet(env, name);
    const long = set && (env[name] as string).length >= MIN_SECRET_CHARS;
    add(`secret ${name}`, set && long, !set ? `${name} is not set${required ? "; the routes that need it answer 503" : ""}` : long ? `${name} is set` : `${name} is set but shorter than ${MIN_SECRET_CHARS} characters`);
  }
  if (ctx.wiring.lifecycle) add("webhook secret PRODUCT_WEBHOOK_SECRET", secretSet(env, "PRODUCT_WEBHOOK_SECRET"), secretSet(env, "PRODUCT_WEBHOOK_SECRET") ? "the product webhook verifies signatures" : "the product webhook answers 503 until it is set");
  if (ctx.wiring.inbox) add("webhook secret MAIL_PUSH_SECRET", secretSet(env, "MAIL_PUSH_SECRET"), secretSet(env, "MAIL_PUSH_SECRET") ? "the mailbox push webhook checks its shared secret" : "the mailbox push webhook answers 503 until it is set");

  const halt = await readHalt(ctx.env.KV);
  add("halt flag readable", halt.unreadable !== true, halt.unreadable ? "the halt flag cannot be read, so everything is held (fail closed)" : halt.halted ? "readable; the system is halted" : "readable; the system is running");
  const pause = await readColdPause(ctx.env.KV);
  add("kill switch readable", pause.source !== "fail-closed", pause.source === "fail-closed" ? "the kill switch cannot be read, so cold outreach is held (fail closed)" : pause.paused ? `readable; cold outreach is paused (${pause.severity ?? "critical"})` : "readable; cold outreach is not paused");
  try {
    await readBudgetSettings(ctx.flags);
    add("budget readable", true, "the budget settings read cleanly");
  } catch {
    add("budget readable", false, "the budget settings cannot be read, so budgeted work is blocked (fail closed)");
  }

  const capped = PERMANENT_HUMAN.every((c) => effectiveLevel(c, 3) <= 1);
  add("permanently human-only classes capped", capped, capped ? `${PERMANENT_HUMAN.join(", ")} act at level 1 at most, whatever is stored` : "a permanently human-only class could act above level 1");
  const stored = await Promise.all(PERMANENT_HUMAN.map(async (c) => ({ c, raw: await readFlag(ctx, levelFlagKey(c)) })));
  const high = stored.filter((s) => s.raw !== null && Number(s.raw) > 1).map((s) => s.c);
  add("permanently human-only flags", high.length === 0, high.length === 0 ? "no stored level above 1" : `stored above 1 (ignored at runtime): ${high.join(", ")}`);
  const defaultsHigh = Object.entries(config.autonomy.defaults).filter(([c, l]) => (PERMANENT_HUMAN as readonly string[]).includes(c) && (l ?? 0) > 1);
  add("autonomy defaults", defaultsHigh.length === 0, defaultsHigh.length === 0 ? "no permanently human-only class starts above 1" : "a permanently human-only class starts above 1");
  const raised = (await Promise.all(EARNABLE_ACTION_CLASSES.map(async (c) => ({ c, raw: await readFlag(ctx, levelFlagKey(c)) })))).filter((s) => s.raw !== null && Number(s.raw) >= 2).map((s) => s.c);
  add("earned autonomy", true, raised.length === 0 ? "every class needs a person (level 1 or below)" : `at level 2 or above: ${raised.join(", ")}`);

  add("operator allowlist", config.operator.allowedChatIds.length > 0 && config.operator.allowedUserIds.length > 0, config.operator.allowedChatIds.length > 0 && config.operator.allowedUserIds.length > 0 ? "the operator chat answers only allowlisted ids" : "the operator chat answers no one until its allowlists are set");
  add("dashboard allowlist", (config.admin?.allowedEmails.length ?? 0) > 0, config.admin ? `${config.admin.allowedEmails.length} email(s) may use the dashboard, behind Cloudflare Access` : "the dashboard is not configured");
  const agentOn = isFlagOn(await readFlag(ctx, "operator:agent_enabled"));
  add("operator agent", true, agentOn ? "the chat agent is on" : "the chat agent is off");
  return out;
};

const redactAdapters = (adapters: Record<string, { enabled: boolean; options: Record<string, unknown> }>) =>
  Object.fromEntries(Object.entries(adapters).map(([name, a]) => [name, { enabled: a.enabled, options: Object.keys(a.options).sort() }]));

/** The configuration, with no secret values: secrets are reported only as set or not set. */
export const configGet: Handler<"config.get"> = (_p, ctx) => {
  const { config } = ctx.wiring;
  const env = ctx.env as unknown as Record<string, unknown>;
  return Promise.resolve({
    company: config.company,
    agent: config.agent,
    sending: { domain: config.sending.domain, from: config.sending.from, replyTo: config.sending.replyTo, windowDays: config.sending.windowDays, windowHours: config.sending.windowHours, bookingUrl: config.sending.bookingUrl ?? null },
    adapters: redactAdapters(config.adapters),
    models: { roles: config.models.roles, pricedModels: Object.keys(config.models.pricing).sort() },
    autonomy: config.autonomy,
    sequences: config.sequences,
    modules: config.modules,
    operator: { allowedChatIds: config.operator.allowedChatIds.length, allowedUserIds: config.operator.allowedUserIds.length },
    admin: config.admin ? { accessTeamDomain: config.admin.accessTeamDomain, allowedEmails: config.admin.allowedEmails.length, allowedOrigins: config.admin.allowedOrigins } : null,
    environment: typeof env.ENVIRONMENT === "string" ? env.ENVIRONMENT : null,
    baseUrl: typeof env.AGENT_BASE_URL === "string" ? env.AGENT_BASE_URL : null,
    secrets: Object.fromEntries(SECRET_NAMES.map((name) => [name, secretSet(env, name)])),
    wiring: { operator: ctx.wiring.operator !== undefined, model: ctx.wiring.model !== undefined, email: ctx.wiring.email !== undefined, inbox: ctx.wiring.inbox !== undefined, lifecycle: ctx.wiring.lifecycle },
    schedules: ctx.wiring.registry().schedules(),
  });
};

export const flagsList: Handler<"flags.list"> = async (_p, ctx) => {
  const values = new Map(await Promise.all(CONCRETE_FLAGS.map(async (f) => [f.key, await readFlag(ctx, f.key)] as const)));
  return FLAGS.map((f) => ({ key: f.key, kind: f.kind, default: f.default, value: values.get(f.key) ?? null, description: f.description, editable: isEditableFlag(f.key) }));
};

export const flagsSet: Handler<"flags.set"> = async (p, ctx) => {
  const checked = checkFlagWrite(p.key, p.value);
  ctx.audit.key = p.key.slice(0, 120);
  if (!checked.ok) throw new RpcError("forbidden", checked.error);
  if (!ctx.env.KV) throw new RpcError("unavailable", "the flag store is not bound");
  if (checked.value === null) await ctx.env.KV.delete(p.key);
  else await ctx.env.KV.put(p.key, checked.value);
  ctx.audit.value = checked.value === null ? null : checked.definition.kind === "json" ? "json" : checked.value.slice(0, 60);
  return { ok: true, value: checked.value };
};

export const costSummary: Handler<"cost.summary"> = async (p, ctx) => {
  const window = daysBefore(ctx.now(), p.days ?? 7);
  const { results } = await ctx.env.DB.prepare(
    "SELECT COALESCE(job, '') AS job, provider, SUM(cost_micro_cents) AS micro FROM cost_events WHERE created_at >= ?1 AND created_at < ?2 GROUP BY job, provider",
  )
    .bind(window.from, window.to)
    .all<{ job: string; provider: string; micro: number }>();
  const byJob: Record<string, number> = {};
  const byProvider: Record<string, number> = {};
  let total = 0;
  for (const r of results) {
    const micro = Number(r.micro) || 0;
    total += micro;
    const job = r.job || `provider:${r.provider}`;
    byJob[job] = (byJob[job] ?? 0) + micro;
    byProvider[r.provider] = (byProvider[r.provider] ?? 0) + micro;
  }
  const cents = (micro: number) => Math.round(micro / MICRO_CENTS_PER_CENT);
  return {
    totalCents: cents(total),
    byJob: Object.fromEntries(Object.entries(byJob).map(([k, v]) => [k, cents(v)])),
    byProvider: Object.fromEntries(Object.entries(byProvider).map(([k, v]) => [k, cents(v)])),
  };
};

const ROLE_AGENTS: Record<string, string> = {
  strategist: "hub",
  worker: "research worker",
  writer: "writer",
  judge: "quality reviewer",
  triage: "reply triage",
  classifier: "classifier tier",
  coder: "code mode",
  embedding: "memory embeddings",
};

export const agentsList: Handler<"agents.list"> = (_p, ctx) => {
  const roles = ctx.wiring.config.models.roles;
  return Promise.resolve(MODEL_ROLES.map((role) => ({ name: ROLE_AGENTS[role] ?? role, role, model: roles[role] ?? null, tools: role === "strategist" ? HUB_TOOL_DEFINITIONS.length : 0 })));
};

export const agentsStatus: Handler<"agents.status"> = async (_p, ctx) => {
  const jobs = ctx.wiring.registry().jobs;
  // One indexed lookup per registered job: the latest run, never a scan of the whole history.
  const last = await shown(async () => {
    const stmt = ctx.env.DB.prepare("SELECT task_name AS job, status, started_at AS at, summary FROM execution_runs WHERE task_name = ?1 AND trigger IN ('cron', 'rerun', 'manual') ORDER BY started_at DESC LIMIT 1");
    const batches = jobs.length > 0 ? await ctx.env.DB.batch(jobs.map((j) => stmt.bind(j.name))) : [];
    const rows = batches.flatMap((b) => (b.results ?? []) as Array<{ job: string; status: string; at: string; summary: string | null }>);
    return new Map(rows.map((r) => [r.job, r]));
  });
  return jobs.map((j) => {
    const run = last?.get(j.name);
    return {
      job: j.name,
      schedule: j.schedule,
      ...(j.flag ? { flag: j.flag } : {}),
      ...(run ? { lastRun: { status: run.status, at: run.at, ...(run.summary ? { summary: run.summary.slice(0, 300) } : {}) } } : {}),
    };
  });
};

export const fitnessTrend: Handler<"fitness.trend"> = async (p, ctx) => {
  const source = tryBuild(ctx.wiring.extensions.fitness, ctx.env);
  if (!source) return [];
  return source.trend(p.days ?? 30, ctx.now());
};

export const linkTriageStatus: Handler<"linkTriage.status"> = async (_p, ctx) => {
  const source = ctx.wiring.config.modules.linkIntake.enabled ? tryBuild(ctx.wiring.extensions.linkTriage, ctx.env) : undefined;
  if (!source) return { installed: false };
  return { installed: true, detail: await source.status(ctx.now()) };
};

export const learningSummary: Handler<"learning.summary"> = async (_p, ctx) => {
  const source = tryBuild(ctx.wiring.extensions.learning, ctx.env);
  if (!source) return { installed: false };
  return { installed: true, ...(await source.summary(ctx.now())) };
};

export interface ChangelogEntry {
  version: string;
  date: string;
  area: string;
  text: string;
}

/**
 * Parse a Keep a Changelog style file: "## [1.2.0] - 2026-11-01" (or "## 1.2.0 (2026-11-01)") starts
 * a release, "### Area" an area, and each "- " line is one entry.
 */
export function parseChangelog(markdown: string): ChangelogEntry[] {
  const out: ChangelogEntry[] = [];
  let version = "";
  let date = "";
  let area = "general";
  for (const line of markdown.split(/\r?\n/)) {
    const release = /^##\s+\[?([^\]\s]+)\]?(?:\s*[-(]\s*(\d{4}-\d{2}-\d{2})\)?)?/.exec(line);
    if (release && !line.startsWith("###")) {
      version = release[1] ?? "";
      date = release[2] ?? "";
      area = "general";
      continue;
    }
    const heading = /^###\s+(.+)$/.exec(line);
    if (heading) {
      area = (heading[1] ?? "general").trim().toLowerCase();
      continue;
    }
    const item = /^\s*[-*]\s+(.+)$/.exec(line);
    if (item && version) out.push({ version, date, area, text: (item[1] ?? "").trim().slice(0, 1000) });
  }
  return out.slice(0, 2000);
}

/** The deployment's CHANGELOG.md, served from the static assets (not public: only /admin/* is). */
export const changelogList: Handler<"changelog.list"> = async (p, ctx) => {
  const assets = ctx.env.ASSETS;
  if (!assets) return [];
  const text = await shown(async () => {
    const response = await assets.fetch(new Request("https://assets.invalid/CHANGELOG.md"));
    if (!response.ok) return null;
    const body = await response.text();
    return body.length > MAX_CHANGELOG_BYTES ? body.slice(0, MAX_CHANGELOG_BYTES) : body;
  });
  if (!text) return [];
  const q = p.q?.toLowerCase();
  const area = p.area?.toLowerCase();
  return parseChangelog(text).filter((e) => (!q || e.text.toLowerCase().includes(q) || e.version.toLowerCase().includes(q)) && (!area || e.area === area));
};
