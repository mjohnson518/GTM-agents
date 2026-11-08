// GTM-agents: the tools module's public surface: the hub agent's first three tools, their model-facing
// definitions, and handlers for the dispatcher.
//
// Each tool's security class lives in security/tool-classes.ts, not here: web_fetch is full taint
// (gate never, egress url), contacts_search is metadata (gate never), drafts_create is taint none,
// gate full. The dispatcher reads only those classes, so a definition here can never loosen a gate.
import type { ToolHandler } from "../runtime/dispatcher.ts";
import { contactsSearchDefinition, createContactsSearchHandler } from "./contacts-search.ts";
import { createDraftsCreateHandler, draftsCreateDefinition, type CreatedDraft } from "./drafts-create.ts";
import { createWebFetchHandler, webFetchDefinition, type WebFetchOptions } from "./web-fetch.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The tools the hub agent is offered, in a fixed order so the request prefix stays cacheable. */
export const HUB_TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([webFetchDefinition, contactsSearchDefinition, draftsCreateDefinition]);

export interface HubToolDeps {
  db: D1Database;
  /** The fetch web_fetch uses. Defaults to the global fetch. */
  fetch?: typeof fetch;
  webFetch?: Omit<WebFetchOptions, "fetch">;
  onDraftCreated?: (draft: CreatedDraft) => void;
  now?: () => Date;
}

export function createHubToolHandlers(deps: HubToolDeps): Record<string, ToolHandler> {
  return {
    web_fetch: createWebFetchHandler({ ...(deps.webFetch ?? {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) }),
    contacts_search: createContactsSearchHandler({ db: deps.db }),
    drafts_create: createDraftsCreateHandler({
      db: deps.db,
      ...(deps.onDraftCreated ? { onCreated: deps.onDraftCreated } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    }),
  };
}

export { CONTACTS_SEARCH_MAX_QUERY, CONTACTS_SEARCH_MAX_ROWS, contactsSearchDefinition, createContactsSearchHandler } from "./contacts-search.ts";
export { CHAT_DRAFT_KINDS, DRAFT_BODY_MAX_CHARS, DRAFT_SUBJECT_MAX_CHARS, createDraftsCreateHandler, draftsCreateDefinition, newDraftId } from "./drafts-create.ts";
export type { ChatDraftKind, CreatedDraft, DraftsCreateDeps } from "./drafts-create.ts";
export { WEB_FETCH_MAX_BYTES, WEB_FETCH_MAX_REDIRECTS, WEB_FETCH_TIMEOUT_MS, createWebFetchHandler, fetchableUrl, htmlToText, webFetchDefinition } from "./web-fetch.ts";
export type { WebFetchOptions } from "./web-fetch.ts";
