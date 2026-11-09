// GTM-agents: the weekly self-review: rule-based proposals for the settings experiments depend on.
// No model call. Behind experiments:self_review_enabled (jobs.ts), Sundays.
//
// It proposes at most SELF_REVIEW_WEEKLY_MAX changes in any 7 days, in this order, and applies none:
//   1. a template weight, by WEIGHT_STEP: up when P(template beats the protected control) is
//      WEIGHT_UP_AT or more, down when it is WEIGHT_DOWN_AT or less, with WEIGHT_MIN_SENDS or more
//      matured sends in both (skipped while measurement health blocks reply conclusions). A weight
//      never goes below the promotion floor;
//   2. the holdout rate, doubled up to its maximum, when fewer than MIN_HELD contacts were held out
//      over the last HOLDOUT_REVIEW_DAYS;
//   3. the next signal source (the first configured source whose discovery:<source>_enabled is not
//      on) when verified runway (ready contacts over the day's cold volume) is under RUNWAY_DAYS;
//   4. the send-time test, when it is off and the last 14 days held SEND_TIME_MIN_VOLUME or more
//      first touches.
// Each proposal records the value its setting held, a prediction, and the evidence to judge it by.
// Later runs judge applied proposals once their horizon has passed (hit or miss), and every new
// proposal shows that track record. Only exp-approve-<id> applies one, and only if the setting
// still holds the value it was proposed against (proposals.ts).
import { isFlagOn } from "../jobs/loop.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import {
  DAY_MS,
  MIN_HELD,
  countSends,
  daysBefore,
  holdoutLift,
  maturedSamples,
  measurementHealth,
  metricWindow,
  probabilityBetterNormal,
  sendSlotSamples,
  unreadableHealth,
  verifiedReadyContacts,
  type MaturedSample,
} from "../metrics/index.ts";
import { HOLDOUT_RATE_DEFAULT, HOLDOUT_RATE_MAX } from "../outreach/flags.ts";
import { batchTemplates, isTargeted } from "../outreach/allocate.ts";
import type { OperatorChannel } from "../ports/operator.ts";
import { deliverOnce } from "../reports/deliver.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import type { ServedTemplate } from "../templates/store.ts";
import { EXPERIMENT_FLAGS, parseWeight, readControlTemplate, templateWeightKey } from "./flags.ts";
import { ALLOCATION_LOOKBACK_DAYS } from "./plan.ts";
import { LOSER_WEIGHT_FLOOR, createProposal, expireProposals, proposalText, proposalsSince, recordOutcome, trackRecord, type ExperimentProposal, type ProposalKind, type ProposalInput } from "./proposals.ts";
import { chooseArms } from "./thompson.ts";

export const SELF_REVIEW_WEEKLY_MAX = 3;
export const WEIGHT_STEP = 0.1;
export const WEIGHT_UP_AT = 0.9;
export const WEIGHT_DOWN_AT = 0.1;
export const WEIGHT_MIN_SENDS = 150;
export const HOLDOUT_REVIEW_DAYS = 90;
export const RUNWAY_DAYS = 30;
export const SEND_TIME_MIN_VOLUME = 300;
/** Applied proposals are judged this many days after they were applied. */
export const JUDGE_AFTER_DAYS = 28;

export const SELF_REVIEW_KINDS: readonly ProposalKind[] = Object.freeze(["template_weight", "holdout_rate", "signal_source", "send_time_experiment"]);

export interface SelfReviewDeps {
  db: D1Database;
  flags: FlagReader;
  now: Date;
  log: JobLogger;
  operator?: OperatorChannel | undefined;
  chatId?: string;
  templates: () => Promise<readonly ServedTemplate[]>;
  /** Today's cold volume (the warm-up ramp), for verified runway. Without it, no runway proposal. */
  volume?: () => Promise<number>;
  /** Signal sources in the order they should be turned on, each a discovery:<source>_enabled flag. */
  signalSources?: readonly string[];
}

