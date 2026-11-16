// GTM-agents: the CRM mirror's public surface (docs/CRM.md).
export { CRM_MIRROR_FLAG, CRM_PER_RUN, CRM_PER_RUN_FLAG, crmPerRun, isCrmMirrorEnabled } from "./flags.ts";
export { CRM_MIRROR_JOB, CRM_MIRROR_SCHEDULE, createCrmJobs, type CrmDeps, type CrmEnv } from "./jobs.ts";
export { CRM_EFFECT, CRM_SETTLE_MS, CRM_STREAMS, REPLY_LABELS, runCrmMirror, type CrmMirrorDeps, type CrmMirrorResult, type CrmStream } from "./mirror.ts";
