// GTM-agents: createShipPlanning(), the ship loop's planning side as one factory: the two daily
// jobs, the operator chat commands, AnnounceShipped and the path policy. docs/SHIP.md covers setup.
//
//   const planning = createShipPlanning({
//     config, repo: "acme-example/app", startBuild, readEngineeringContract,
//     model: (env) => gateway, operator: (env) => channel, send: (env) => sendOutreach,
//   });
//   createWorker(config, { jobs: [...planning.jobs], commands: planning.commands, ... });
//
// The jobs, both behind flags that default off and need ship:enabled and modules.ship.enabled:
//   ship_themes  daily 06:10 UTC  triage and embedding roles  50 rows, 50 cents a day, 10 minutes
//   ship_specs   daily 06:40 UTC  strategist role             3 specs, $1 a day, 10 minutes
// Model calls never run in a per-minute job: a schedule that fires more than four times an hour, or
// twice within 15 minutes, is refused when the factory is built. Every run leaves a run row (the job
// runner writes it) whose summary says what happened.
import type { Env } from "@gtm-agents/core";
import type { GtmConfig } from "@gtm-agents/core/config";
import { defineJob, type JobContext, type RegisteredJob } from "@gtm-agents/core/jobs";
import type { ModuleCommand } from "@gtm-agents/core/operator";
import type { ModelGateway, OperatorChannel } from "@gtm-agents/core/ports";
import { assertModelSchedule } from "@gtm-agents/core/replies";
import type { SendOutreach } from "@gtm-agents/core/sending";
import { createSpendGate } from "@gtm-agents/core/sourcing";
import type { TemplateFile } from "@gtm-agents/core/templates";
import { consoleLogger, kvFlagReader } from "@gtm-agents/core";
import { createAnnounceShipped } from "./announce.ts";
import { MAX_AUTO_APPROVALS_PER_RUN } from "./approval.ts";
import type { AnnounceShipped, EvaluatePathPolicy, StartShipBuild } from "./contract.ts";
import { DEFAULT_NOTE_TEMPLATE_ID, MAX_NOTES_PER_THEME } from "./notes.ts";
import { deniedGlobs, evaluatePathPolicy, repoAllowed } from "./path-policy.ts";
import { createShipCommands } from "./planning-commands.ts";
import { SHIP_FLAGS, shipStepOn } from "./planning-flags.ts";
import { tryBuild } from "./planning-shared.ts";
import { runShipSpecs, specsSummary } from "./spec-job.ts";
import { DEFAULT_JOIN_THRESHOLD, runShipThemes, themesSummary } from "./themes.ts";

export const SHIP_JOBS = Object.freeze({ themes: "ship_themes", specs: "ship_specs" });

export interface ShipPlanningOptions {
  schedules: { themes: string; specs: string };
  /** Daily model spend per job, in cents. */
  spendCents: { themes: number; specs: number };
  /** Feedback items triaged (and items themed) per run. */
  maxTriagePerRun: number;
  /** Cosine similarity at or above which a summary joins a theme. */
  joinThreshold: number;
  /** The theme score at or above which a spec is written. */
  specThreshold: number;
  /** Specs written per run. */
  maxSpecsPerRun: number;
  /** Low-risk specs approved automatically per run at ship_spec level 2 or above; at most 2. */
  maxAutoApprovalsPerRun: number;
  /** Notes drafted per shipped theme. */
  maxNotesPerTheme: number;
  /** The approved lifecycle template notes are written from. */
  noteTemplateId: string;
  /** Path globs added to DEFAULT_DENIED_PATHS, for the spec writer and the path policy. */
  deniedPaths: readonly string[];
  /** The chat notices go to. Defaults to the first allowlisted chat. */
  chatId?: string;
}

export const DEFAULT_SHIP_PLANNING_OPTIONS: Readonly<ShipPlanningOptions> = Object.freeze({
  schedules: { themes: "10 6 * * *", specs: "40 6 * * *" },
  spendCents: { themes: 50, specs: 100 },
  maxTriagePerRun: 50,
  joinThreshold: DEFAULT_JOIN_THRESHOLD,
  specThreshold: 6,
  maxSpecsPerRun: 3,
  maxAutoApprovalsPerRun: MAX_AUTO_APPROVALS_PER_RUN,
  maxNotesPerTheme: MAX_NOTES_PER_THEME,
  noteTemplateId: DEFAULT_NOTE_TEMPLATE_ID,
  deniedPaths: [],
});

