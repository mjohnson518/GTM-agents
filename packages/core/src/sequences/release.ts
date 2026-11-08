// GTM-agents: the follow-up release command: the operator sends waiting follow-up steps with
// `sequence-release-<id>-<code>`.
//
// In order, and nothing is sent unless every step for a draft passes:
//   1. sequences must be switched on (sequences:enabled); an unreadable flag refuses;
//   2. the manifest must exist and be a follow-up manifest (a cold batch's is released only with
//      batch-release), and the code must match. The code confirms intent and is not a secret, which
//      is why every draft is checked again;
//   3. the manifest must be at most 72 hours old; an older one is refused whole, and the next sweep
//      puts the steps still due up again;
//   4. the brain must be readable whole, so its never list applies;
//   5. every draft: it still exists, is still open, its recipient is still the contact's address,
//      and its current content hashes to the digest the manifest recorded, so a draft edited after
//      the manifest was written is refused, whoever edited it. Its sequence is still active, not
//      paused, and still waiting for exactly this step, which the send ledger confirms has not gone
//      out. Then the same checks the sweep runs: the reply check over the whole account, the account
//      rules and the contact rules (any read error refuses everything);
//   6. the drafts that pass are approved bound to that digest (a compare-and-set on their content).
//      A step that is due and can be threaded is handed to the send function with approvedDigest
//      set; a step not due yet (an out-of-office hold) or not threadable yet stays approved, and the
//      sweep sends it once it is, after running every check again.
// The reply names what was sent, waiting or refused, and why. Sending the same command twice sends
// nothing twice: each step's idempotency key is claimed by the send function.
import { checkReplyIntake } from "./intake.ts";
import type { KVReader } from "../brain/load.ts";
import type { GtmConfig } from "../config/schema.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import { readOn } from "../outreach/flags.ts";
import { SEQUENCE_RELEASE_PREFIX } from "../outreach/manifest.ts";
import { manifestForRelease, parseReleaseCommand, type ReleaseCommand } from "../outreach/release.ts";
import { recordAutonomyEvent } from "../outreach/send.ts";
import type { EmailProvider } from "../ports/email.ts";
import { draftDigest } from "../security/approval-digest.ts";
import type { SendOutreach } from "../sending/types.ts";
import { loadSourcingBrain } from "../sourcing/brain.ts";
import { checkRows } from "./checks.ts";
import { loadDraftsById, parseStepKey, type StepDraft } from "./drafts.ts";
import { SEQUENCE_FLAGS, SEQUENCE_LIMITS } from "./flags.ts";
import { keyOf, loadPriorSends, loadRows, rowKey, type DueRow } from "./rows.ts";
import { sendLine, sendSteps, type ReadyStep, type SendReport } from "./send.ts";
import { resolveMessageIds, threadFor, type LookupBudget } from "./threading.ts";

const HOUR_MS = 3_600_000;
const MAX_LISTED = 8;

/** `sequence-release-<id>-<code>` in a message, or null. Accepts an optional leading slash. */
export function parseSequenceReleaseCommand(text: string): ReleaseCommand | null {
  return parseReleaseCommand(text, SEQUENCE_RELEASE_PREFIX);
}

export interface SequenceReleaseDeps {
  db: D1Database;
  flags: FlagReader;
  /** Holds the brain, whose never list every step is checked against. */
  kv: KVReader | undefined;
  /** The send function for sequence steps (createSequenceSender). */
  send: SendOutreach;
  /** The email provider, for Message-ID lookups. */
  provider: EmailProvider | undefined;
  config: Pick<GtmConfig, "sequences">;
  /** Who released, for approved_by: for example operator:<user id>. */
  actor: string;
  now?: () => Date;
  log?: JobLogger;
}

export interface SequenceReleaseResult {
  ok: boolean;
  text: string;
  refused: Array<{ draftId: string; reason: string }>;
  /** Approved, but left for the sweep: not due yet, or not threadable yet. */
  waiting: Array<{ draftId: string; reason: string }>;
  report?: SendReport;
}

const refusal = (text: string): SequenceReleaseResult => ({ ok: false, text, refused: [], waiting: [] });