export interface SelfReviewResult {
  proposed: string[];
  judged: number;
  skipped: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

async function rawFlag(flags: FlagReader, key: string): Promise<string> {
  return ((await flags.get(key)) ?? "").trim();
}

/** Candidate proposals, in priority order. Each read that fails skips that candidate. */
async function candidates(deps: SelfReviewDeps, skipped: string[]): Promise<ProposalInput[]> {
  const { db, flags, now } = deps;
  const out: ProposalInput[] = [];

  // 1. Template weights against the protected control.
  let health;
  try {
    health = await measurementHealth(db, now);
  } catch {
    health = unreadableHealth();
  }
  if (health.blocksReplyConclusions) skipped.push("template weights: measurement health blocks reply conclusions");
  else {
    try {
      const served = await deps.templates();
      const general = batchTemplates([...served]).filter((t) => !isTargeted(t));
      const { arms } = chooseArms(general.map((t) => ({ id: t.id, weight: t.meta.volume_weight })), await readControlTemplate(flags));
      const control = arms.find((a) => a.control);
      const samples = new Map<string, MaturedSample>((await maturedSamples(db, daysBefore(now, ALLOCATION_LOOKBACK_DAYS), now)).map((s) => [s.templateId, s]));
      const c = control ? samples.get(control.id) : undefined;
      for (const arm of arms.filter((a) => !a.control)) {
        const s = samples.get(arm.id);
        if (!s || !c || s.sends < WEIGHT_MIN_SENDS || c.sends < WEIGHT_MIN_SENDS) continue;
        const p = probabilityBetterNormal({ sends: s.sends, successes: s.positiveReplies }, { sends: c.sends, successes: c.positiveReplies });
        const direction = p >= WEIGHT_UP_AT ? 1 : p <= WEIGHT_DOWN_AT ? -1 : 0;
        if (direction === 0) continue;
        const key = templateWeightKey(arm.id);
        const current = await rawFlag(flags, key);
        const weight = parseWeight(current) ?? arm.weight;
        const proposed = round2(Math.max(LOSER_WEIGHT_FLOOR, weight + direction * WEIGHT_STEP));
        if (proposed === round2(weight)) continue;
        out.push({
          kind: "template_weight",
          target: key,
          current,
          proposed: String(proposed),
          reason: `P(${arm.id} beats the control ${control?.id}) is ${p.toFixed(3)} on ${s.sends} and ${c.sends} matured sends; weight ${weight} to ${proposed}.`,
          prediction: `${arm.id}'s positive reply rate stays ${direction > 0 ? "above" : "below"} the control's over the next matured sends.`,
          predictedEffect: p,
          neededSample: WEIGHT_MIN_SENDS,
          evidence: { templateId: arm.id, controlId: control?.id ?? null, direction, p },
        });
      }
    } catch (error) {
      skipped.push(`template weights: ${sanitizeErrorMessage(error)}`);
    }
  }

  // 2. The holdout.
  try {
    const lift = await holdoutLift(db, daysBefore(now, HOLDOUT_REVIEW_DAYS), now, { measureSignups: false });
    const current = await rawFlag(flags, EXPERIMENT_FLAGS.holdoutRate);
    const rate = current === "" ? HOLDOUT_RATE_DEFAULT : Number(current);
    if (lift.held.contacts < MIN_HELD && Number.isFinite(rate) && rate < HOLDOUT_RATE_MAX) {
      const proposed = round2(Math.min(HOLDOUT_RATE_MAX, Math.max(rate * 2, 0.05)));
      out.push({
        kind: "holdout_rate",
        target: EXPERIMENT_FLAGS.holdoutRate,
        current,
        proposed: String(proposed),
        reason: `only ${lift.held.contacts} contacts were held out in the last ${HOLDOUT_REVIEW_DAYS} days; lift is sufficient from ${MIN_HELD}.`,
        prediction: `at ${proposed}, at least ${MIN_HELD} contacts are held out in the ${HOLDOUT_REVIEW_DAYS} days after it applies.`,
        predictedEffect: proposed,
        neededSample: MIN_HELD,
        evidence: { held: lift.held.contacts },
      });
    }
  } catch (error) {
    skipped.push(`holdout: ${sanitizeErrorMessage(error)}`);
  }

  // 3. The next signal source.
  if (deps.volume && deps.signalSources && deps.signalSources.length > 0) {
    try {
      const volume = await deps.volume();
      const ready = await verifiedReadyContacts(db);
      const runway = volume > 0 ? ready / volume : Number.POSITIVE_INFINITY;
      if (runway < RUNWAY_DAYS) {
        for (const source of deps.signalSources) {
          if (!/^[a-z0-9-]+$/.test(source)) continue;
          const key = `discovery:${source}_enabled`;
          const current = await rawFlag(flags, key);
          if (isFlagOn(current)) continue;
          out.push({
            kind: "signal_source",
            target: key,
            current,
            proposed: "true",
            reason: `verified runway is ${runway.toFixed(1)} days (${ready} ready contacts at ${volume} a day), under ${RUNWAY_DAYS}.`,
            prediction: `ready contacts rise above ${ready} within ${JUDGE_AFTER_DAYS} days.`,
            predictedEffect: runway,
            neededSample: ready,
            evidence: { ready, volume, source },
          });
          break;
        }
      }
    } catch (error) {
      skipped.push(`signal source: ${sanitizeErrorMessage(error)}`);
    }
  }

  // 4. The send-time test.
  try {
    const current = await rawFlag(flags, EXPERIMENT_FLAGS.sendTime);
    if (!isFlagOn(current)) {
      const sends = await countSends(db, daysBefore(now, 14));
      if (sends.firstTouches >= SEND_TIME_MIN_VOLUME) {
        out.push({
          kind: "send_time_experiment",
          target: EXPERIMENT_FLAGS.sendTime,
          current,
          proposed: "true",
          reason: `${sends.firstTouches} first touches in the last 14 days: enough to fill both slots.`,
          prediction: `each slot reaches ${WEIGHT_MIN_SENDS} matured sends within 42 days.`,
          predictedEffect: null,
          neededSample: WEIGHT_MIN_SENDS,
          evidence: { firstTouches: sends.firstTouches },
        });
      }
    }
  } catch (error) {
    skipped.push(`send-time test: ${sanitizeErrorMessage(error)}`);
  }
  return out;
}

interface AppliedRow {
  id: string;
  kind: string;
  needed_sample: number | null;
  evidence: string | null;
  decided_at: string;
}

/** Judge applied proposals whose horizon has passed. Bookkeeping: failures are logged and skipped. */
async function judge(deps: SelfReviewDeps): Promise<number> {
  const { db, now } = deps;
  let rows: AppliedRow[];
  try {
    const { results } = await db
      .prepare(
        `SELECT id, kind, needed_sample, evidence, decided_at FROM experiment_proposals
          WHERE status = 'applied' AND outcome IS NULL AND decided_at < ?1 AND kind IN ('template_weight', 'holdout_rate', 'signal_source', 'send_time_experiment')
          ORDER BY decided_at ASC LIMIT 20`,
      )
      .bind(new Date(now.getTime() - JUDGE_AFTER_DAYS * DAY_MS).toISOString())
      .all<AppliedRow>();
    rows = results;
  } catch (error) {
    deps.log.warn("applied proposals could not be read for judging", { error: sanitizeErrorMessage(error) });
    return 0;
  }
  let judged = 0;
  for (const r of rows) {
    try {
      const evidence = (r.evidence ? JSON.parse(r.evidence) : {}) as Record<string, unknown>;
      const since = metricWindow(new Date(r.decided_at), now);
      let outcome: { hit: boolean; detail: string } | null = null;
      if (r.kind === "template_weight") {
        const samples = new Map((await maturedSamples(db, since, now)).map((s) => [s.templateId, s]));
        const text = (v: unknown) => (typeof v === "string" ? v : "");
        const s = samples.get(text(evidence.templateId));
        const c = samples.get(text(evidence.controlId));
        if (s && c && s.sends >= 50 && c.sends >= 50) {
          const p = probabilityBetterNormal({ sends: s.sends, successes: s.positiveReplies }, { sends: c.sends, successes: c.positiveReplies });
          outcome = { hit: Number(evidence.direction) > 0 ? p >= 0.5 : p <= 0.5, detail: `P ${p.toFixed(3)} on ${s.sends} and ${c.sends} matured sends since` };
        }
      } else if (r.kind === "holdout_rate") {
        if (now.getTime() - Date.parse(r.decided_at) >= HOLDOUT_REVIEW_DAYS * DAY_MS) {
          const lift = await holdoutLift(db, since, now, { measureSignups: false });
          outcome = { hit: lift.held.contacts >= (r.needed_sample ?? MIN_HELD), detail: `${lift.held.contacts} held since` };
        }
      } else if (r.kind === "signal_source") {
        const ready = await verifiedReadyContacts(db);
        outcome = { hit: ready > Number(evidence.ready ?? 0), detail: `${ready} ready contacts now` };
      } else if (r.kind === "send_time_experiment") {
        if (now.getTime() - Date.parse(r.decided_at) >= 42 * DAY_MS) {
          const slots = await sendSlotSamples(db, since, now);
          const need = r.needed_sample ?? WEIGHT_MIN_SENDS;
          outcome = { hit: slots.length === 2 && slots.every((s) => s.sends >= need), detail: slots.map((s) => `${s.slot} ${s.sends}`).join(", ") || "no slot sends" };
        }
      }
      if (outcome && (await recordOutcome(db, r.id, outcome.hit ? "hit" : "miss", outcome.detail, now))) judged += 1;
    } catch (error) {
      deps.log.warn("a proposal could not be judged; it is judged again next week", { proposal: r.id, error: sanitizeErrorMessage(error) });
    }
  }
  return judged;
}

/** One weekly review. Throws only when the week's proposal count cannot be read (fail closed). */
export async function runSelfReview(deps: SelfReviewDeps): Promise<SelfReviewResult> {
  const result: SelfReviewResult = { proposed: [], judged: 0, skipped: [] };
  await expireProposals(deps.db, deps.now);
  result.judged = await judge(deps);
  const already = await proposalsSince(deps.db, SELF_REVIEW_KINDS, new Date(deps.now.getTime() - 7 * DAY_MS));
  let room = Math.max(0, SELF_REVIEW_WEEKLY_MAX - already);
  if (room === 0) {
    result.skipped.push(`already ${already} proposals this week`);
    return result;
  }
  const created: ExperimentProposal[] = [];
  for (const input of await candidates(deps, result.skipped)) {
    if (room === 0) break;
    const { proposal, created: isNew } = await createProposal(deps.db, input, deps.now);
    if (!isNew) continue;
    created.push(proposal);
    room -= 1;
  }
  const track = await trackRecord(deps.db, SELF_REVIEW_KINDS).catch(() => null);
  for (const p of created) {
    result.proposed.push(p.id);
    await deliverOnce({ db: deps.db, operator: deps.operator, ...(deps.chatId ? { chatId: deps.chatId } : {}), log: deps.log }, `exp:proposal:${p.id}`, proposalText(p, track));
  }
  return result;
}