export interface ShipPlanningDeps<E extends Env> {
  config: GtmConfig;
  /** The repository specs and tasks are for, as owner/name. */
  repo: string;
  /** The branch pull requests target. Defaults to "main". */
  baseBranch?: string;
  /** The build side: starts the durable build for a queued ship task. */
  startBuild: StartShipBuild<E>;
  /** The build side: the target repository's engineering contract text, or null when there is none. */
  readEngineeringContract: (env: E) => Promise<string | null>;
  /** The model gateway (roles triage, embedding and strategist). Without it, nothing is triaged or written. */
  model?: (env: E) => ModelGateway | undefined;
  /** The operator channel: spec notices, the shipped page and note drafts. */
  operator?: (env: E) => OperatorChannel | undefined;
  /** The shared send function notes go out through. Without it, notes are drafted and never sent. */
  send?: (env: E) => SendOutreach | undefined;
  /** Templates bundled with the Worker; without them, the approved templates in KV. */
  templates?: readonly TemplateFile[];
  options?: Partial<ShipPlanningOptions>;
}

export interface ShipPlanning<E extends Env> {
  jobs: RegisteredJob<E>[];
  commands: ModuleCommand<E>[];
  announceShipped: AnnounceShipped<E>;
  evaluatePathPolicy: EvaluatePathPolicy;
  /** The denied path globs in force: DEFAULT_DENIED_PATHS plus options.deniedPaths. */
  deniedPaths: readonly string[];
}

const positive = (n: number) => Number.isFinite(n) && n > 0;
const whole = (n: number) => Number.isInteger(n) && n > 0;