/** Release a follow-up manifest. Throws only on a database error, which the caller reports; nothing is sent then. */
export async function releaseSequenceManifest(deps: SequenceReleaseDeps, command: ReleaseCommand): Promise<SequenceReleaseResult> {
  const now = deps.now?.() ?? new Date();
  if (!(await readOn(deps.flags, SEQUENCE_FLAGS.enabled))) return refusal(`Sequences are switched off (${SEQUENCE_FLAGS.enabled}), so nothing was released.`);
  const intake = await checkReplyIntake(deps.db, deps.flags, now);
  if (!intake.ok) return refusal(`Nothing was released: ${intake.reason}. A follow-up never goes out while replies may be going unseen; send the same command again once the inbox is recording.`);
  const named = await manifestForRelease(deps.db, command, "sequence", "follow-ups");
  if (!named.ok) return refusal(named.text);
  const manifest = named.manifest;
  if (now.getTime() - Date.parse(manifest.createdAt) > SEQUENCE_LIMITS.releaseMaxAgeHours * HOUR_MS) {
    return refusal(`Follow-ups ${manifest.id} were put up more than ${SEQUENCE_LIMITS.releaseMaxAgeHours} hours ago, so nothing was released. The next sweep puts the steps still due up again with a new command.`);
  }
  const brain = await loadSourcingBrain(deps.kv);
  if (!deps.kv || brain.degraded) return refusal(`The brain could not be read whole, so its never list cannot be applied. Nothing was released from follow-ups ${manifest.id}.`);

  const ids = Object.keys(manifest.entries);
  const drafts = await loadDraftsById(deps.db, ids);
  const refused: Array<{ draftId: string; reason: string }> = [];
  const waiting: Array<{ draftId: string; reason: string }> = [];
  const parsed: Array<{ draft: StepDraft; step: number; campaignId: string; contactId: string; digest: string }> = [];
  for (const id of ids) {
    const draft = drafts.get(id);
    const key = parseStepKey(draft?.idempotency_key);
    if (!draft) refused.push({ draftId: id, reason: "the draft no longer exists" });
    else if (!key) refused.push({ draftId: id, reason: "it is not a follow-up step" });
    else if (draft.status !== "pending_approval" && draft.status !== "approved") refused.push({ draftId: id, reason: `the draft is ${draft.status}` });
    else {
      const digest = await draftDigest({ to: draft.recipient_email, subject: draft.subject, body: draft.body });
      if (digest !== manifest.entries[id]) refused.push({ draftId: id, reason: "the draft changed after it was put up for release" });
      else parsed.push({ draft, step: key.step, campaignId: key.campaignId, contactId: key.contactId, digest });
    }
  }

  const rows = new Map((await loadRows(deps.db, parsed.map((p) => ({ campaignId: p.campaignId, contactId: p.contactId })))).map((r) => [rowKey(keyOf(r)), r]));
  const live: Array<(typeof parsed)[number] & { row: DueRow & { sequence_active: number; sequence_paused_at: string | null } }> = [];
  for (const p of parsed) {
    const row = rows.get(rowKey({ campaignId: p.campaignId, contactId: p.contactId }));
    if (!row) refused.push({ draftId: p.draft.id, reason: "the sequence no longer exists" });
    else if (row.sequence_active !== 1) refused.push({ draftId: p.draft.id, reason: "the sequence ended or stopped" });
    else if (row.sequence_paused_at !== null) refused.push({ draftId: p.draft.id, reason: "the sequence is paused" });
    else if ((row.sequence_step ?? 0) + 1 !== p.step) refused.push({ draftId: p.draft.id, reason: `the sequence is no longer waiting for step ${p.step}` });
    else if (p.draft.recipient_email !== row.email) refused.push({ draftId: p.draft.id, reason: "the recipient is not the contact's address" });
    else live.push({ ...p, row });
  }

  // The sweep's checks, and the ledger.
  const checks = await checkRows(deps.db, live.map((l) => l.row), { now, never: brain.never });
  if (!checks.ok) return { ok: false, text: `Follow-ups ${manifest.id} were not released: ${checks.reason}. Nothing was sent; send the command again once it can be read.`, refused, waiting };
  const priors = await loadPriorSends(deps.db, live.map((l) => keyOf(l.row)));
  const passing: typeof live = [];
  for (const l of live) {
    const verdict = checks.verdicts.get(rowKey(keyOf(l.row)));
    const sends = priors.get(rowKey(keyOf(l.row))) ?? [];
    if (!verdict) refused.push({ draftId: l.draft.id, reason: "the step was not checked" });
    else if (verdict.kind !== "go") refused.push({ draftId: l.draft.id, reason: verdict.reason });
    else if (sends.some((s) => s.sequence_step >= l.step)) refused.push({ draftId: l.draft.id, reason: `step ${l.step} already went out` });
    else if (!sends.some((s) => s.sequence_step === 1)) refused.push({ draftId: l.draft.id, reason: "the first email is not in the send ledger, so the step cannot thread under it" });
    else passing.push(l);
  }

  // Approve, bound to the digest, then send what is due and threadable.
  const at = now.toISOString();
  const budget: LookupBudget = { remaining: SEQUENCE_LIMITS.messageIdLookups };
  const ready: ReadyStep[] = [];
  let approvedCount = 0;
  for (const l of passing) {
    const approved = await deps.db
      .prepare(
        `UPDATE drafts SET status = 'approved', approved_digest = ?2, approved_at = ?3, approved_by = ?4, updated_at = ?3
          WHERE id = ?1 AND status IN ('pending_approval', 'approved') AND recipient_email IS ?5 AND subject IS ?6 AND body IS ?7`,
      )
      .bind(l.draft.id, l.digest, at, deps.actor, l.draft.recipient_email, l.draft.subject, l.draft.body)
      .run();
    if ((approved.meta.changes ?? 0) === 0) {
      refused.push({ draftId: l.draft.id, reason: "the draft changed while it was being released" });
      continue;
    }
    approvedCount++;
    if (l.row.next_send_at && Date.parse(l.row.next_send_at) > now.getTime()) {
      waiting.push({ draftId: l.draft.id, reason: `approved; it goes when the step is due (${l.row.next_send_at})` });
      continue;
    }
    const sends = (priors.get(rowKey(keyOf(l.row))) ?? []).filter((s) => s.sequence_step < l.step);
    await resolveMessageIds(deps.db, deps.provider, sends, budget, deps.log);
    const thread = threadFor(sends);
    if (!thread) {
      waiting.push({ draftId: l.draft.id, reason: "approved; it waits for the first email's Message-ID, and the next sweep sends it" });
      continue;
    }
    const steps = deps.config.sequences.cold.steps;
    const after = steps.find((s) => s.step === l.step + 1);
    ready.push({
      row: keyOf(l.row),
      step: l.step,
      nextDelayDays: after ? after.delayDays : null,
      idempotencyKey: l.draft.idempotency_key,
      draft: { id: l.draft.id, to: l.draft.recipient_email ?? "", toName: l.draft.recipient_name, subject: l.draft.subject ?? "", body: l.draft.body ?? "", templateId: l.draft.template_id, approvedDigest: l.digest },
      thread,
    });
  }

  const report = await sendSteps({ db: deps.db, send: deps.send, now, ...(deps.log ? { log: deps.log } : {}) }, ready);
  try {
    await deps.db.prepare("UPDATE approval_manifests SET released_at = ?2, released_by = ?3 WHERE id = ?1").bind(manifest.id, at, deps.actor).run();
  } catch {
    // Bookkeeping: the release itself is recorded on each draft and in the send ledger.
  }
  // One decision per manifest: evidence is written on the first release only.
  if (approvedCount > 0 && manifest.releasedAt === null) await recordAutonomyEvent(deps.db, "approved_unchanged", manifest.id, `released ${approvedCount} of ${ids.length} follow-ups`, now);

  const lines = [`Follow-ups ${manifest.id}: ${approvedCount} of ${ids.length} released. ${sendLine(report)}.`];
  for (const p of report.paused) lines.push(`- paused: ${p.row.contactId} (step ${p.step}): ${p.reason}`);
  if (waiting.length > 0) {
    lines.push(`${waiting.length} approved and waiting:`);
    for (const w of waiting.slice(0, MAX_LISTED)) lines.push(`- ${w.draftId}: ${w.reason}`);
    if (waiting.length > MAX_LISTED) lines.push(`- and ${waiting.length - MAX_LISTED} more`);
  }
  if (refused.length > 0) {
    lines.push(`${refused.length} refused:`);
    for (const r of refused.slice(0, MAX_LISTED)) lines.push(`- ${r.draftId}: ${r.reason}`);
    if (refused.length > MAX_LISTED) lines.push(`- and ${refused.length - MAX_LISTED} more`);
  }
  return { ok: approvedCount > 0, text: lines.join("\n"), refused, waiting, report };
}
