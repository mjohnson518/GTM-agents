// GTM-agents: test helpers for the CRM mirror: an in-memory CrmSink that records every call and can
// be told to fail, and a cursor seed so a test reads only the rows it wrote. Every value is synthetic.
import type { CrmSink } from "../ports/business.ts";
import { CRM_STREAMS } from "./mirror.ts";

export type CrmCall =
  | { kind: "account"; args: Parameters<CrmSink["upsertAccount"]>[0] }
  | { kind: "contact"; args: Parameters<CrmSink["upsertContact"]>[0] }
  | { kind: "activity"; args: Parameters<CrmSink["logActivity"]>[0] };

export interface FakeCrmSink extends CrmSink {
  calls: CrmCall[];
  /** Fail every call from now on with this error, or stop failing with null. */
  failWith(error: Error | null): void;
}

export function fakeCrmSink(name: string): FakeCrmSink {
  const calls: CrmCall[] = [];
  let failure: Error | null = null;
  const ids = new Map<string, string>();
  const idFor = (key: string) => {
    if (!ids.has(key)) ids.set(key, `rec-${ids.size + 1}`);
    return ids.get(key) as string;
  };
  return {
    name,
    calls,
    failWith(error) {
      failure = error;
    },
    upsertAccount(args) {
      if (failure) return Promise.reject(failure);
      calls.push({ kind: "account", args });
      return Promise.resolve({ externalId: idFor(`account:${args.domain}`) });
    },
    upsertContact(args) {
      if (failure) return Promise.reject(failure);
      calls.push({ kind: "contact", args });
      return Promise.resolve({ externalId: idFor(`contact:${args.email ?? args.id}`) });
    },
    logActivity(args) {
      if (failure) return Promise.reject(failure);
      calls.push({ kind: "activity", args });
      return Promise.resolve();
    },
  };
}

/** Start every stream of `sink` at `at`, so a run reads only rows changed after it. */
export async function seedCrmCursors(db: D1Database, sink: string, at: Date): Promise<void> {
  const iso = at.toISOString();
  await db.batch(
    CRM_STREAMS.map((stream) =>
      db.prepare("INSERT OR REPLACE INTO crm_sync_state (sink, stream, cursor_at, cursor_id, updated_at, created_at) VALUES (?1, ?2, ?3, '', ?3, ?3)").bind(sink, stream, iso),
    ),
  );
}
