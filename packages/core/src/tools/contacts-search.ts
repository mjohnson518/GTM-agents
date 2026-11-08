// GTM-agents: the contacts_search tool: look people up in the deployment's own contact records.
//
// Its class is metadata taint, gate never. Contact records can hold text a tainted session wrote
// (titles, notes from research), so reading them back counts as reading short third-party text.
// The query is bounded: a short search string, a LIKE match with wildcards escaped, at most 20
// rows, and only the columns an operator needs to recognize a person.
import type { ToolHandler } from "../runtime/dispatcher.ts";

export const CONTACTS_SEARCH_MAX_ROWS = 20;
export const CONTACTS_SEARCH_MAX_QUERY = 100;

export const contactsSearchDefinition = {
  name: "contacts_search",
  description:
    "Search the deployment's contact records by name, email address, company domain or job title. Returns at most 20 matches with id, name, email, account, title and warmth.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Text to look for, for example a surname, an email address or a company domain." },
      limit: { type: "integer", minimum: 1, maximum: CONTACTS_SEARCH_MAX_ROWS, description: "How many matches to return (default 10)." },
    },
    required: ["query"],
    additionalProperties: false,
  },
} as const;

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

interface ContactRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  account_key: string | null;
  job_title: string | null;
  warmth: string;
}

export function createContactsSearchHandler(deps: { db: D1Database }): ToolHandler {
  return async (input) => {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (query.length < 2) throw new Error("query must be at least two characters");
    if (query.length > CONTACTS_SEARCH_MAX_QUERY) throw new Error(`query must be at most ${CONTACTS_SEARCH_MAX_QUERY} characters`);
    const requested = typeof input.limit === "number" && Number.isInteger(input.limit) ? input.limit : 10;
    const limit = Math.min(Math.max(requested, 1), CONTACTS_SEARCH_MAX_ROWS);
    const pattern = `%${escapeLike(query.toLowerCase())}%`;
    const { results } = await deps.db
      .prepare(
        `SELECT id, first_name, last_name, email, account_key, job_title, warmth FROM contacts
          WHERE email LIKE ?1 ESCAPE '\\'
             OR lower(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) LIKE ?1 ESCAPE '\\'
             OR COALESCE(account_key, '') LIKE ?1 ESCAPE '\\'
             OR lower(COALESCE(job_title, '')) LIKE ?1 ESCAPE '\\'
          ORDER BY updated_at DESC
          LIMIT ?2`,
      )
      .bind(pattern, limit)
      .all<ContactRow>();
    if (results.length === 0) return `No contacts match "${query}".`;
    const lines = results.map((r) => {
      const name = [r.first_name, r.last_name].filter(Boolean).join(" ") || "(no name)";
      return `- ${r.id}: ${name} <${r.email}>, account ${r.account_key ?? "unknown"}, title ${r.job_title ?? "unknown"}, warmth ${r.warmth}`;
    });
    return [`${results.length} contact(s) match "${query}":`, ...lines].join("\n");
  };
}
