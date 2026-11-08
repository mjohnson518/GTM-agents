// GTM-agents: the release command: the operator sends a waiting cold batch with
// `batch-release-<id>-<code>`.
//
// In order, and nothing is sent unless every step for a draft passes:
//   1. the cold batch must be switched on (cold_batch:enabled); an unreadable flag refuses;
//   2. the manifest must exist. Without one, nothing is released;
//   3. the code must match the manifest's. It confirms intent and is not a secret, which is why:
//   4. every draft is re-checked (revalidateDrafts: still open and at most 14 days old, still cold,
//      not opted out, held out or suppressed, no mail from the contact since drafting, no newer send,
//      nobody at the account in a conversation, opted out or complained since, and not on the brain's
//      never list, which must be readable), and its current content must hash to the digest the
//      manifest recorded. A draft edited after the manifest was written is refused, whoever edited it;
//   5. readiness is scored again over the drafts that pass; RED refuses the release, and salvage may
//      drop suppressed recipients or accounts over the weekly cap;
//   6. the drafts that pass are marked approved with that digest (a compare-and-set on their
//      content), then handed to the send function with approvedDigest set, once each.
// The reply names what was sent, deferred, blocked or refused, and why.
import type { KVReader } from "../brain/load.ts";
import type { GtmConfig } from "../config/schema.ts";
import { loadSourcingBrain } from "../sourcing/brain.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import type { SendOutreach } from "../sending/types.ts";
import { OUTREACH_FLAGS, OUTREACH_LIMITS, readOn, readWholeNumber } from "./flags.ts";
import { readinessLine, readinessWithSalvage } from "./readiness.ts";
import { RELEASE_PREFIX, readManifest } from "./manifest.ts";
import { currentDigest, handOff, handoffLine, loadDrafts, recordAutonomyEvent, revalidateDrafts, type HandoffItem, type HandoffReport } from "./send.ts";

const RELEASE_PATTERN = new RegExp(`^/?${RELEASE_PREFIX}-([a-z0-9]{4,40})-([0-9a-f]{6})$`, "i");

export interface ReleaseCommand {
  manifestId: string;
  code: string;
}

/** The release command in a message, or null. Accepts an optional leading slash. */
export function parseReleaseCommand(text: string): ReleaseCommand | null {
  const match = RELEASE_PATTERN.exec(text.trim());
  if (!match) return null;
  return { manifestId: (match[1] ?? "").toLowerCase(), code: (match[2] ?? "").toLowerCase() };
}

export interface ReleaseDeps {
  db: D1Database;
  flags: FlagReader;
  /** Holds the brain, whose never list every released draft is checked against. */
  kv: KVReader | undefined;
  send: SendOutreach;
  config: Pick<GtmConfig, "sequences">;
  /** Who released, for approved_by: for example operator:<user id>. */
  actor: string;
  now?: () => Date;
  log?: JobLogger;
}

export interface ReleaseResult {
  ok: boolean;
  text: string;
  refused: Array<{ draftId: string; reason: string }>;
  report?: HandoffReport;
}

const MAX_LISTED = 8;

function refusal(text: string): ReleaseResult {
  return { ok: false, text, refused: [] };
}

