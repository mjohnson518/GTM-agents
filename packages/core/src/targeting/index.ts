// GTM-agents: the targeting module's public surface: the Product and ICP page's draft, store and
// proposal path (docs/TARGETING.md).
export { TARGETING_DAILY_CENTS, TARGETING_DRAFTS_DAILY_MAX, TARGETING_DRAFTS_DAILY_MAX_FLAG, TARGETING_DRAFT_FLAG, TARGETING_FLAG, TARGETING_JOB, isTargetingDraftEnabled, isTargetingEnabled, targetingDraftsDailyMax } from "./flags.ts";
export { DRAFT_ICP_MAX, DRAFT_PRODUCT_MAX, ICP_KINDS, PRODUCT_KINDS, SITE_COPY_WORDS, TARGETING_COMPONENTS, TARGETING_OUTPUT_SCHEMA, TARGETING_RUBRIC, copiesPage, filterDraft, parseDraftOutput } from "./draft.ts";
export type { DraftItem, DroppedItem, FilteredDraft, RawDraftOutput, TargetingComponent } from "./draft.ts";
export { SITE_EXTRA_PAGES, SITE_FIRST_PAGE_MAX_CHARS, SITE_TEXT_MAX_CHARS, SITE_TEXT_MIN_CHARS, extraPageUrls, readSite } from "./site.ts";
export type { SitePage, SiteRead } from "./site.ts";
export { DRAFT_STUCK_MS, discardDraft, draftRunning, draftsStartedOn, insertDraft, latestDraft, loadDraft, newDraftId, saveWorking } from "./store.ts";
export type { DraftPage, DraftSource, DraftStatus, TargetingDraft, WorkingCopy } from "./store.ts";
export { TARGETING_ROLE, runTargetingDraft, startTargetingDraft } from "./run.ts";
export type { DraftInput, StartResult, TargetingDeps } from "./run.ts";
export { checkTargetingFile, proposeTargeting, servedTargeting } from "./propose.ts";
export type { CheckedFile, ProposeResult, ServedComponent, ServedTargeting } from "./propose.ts";
