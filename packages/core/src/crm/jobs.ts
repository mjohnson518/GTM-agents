// GTM-agents: the CRM mirror's job (docs/CRM.md).
//
//   createCrmJobs({ sink: (env) => createAttio(context(env, "crm-attio")) })
//
// registers crm_mirror, every 15 minutes behind crm:mirror_enabled (default off). It makes no model
// call and spends nothing: its ceilings are five minutes, crm:mirror_per_run rows (at most 500) and
// zero cents. The sink is built per run, so its secret is read when the job runs. The job checks the
// flag again itself (failing closed), so calling run() directly with the flag off does nothing. A
// sink error fails the run, with the cursors left where the last finished row put them.
import { defineJob, type RegisteredJob } from "../jobs/registry.ts";
import type { CrmSink } from "../ports/business.ts";
import { CRM_MIRROR_FLAG, CRM_PER_RUN, crmPerRun, isCrmMirrorEnabled } from "./flags.ts";
import { runCrmMirror } from "./mirror.ts";

export const CRM_MIRROR_JOB = "crm_mirror";
export const CRM_MIRROR_SCHEDULE = "*/15 * * * *";

/** The bindings the mirror reads. A deployment's Env satisfies it. */
export interface CrmEnv {
  DB: D1Database;
}

export interface CrmDeps<E extends CrmEnv = CrmEnv> {
  /** Build the CRM sink for one run. Return undefined when none is configured. */
  sink: (env: E) => CrmSink | undefined;
  schedule?: string;
}

export function createCrmJobs<E extends CrmEnv>(deps: CrmDeps<E>): RegisteredJob<E>[] {
  const mirror = defineJob<E>({
    name: CRM_MIRROR_JOB,
    schedule: deps.schedule ?? CRM_MIRROR_SCHEDULE,
    flag: CRM_MIRROR_FLAG,
    ceilings: { maxDurationMs: 5 * 60_000, maxRows: CRM_PER_RUN.max, maxSpendCents: 0 },
    rerunnable: true,
    async run(ctx) {
      if (!(await isCrmMirrorEnabled(ctx.flags))) return { summary: "flag off" };
      const perRun = Math.min(await crmPerRun(ctx.flags), ctx.ceilings.maxRows ?? CRM_PER_RUN.max);
      if (perRun <= 0) return { summary: "crm:mirror_per_run is 0 or unreadable; nothing mirrored", rows: 0 };
      const sink = deps.sink(ctx.env);
      if (!sink) return { summary: "no CRM sink is configured" };
      const result = await runCrmMirror({ db: ctx.env.DB, sink, now: ctx.now, perRun, signal: ctx.signal, log: ctx.log });
      const summary = `rows ${result.rows}, contacts written ${result.contacts}, activities ${result.activities}, opt-out notes ${result.optOutNotes}`;
      if (result.error) throw new Error(`the CRM sink failed (${summary}): ${result.error}`);
      return { summary, rows: result.rows };
    },
  });
  return [mirror];
}