/** Release a manifest. Throws only on a database error, which the caller reports; nothing is sent then. */
export async function releaseBatch(deps: ReleaseDeps, command: ReleaseCommand): Promise<ReleaseResult> {
  const now = deps.now?.() ?? new Date();
  if (!(await readOn(deps.flags, OUTREACH_FLAGS.enabled))) {
    return refusal(`The cold batch is switched off (${OUTREACH_FLAGS.enabled}), so nothing was released.`);
  }
  const manifest = await readManifest(deps.db, command.manifestId);
  if (!manifest) return refusal(`There is no approval manifest for batch ${command.manifestId}, so nothing was released.`);
  if (manifest.code !== command.code) return refusal(`That code does not match batch ${manifest.id}. Nothing was released. Copy the command from the batch message.`);

  const brain = await loadSourcingBrain(deps.kv);
  if (!deps.kv || brain.degraded) return refusal(`The brain could not be read whole, so its never list cannot be applied. Nothing was released from batch ${manifest.id}.`);

  const ids = Object.keys(manifest.entries);
  const drafts = await loadDrafts(deps.db, ids);
  const refused: Array<{ draftId: string; reason: string }> = [];
  const found = new Set(drafts.map((d) => d.id));
  for (const id of ids) if (!found.has(id)) refused.push({ draftId: id, reason: "the draft no longer exists" });

  const revalidation = await revalidateDrafts(deps.db, drafts, now, { never: brain.never });
  const checked: Array<{ draft: (typeof drafts)[number]; digest: string }> = [];
  for (const draft of drafts) {
    const reason = revalidation.get(draft.id);
    if (reason) {
      refused.push({ draftId: draft.id, reason });
      continue;
    }
    const expected = manifest.entries[draft.id];
    const digest = await currentDigest(draft);
    if (!expected || digest !== expected) {
      refused.push({ draftId: draft.id, reason: "the draft changed after the batch was put up for approval" });
      continue;
    }
    checked.push({ draft, digest });
  }

  const caps = {
    domainDailyCap: await readWholeNumber(deps.flags, OUTREACH_FLAGS.domainDailyCap, OUTREACH_LIMITS.domainDailyCap),
    accountWeeklyCap: await readWholeNumber(deps.flags, OUTREACH_FLAGS.accountWeeklyCap, OUTREACH_LIMITS.accountWeeklyCap),
  };
  const readiness = await readinessWithSalvage(
    deps.db,
    checked.map((c) => ({ draftId: c.draft.id, to: c.draft.recipient_email ?? "", accountKey: c.draft.account_key, subject: c.draft.subject ?? "", body: c.draft.body ?? "", c })),
    { now, ...caps },
  );
  if (checked.length > 0 && readiness.report.overall === "red") {
    return { ok: false, text: `Batch ${manifest.id} was not released: ${readinessLine(readiness.report)}. Nothing was sent; send the command again once it clears.`, refused };
  }
  for (const d of readiness.dropped) refused.push({ draftId: d.draftId, reason: "dropped by the readiness check (suppressed, or the account is over its weekly cap)" });

  const passing: HandoffItem[] = [];
  const at = now.toISOString();
  for (const { c } of readiness.items) {
    const { draft, digest } = c;
    const approved = await deps.db
      .prepare(
        `UPDATE drafts SET status = 'approved', approved_digest = ?2, approved_at = ?3, approved_by = ?4, updated_at = ?3
          WHERE id = ?1 AND status IN ('pending_approval', 'approved') AND recipient_email IS ?5 AND subject IS ?6 AND body IS ?7`,
      )
      .bind(draft.id, digest, at, deps.actor, draft.recipient_email, draft.subject, draft.body)
      .run();
    if ((approved.meta.changes ?? 0) === 0) {
      refused.push({ draftId: draft.id, reason: "the draft changed while it was being released" });
      continue;
    }
    passing.push({ draft: { ...draft, status: "approved", approved_digest: digest }, approvedDigest: digest });
  }

  const report = await handOff({ db: deps.db, send: deps.send, config: deps.config, now, ...(deps.log ? { log: deps.log } : {}) }, passing);
  try {
    await deps.db.prepare("UPDATE approval_manifests SET released_at = ?2, released_by = ?3 WHERE id = ?1").bind(manifest.id, at, deps.actor).run();
  } catch {
    // Bookkeeping: the release itself is recorded on each draft and in the send ledger.
  }
  // One decision per batch: evidence is written on the first release only.
  if (passing.length > 0 && manifest.releasedAt === null) await recordAutonomyEvent(deps.db, "approved_unchanged", manifest.campaignId, `released ${passing.length} of ${ids.length}`, now);

  const lines = [`Batch ${manifest.id}: ${passing.length} of ${ids.length} drafts released. ${handoffLine(report)}.`];
  if (refused.length > 0) {
    lines.push(`${refused.length} refused:`);
    for (const r of refused.slice(0, MAX_LISTED)) lines.push(`- ${r.draftId}: ${r.reason}`);
    if (refused.length > MAX_LISTED) lines.push(`- and ${refused.length - MAX_LISTED} more`);
  }
  return { ok: passing.length > 0, text: lines.join("\n"), refused, report };
}
