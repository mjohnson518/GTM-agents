// GTM-agents: the targeting module's public surface: the Product and ICP page's draft, store and
// proposal path, suggested search queries and personas, and readiness (docs/TARGETING.md).
export {
  TARGETING_DAILY_CENTS,
  TARGETING_DRAFTS_DAILY_MAX,
  TARGETING_DRAFTS_DAILY_MAX_FLAG,
  TARGETING_DRAFT_FLAG,
  TARGETING_FLAG,
  TARGETING_JOB,
  TARGETING_SUGGESTIONS_DAILY_MAX,
  TARGETING_SUGGESTIONS_DAILY_MAX_FLAG,
  TARGETING_SUGGEST_DAILY_CENTS,
  TARGETING_SUGGEST_FLAG,
  TARGETING_SUGGEST_JOB,
  isTargetingDraftEnabled,
  isTargetingEnabled,
  isTargetingSuggestEnabled,
  targetingDraftsDailyMax,
  targetingSuggestionsDailyMax,
} from "./flags.ts";
export { DRAFT_ICP_MAX, DRAFT_PRODUCT_MAX, ICP_KINDS, PRODUCT_KINDS, SITE_COPY_WORDS, TARGETING_COMPONENTS, TARGETING_OUTPUT_SCHEMA, TARGETING_RUBRIC, copiesPage, filterDraft, parseDraftOutput } from "./draft.ts";
export type { DraftItem, DroppedItem, FilteredDraft, RawDraftOutput, TargetingComponent } from "./draft.ts";
export { SITE_EXTRA_PAGES, SITE_FIRST_PAGE_MAX_CHARS, SITE_TEXT_MAX_CHARS, SITE_TEXT_MIN_CHARS, extraPageUrls, readSite } from "./site.ts";
export type { SitePage, SiteRead } from "./site.ts";
export { DRAFT_STUCK_MS, discardDraft, draftRunning, draftsStartedOn, insertDraft, latestDraft, loadDraft, newDraftId, saveWorking } from "./store.ts";
export type { DraftPage, DraftSource, DraftStatus, TargetingDraft, WorkingCopy } from "./store.ts";
export { TARGETING_ROLE, runTargetingDraft, startTargetingDraft } from "./run.ts";
export type { DraftInput, StartResult, TargetingDeps } from "./run.ts";
export { ADDITIONS_MAX, checkAdditions, checkTargetingFile, proposeAdditions, proposeTargeting, servedTargeting } from "./propose.ts";
export type { CheckedFile, EditableComponent, ProposeResult, ServedComponent, ServedTargeting } from "./propose.ts";
export { SUGGEST_COMPONENTS, SUGGEST_OUTPUT_SCHEMA, SUGGEST_PERSONAS_MAX, SUGGEST_QUERIES_MAX, SUGGEST_RUBRIC, SUGGEST_EDITABLE_FIELDS, filterSuggestions, namesNeverEntry, parseSuggestOutput, phraseKey, picksProblem } from "./suggest.ts";
export type { DroppedSuggestion, FilteredSuggestions, RawSuggestOutput, ServedForSuggestions, SuggestComponent, SuggestedItem } from "./suggest.ts";
export { SUGGEST_STUCK_MS, discardSuggestion, latestSuggestion, loadSuggestion, newSuggestionId, saveSuggestionWorking, suggestionsStartedOn } from "./suggest-store.ts";
export type { SuggestionPicks, SuggestionSet, SuggestionStatus, TargetingSuggestion } from "./suggest-store.ts";
export { TARGETING_SUGGEST_ROLE, runTargetingSuggest, startTargetingSuggest } from "./suggest-run.ts";
export type { SuggestStartResult } from "./suggest-run.ts";
export { READINESS_COMPONENTS, targetingReadiness } from "./readiness.ts";
export type { ComponentReadiness, ReadinessComponent, TargetingReadiness } from "./readiness.ts";
