// GTM-agents: source attribution for sources that are not searches.
//
// Every contact records the discovery query that found it (contacts.discovery_query_id), and
// promotion credits that query (discovery_queries.total_promoted), so conversion reports can compare
// sources. A source that is not a search (a webset, a monitor, lookalikes, coverage fill) gets its
// own discovery_queries row, inactive, so the search stage never runs it but its candidates still
// earn conversion credit. The row's id is stable per source and key, so it is written once.
import { sha256Hex } from "../shared/hash.ts";

export type AttributedSource = "webset" | "monitor" | "lookalike" | "coverage_fill";

/** The id of a non-search source's query row. */
export async function sourceQueryId(kind: AttributedSource, provider: string, key: string): Promise<string> {
  return `${kind}_${(await sha256Hex(`${kind}\n${provider}\n${key}`)).slice(0, 24)}`;
}

/** Ensure the inactive query row for a non-search source exists, and return its id. */
export async function ensureSourceQuery(db: D1Database, args: { kind: AttributedSource; provider: string; key: string; text: string; now: Date }): Promise<string> {
  const id = await sourceQueryId(args.kind, args.provider, args.key);
  await db
    .prepare(
      `INSERT OR IGNORE INTO discovery_queries (id, query, source, search_type, category, is_active, deactivated_reason, created_at)
       VALUES (?1, ?2, ?3, ?4, ?4, 0, 'not a search: an attribution row for this source', ?5)`,
    )
    .bind(id, args.text.slice(0, 500), args.provider, args.kind, args.now.toISOString())
    .run();
  return id;
}

/** Count new candidates against a source's query row. Bookkeeping: an error is dropped. */
export async function creditResults(db: D1Database, queryId: string, added: number): Promise<void> {
  if (added <= 0) return;
  try {
    await db.prepare("UPDATE discovery_queries SET total_results = total_results + ?2 WHERE id = ?1").bind(queryId, added).run();
  } catch {
    // Attribution counts are bookkeeping; the candidates are already written.
  }
}