export function createShipPlanning<E extends Env>(deps: ShipPlanningDeps<E>): ShipPlanning<E> {
  const o: ShipPlanningOptions = {
    ...DEFAULT_SHIP_PLANNING_OPTIONS,
    ...(deps.options ?? {}),
    schedules: { ...DEFAULT_SHIP_PLANNING_OPTIONS.schedules, ...(deps.options?.schedules ?? {}) },
    spendCents: { ...DEFAULT_SHIP_PLANNING_OPTIONS.spendCents, ...(deps.options?.spendCents ?? {}) },
  };
  if (!repoAllowed(deps.repo, [deps.repo])) throw new Error(`ship planning: repo must be owner/name, not ${JSON.stringify(deps.repo)}`);
  if (typeof deps.startBuild !== "function" || typeof deps.readEngineeringContract !== "function") throw new Error("ship planning: startBuild and readEngineeringContract are required");
  if (!(o.joinThreshold > 0 && o.joinThreshold <= 1)) throw new Error("ship planning: joinThreshold must be above 0 and at most 1");
  if (!(Number.isFinite(o.specThreshold) && o.specThreshold >= 0)) throw new Error("ship planning: specThreshold must be zero or more");
  for (const [name, value] of Object.entries({ maxTriagePerRun: o.maxTriagePerRun, maxSpecsPerRun: o.maxSpecsPerRun, maxNotesPerTheme: o.maxNotesPerTheme })) {
    if (!whole(value)) throw new Error(`ship planning: ${name} must be a positive whole number`);
  }
  for (const [name, value] of Object.entries(o.spendCents)) if (!positive(value) || !Number.isInteger(value)) throw new Error(`ship planning: spendCents.${name} must be a positive whole number of cents`);
  assertModelSchedule(o.schedules.themes, SHIP_JOBS.themes);
  assertModelSchedule(o.schedules.specs, SHIP_JOBS.specs);
  const maxAuto = Math.max(0, Math.min(MAX_AUTO_APPROVALS_PER_RUN, Math.floor(o.maxAutoApprovalsPerRun)));
  const baseBranch = deps.baseBranch ?? "main";
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(baseBranch) || baseBranch.includes("..")) throw new Error("ship planning: baseBranch is not a branch name");
  const deniedPaths = deniedGlobs(o.deniedPaths);
  const chatOf = (config: GtmConfig) => o.chatId ?? config.operator.allowedChatIds[0];

  const off = async (ctx: JobContext<E>, flag: typeof SHIP_FLAGS.themes | typeof SHIP_FLAGS.specs): Promise<string | null> => {
    if (!ctx.config.modules.ship.enabled) return "skipped: modules.ship.enabled is off in gtm.config.ts";
    if (!(await shipStepOn(ctx.flags, flag))) return `skipped: ${SHIP_FLAGS.enabled} and ${flag} must both be on`;
    return null;
  };
  const gate = (ctx: JobContext<E>, cap: number) =>
    createSpendGate({ db: ctx.env.DB, flags: ctx.flags, job: ctx.job, ...(ctx.runId ? { runId: ctx.runId } : {}), jobCapCents: Math.min(cap, ctx.ceilings.maxSpendCents ?? cap), now: () => ctx.now, log: ctx.log });

  const jobs: RegisteredJob<E>[] = [
    defineJob<E>({
      name: SHIP_JOBS.themes,
      schedule: o.schedules.themes,
      flag: SHIP_FLAGS.themes,
      ceilings: { maxDurationMs: 600_000, maxRows: o.maxTriagePerRun, maxSpendCents: o.spendCents.themes },
      rerunnable: true,
      async run(ctx) {
        const skipped = await off(ctx, SHIP_FLAGS.themes);
        if (skipped) return { summary: skipped, rows: 0 };
        const result = await runShipThemes({
          db: ctx.env.DB,
          flags: ctx.flags,
          config: ctx.config,
          model: tryBuild(deps.model, ctx.env),
          spend: gate(ctx, o.spendCents.themes),
          repo: deps.repo,
          job: ctx.job,
          ...(ctx.runId ? { runId: ctx.runId } : {}),
          now: ctx.now,
          log: ctx.log,
          signal: ctx.signal,
          maxRows: Math.min(o.maxTriagePerRun, ctx.ceilings.maxRows ?? o.maxTriagePerRun),
          joinThreshold: o.joinThreshold,
        });
        return { summary: themesSummary(result), rows: result.triaged + result.declined + result.unusable + result.themed };
      },
    }),
    defineJob<E>({
      name: SHIP_JOBS.specs,
      schedule: o.schedules.specs,
      flag: SHIP_FLAGS.specs,
      ceilings: { maxDurationMs: 600_000, maxRows: o.maxSpecsPerRun, maxSpendCents: o.spendCents.specs },
      async run(ctx) {
        const skipped = await off(ctx, SHIP_FLAGS.specs);
        if (skipped) return { summary: skipped, rows: 0 };
        const result = await runShipSpecs({
          env: ctx.env,
          db: ctx.env.DB,
          flags: ctx.flags,
          config: ctx.config,
          model: tryBuild(deps.model, ctx.env),
          spend: gate(ctx, o.spendCents.specs),
          operator: tryBuild(deps.operator, ctx.env),
          chatId: chatOf(ctx.config),
          readEngineeringContract: deps.readEngineeringContract,
          startBuild: deps.startBuild,
          repo: deps.repo,
          baseBranch,
          deniedPaths,
          threshold: o.specThreshold,
          maxSpecs: Math.min(o.maxSpecsPerRun, ctx.ceilings.maxRows ?? o.maxSpecsPerRun),
          maxAutoApprovals: maxAuto,
          job: ctx.job,
          ...(ctx.runId ? { runId: ctx.runId } : {}),
          now: ctx.now,
          log: ctx.log,
          signal: ctx.signal,
        });
        return { summary: specsSummary(result), rows: result.ready + result.declined + result.unusable + result.autoApproved };
      },
    }),
  ];

  const log = consoleLogger({ service: "gtm-agents", scope: "ship" });
  const commands: ModuleCommand<E>[] = [
    createShipCommands<E>({ config: deps.config, startBuild: deps.startBuild, send: deps.send, baseBranch, repo: deps.repo, log }),
  ];
  const announceShipped = createAnnounceShipped<E>({
    config: deps.config,
    flags: (env) => kvFlagReader(env.KV),
    operator: (env) => tryBuild(deps.operator, env),
    send: (env) => tryBuild(deps.send, env),
    templates: deps.templates,
    templateId: o.noteTemplateId,
    maxNotes: o.maxNotesPerTheme,
    chatId: chatOf(deps.config),
    log,
  });
  return { jobs, commands, announceShipped, evaluatePathPolicy, deniedPaths };
}
