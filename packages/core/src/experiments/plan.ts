// GTM-agents: the cold batch's allocation plan: which template, subject line and send slot each
// contact gets, decided and pinned before any draft is composed.
//
// The cold batch calls planAllocation once per run with the contacts it will write to, then
// composes each one with rotationFor(row). In order:
//   1. template experiments (experiments:enabled): running experiments enroll units by account
//      (assignment.ts) and their contacts get the arm's template, credited on the ledger;
//   2. allocation (outreach:allocation_mode): thompson splits contacts who may only get general
//      templates by Thompson sampling with guardrails (thompson.ts), cell by cell, once every arm
//      is ready; before that, and in weighted mode, the weighted rotation by volume_weight decides,
//      exactly as without experiments. Contacts a targeted template matches keep segment routing;
//   3. subject tests (experiments:enabled): the chosen template's running test picks the subject
//      line (subject.ts); a concluded test's approved winner replaces the template's subject;
//   4. the send-time test (outreach:send_time_experiment): a slot per account within its time zone
//      (send-time.ts).
// Every random choice draws from one generator seeded with the batch seed (recorded on the
// campaign) plus ":allocation", so a batch can be replayed. Anything that cannot be read falls back
// to the weighted rotation and plans no experiment: no draft is credited to an arm or a variant
// that was not pinned first.
import type { GtmConfig } from "../config/schema.ts";
import { inChunks, placeholders } from "../data/d1.ts";
import type { FlagReader, JobLogger } from "../jobs/registry.ts";
import { daysBefore, shuffled, subjectVariantSamples, systematicCounts, templateCellSamples, type ExperimentArm } from "../metrics/index.ts";
import { createRotation, eligibleTemplates, isTargeted, type Rotation } from "../outreach/allocate.ts";
import { seededRng } from "../outreach/holdout.ts";
import type { SelectionRow } from "../outreach/select.ts";
import { sanitizeErrorMessage } from "../security/sanitize.ts";
import { recipientTimezone } from "../sending/timezone.ts";
import { nextAllowedTime, windowForPath } from "../sending/window.ts";
import type { ServedTemplate } from "../templates/store.ts";
import { EXCLUDED_ARM, armLoads, hashOrder, loadPins, pinArm, planAssignments, unitKey, unitSizes } from "./assignment.ts";
import { EXPERIMENT_FLAGS, readAllocation, readControlTemplate, readSwitch, readWeightOverride, type AllocationMode } from "./flags.ts";
import { SEND_TIME_TEST_ID, planSlots, slotWindow, slotsFitWindow, type SendSlot } from "./send-time.ts";
import { ageDays, copyChanged, runningExperiments, type ExperimentRecord } from "./store.ts";
import { activeSubjectTests, dealVariants, variantShares, type SubjectTest } from "./subject.ts";
import { buildCellTable, chooseArms, decideCell, thompsonReady, thompsonShares } from "./thompson.ts";

/** How far back Thompson allocation reads matured samples. */
export const ALLOCATION_LOOKBACK_DAYS = 180;

export interface PlanInput {
  db: D1Database;
  flags: FlagReader;
  now: Date;
  /** The batch seed, recorded on the campaign. */
  seed: string;
  campaignId: string;
  rows: readonly SelectionRow[];
  /** The templates the batch allocates among (outreach/allocate.ts batchTemplates). */
  templates: readonly ServedTemplate[];
  sending: Pick<GtmConfig["sending"], "windowDays" | "windowHours">;
  log: JobLogger;
}

export interface AllocationPlan {
  mode: AllocationMode;
  /** Lines for the operator's batch message. */
  lines: string[];
  /** The rotation to compose this contact with: it offers exactly the planned template. */
  rotationFor(row: SelectionRow): Rotation;
  experimentFor(contactId: string): { experimentId: string; arm: ExperimentArm } | undefined;
  /** Record the variants and slots against the stored drafts. Bookkeeping: never throws. */
  record(drafts: ReadonlyArray<{ contactId: string; draftId: string }>): Promise<void>;
}

interface Chosen {
  template: ServedTemplate | null;
  experiment?: { experimentId: string; arm: ExperimentArm };
  subject?: { testId: string; variantId: string };
  slot?: { slot: SendSlot; timezone: string; scheduledAt: string };
}

/**
 * The template of each account's latest cold first touch, sent or waiting, so Thompson allocation
 * keeps colleagues on one template. Throws on a database error.
 */
async function lastColdTemplates(db: D1Database, accountKeys: readonly string[]): Promise<Map<string, string>> {
  const latest = new Map<string, { template: string; at: string }>();
  for (const chunk of inChunks([...new Set(accountKeys)], { perValue: 1 })) {
    const list = placeholders(chunk.length);
    const { results } = await db
      .prepare(
        `SELECT os.account_key AS k, os.template_id AS t, os.sent_at AS at FROM outreach_sends os
          WHERE os.account_key IN (${list}) AND os.send_path = 'cold' AND os.sequence_step = 1 AND os.template_id IS NOT NULL
         UNION ALL
         SELECT c.account_key AS k, d.template_id AS t, d.created_at AS at FROM drafts d JOIN contacts c ON c.id = d.contact_id
          WHERE c.account_key IN (${list}) AND d.kind = 'cold_intro' AND d.status IN ('pending_approval', 'approved') AND d.template_id IS NOT NULL`,
      )
      .bind(...chunk)
      .all<{ k: string; t: string; at: string }>();
    for (const r of results) {
      const seen = latest.get(r.k);
      if (!seen || r.at > seen.at) latest.set(r.k, { template: r.t, at: r.at });
    }
  }
  return new Map([...latest].map(([k, v]) => [k, v.template]));
}

/** A rotation that offers one planned template, when the contact may get it. */
function fixedRotation(template: ServedTemplate | null): Rotation {
  const counts = new Map<string, number>();
  return {
    counts,
    pick(eligible) {
      if (!template || !eligible.some((t) => t.id === template.id)) return null;
      counts.set(template.id, (counts.get(template.id) ?? 0) + 1);
      return template;
    },
  };
}

export async function planAllocation(input: PlanInput): Promise<AllocationPlan> {
  const { db, flags, now, rows, templates, log } = input;
  const rng = seededRng(`${input.seed}:allocation`);
  const lines: string[] = [];
  const chosen = new Map<string, Chosen>();
  const eligibleOf = new Map(rows.map((r) => [r.id, eligibleTemplates(templates, { segment: r.segment, teamSize: r.team_size, persona: r.persona })]));
  const byId = new Map(templates.map((t) => [t.id, t]));
  const experimentsOn = await readSwitch(flags, EXPERIMENT_FLAGS.enabled);
  const allocation = await readAllocation(flags);

  // 1. Template experiments.
  const unitRows = new Map<string, SelectionRow[]>();
  for (const r of rows) unitRows.set(unitKey(r), [...(unitRows.get(unitKey(r)) ?? []), r]);
  // Templates a contact may not get: the other arm of an experiment its account is pinned to.
  const restrictedRows = new Map<string, Set<string>>();
  const restrict = (rowId: string, ids: Iterable<string | null>) => {
    const set = restrictedRows.get(rowId) ?? new Set<string>();
    for (const id of ids) if (id) set.add(id);
    restrictedRows.set(rowId, set);
  };
  let enrolling: ExperimentRecord[] = [];
  let experimentPins = new Map<string, Map<string, string>>();
  if (experimentsOn) {
    let running: ExperimentRecord[] = [];
    try {
      running = await runningExperiments(db);
      const frozen = new Set<string>();
      for (const e of running) {
        const missing = !byId.has(e.controlTemplateId ?? "") || !byId.has(e.treatmentTemplateId ?? "") ? "a template is not among the batch's active templates" : null;
        const why = copyChanged(e, byId) ?? missing;
        if (!why) continue;
        frozen.add(e.id);
        lines.push(`Experiment ${e.id} (${e.name}) enrolls no one: ${why}.`);
      }
      if (running.length > 0) {
        const units = [...unitRows.keys()];
        experimentPins = await loadPins(db, "template_experiment", running.map((e) => e.id), units);
        const loads = new Map<string, Record<ExperimentArm, number>>();
        for (const e of running) loads.set(e.id, await armLoads(db, e.id));
        const sizes = await unitSizes(db, units);
        const planned = planAssignments({
          experiments: running,
          frozen,
          units: units.map((u) => ({ unit: u, eligible: (unitRows.get(u) ?? []).map((r) => new Set((eligibleOf.get(r.id) ?? []).map((t) => t.id))) })),
          pins: experimentPins,
          loads,
          sizes,
          seed: input.seed,
          rng,
          now,
        });
        for (const [unit, ids] of planned.restricted) for (const r of unitRows.get(unit) ?? []) restrict(r.id, ids);
        const counts = new Map<string, { control: number; treatment: number; skipped: number }>();
        for (const e of running) counts.set(e.id, { control: 0, treatment: 0, skipped: 0 });
        for (const [unit, plan] of planned.arms) {
          const e = running.find((x) => x.id === plan.experimentId);
          if (!e) continue;
          let arm: string | null = plan.arm;
          if (plan.isNew) {
            const first = unitRows.get(unit)?.[0];
            arm = await pinArm(db, { scope: "template_experiment", testId: e.id, unit, arm: plan.arm, contactId: first?.id ?? null, campaignId: input.campaignId, seed: input.seed, stratum: null }, now);
          }
          if (arm !== "control" && arm !== "treatment") {
            // Not recorded (or recorded as excluded by another run): no arm credit, and neither arm's copy.
            for (const r of unitRows.get(unit) ?? []) restrict(r.id, [e.controlTemplateId, e.treatmentTemplateId]);
            const c = counts.get(e.id);
            if (c) c.skipped += 1;
            continue;
          }
          const templateId = (arm === "control" ? e.controlTemplateId : e.treatmentTemplateId) ?? "";
          for (const r of unitRows.get(unit) ?? []) {
            // A colleague the arm's template cannot be offered to gets neither arm's template.
            if (!(eligibleOf.get(r.id) ?? []).some((t) => t.id === templateId)) {
              restrict(r.id, [e.controlTemplateId, e.treatmentTemplateId]);
              continue;
            }
            chosen.set(r.id, { template: byId.get(templateId) ?? null, experiment: { experimentId: e.id, arm } });
            const c = counts.get(e.id);
            if (c) c[arm] += 1;
          }
        }
        enrolling = running.filter((e) => !frozen.has(e.id) && ageDays(e.startedAt, now) < e.maxDurationDays);
        for (const e of running) {
          if (frozen.has(e.id)) continue;
          const c = counts.get(e.id) ?? { control: 0, treatment: 0, skipped: 0 };
          lines.push(`Experiment ${e.id} (${e.name}): control ${c.control}, treatment ${c.treatment}${c.skipped ? `; ${c.skipped} account(s) not pinned` : ""}.`);
        }
      }
    } catch (error) {
      // Without the assignments, no one is enrolled, and no one gets an experiment's copy outside it.
      chosen.clear();
      restrictedRows.clear();
      enrolling = [];
      for (const r of rows) for (const e of running) restrict(r.id, [e.controlTemplateId, e.treatmentTemplateId]);
      log.warn("experiment assignments could not be read; this batch enrolls no one", { error: sanitizeErrorMessage(error) });
      lines.push("Experiments: assignments could not be read, so this batch enrolled no one and sends no experiment template.");
    }
  }
  const eligibleFor = (r: SelectionRow) => {
    const blocked = restrictedRows.get(r.id);
    const all = eligibleOf.get(r.id) ?? [];
    return blocked ? all.filter((t) => !blocked.has(t.id)) : all;
  };

  // 2. Allocation.
  const shared = createRotation();
  let mode: AllocationMode = "weighted";
  if (allocation.mode === "thompson") {
    try {
      const general = templates.filter((t) => !isTargeted(t));
      const { arms, dropped } = chooseArms(general.map((t) => ({ id: t.id, weight: t.meta.volume_weight })), await readControlTemplate(flags));
      const pool = rows.filter((r) => !chosen.has(r.id) && !restrictedRows.has(r.id) && !(eligibleOf.get(r.id) ?? []).some((t) => isTargeted(t)));
      const table = buildCellTable(await templateCellSamples(db, daysBefore(now, ALLOCATION_LOOKBACK_DAYS), now));
      if (thompsonReady(table, arms)) {
        mode = "thompson";
        const armIds = new Set(arms.map((a) => a.id));
        const totals = new Map(arms.map((a) => [a.id, 0]));
        // Colleagues stay together: an account that already got a general arm keeps it.
        const sticky = await lastColdTemplates(db, pool.map((r) => r.account_key).filter((k): k is string => k !== null));
        const groups = new Map<string, { decision: ReturnType<typeof decideCell>; rows: SelectionRow[] }>();
        for (const r of pool) {
          const kept = r.account_key ? sticky.get(r.account_key) : undefined;
          if (kept && armIds.has(kept)) {
            chosen.set(r.id, { template: byId.get(kept) ?? null });
            totals.set(kept, (totals.get(kept) ?? 0) + 1);
            continue;
          }
          const decision = decideCell(table, arms, { segment: r.segment, teamSize: r.team_size, persona: r.persona });
          const key = decision.cell ?? "(pooled)";
          const g = groups.get(key) ?? { decision, rows: [] };
          g.rows.push(r);
          groups.set(key, g);
        }
        for (const key of [...groups.keys()].sort()) {
          const g = groups.get(key);
          if (!g) continue;
          const shares = thompsonShares(g.decision, arms, rng);
          const counts = systematicCounts(shares, g.rows.length, rng);
          const labels: string[] = [];
          counts.forEach((c, i) => {
            for (let k = 0; k < c; k++) labels.push(arms[i]?.id ?? "");
          });
          const dealt = shuffled(labels, rng);
          g.rows.forEach((r, i) => {
            const id = dealt[i] ?? "";
            chosen.set(r.id, { template: byId.get(id) ?? null });
            totals.set(id, (totals.get(id) ?? 0) + 1);
          });
        }
        lines.push(
          `Allocation: Thompson sampling, control ${arms[0]?.id ?? "(none)"}: ${arms.map((a) => `${a.id} ${totals.get(a.id) ?? 0}`).join(", ")}${dropped.length ? `; not offered (more than 4 arms): ${dropped.join(", ")}` : ""}. Seed ${input.seed}:allocation.`,
        );
      } else {
        lines.push(`Allocation: thompson is on, but not every arm has 50 matured sends yet, so volume weights decide.`);
      }
    } catch (error) {
      for (const r of rows) if (!chosen.get(r.id)?.experiment) chosen.delete(r.id);
      log.warn("Thompson samples could not be read; weighted rotation used", { error: sanitizeErrorMessage(error) });
      lines.push("Allocation: matured samples could not be read, so weighted rotation by volume_weight decides.");
    }
  }
  if (allocation.mode !== "thompson") {
    lines.push(`Allocation: weighted rotation by volume_weight${allocation.requested !== "weighted" ? ` (${EXPERIMENT_FLAGS.allocationMode} is "${allocation.requested}", which is not a mode; weighted is used)` : ""}.`);
  }
  for (const r of rows) if (!chosen.has(r.id)) chosen.set(r.id, { template: shared.pick(eligibleFor(r)) });

  // An account that got an experiment's template without being enrolled is kept out of that
  // experiment for good, so no colleague enrolls later after hearing that copy.
  for (const e of enrolling) {
    const pins = experimentPins.get(e.id) ?? new Map<string, string>();
    const ids = new Set([e.controlTemplateId, e.treatmentTemplateId]);
    for (const [unit, members] of unitRows) {
      if (pins.has(unit) || members.some((r) => chosen.get(r.id)?.experiment?.experimentId === e.id)) continue;
      if (!members.some((r) => ids.has(chosen.get(r.id)?.template?.id ?? null))) continue;
      const pinned = await pinArm(db, { scope: "template_experiment", testId: e.id, unit, arm: EXCLUDED_ARM, contactId: members[0]?.id ?? null, campaignId: input.campaignId, seed: input.seed, stratum: null }, now);
      if (pinned === null) log.warn("an account could not be kept out of an experiment it heard copy from", { experiment: e.id });
    }
  }

  // 3. Subject tests. Enrolled contacts always get the experiment's copy exactly as started.
  try {
    const tests = await activeSubjectTests(db);
    const winners = new Map<string, SubjectTest>();
    const running = new Map<string, SubjectTest>();
    for (const t of tests) (t.status === "running" ? running : winners).set(t.templateId, t);
    const testLines: string[] = [];
    if (experimentsOn) {
      for (const [templateId, test] of running) {
        const testRows = rows.filter((r) => chosen.get(r.id)?.template?.id === templateId && !chosen.get(r.id)?.experiment);
        if (testRows.length === 0) continue;
        const testUnits = new Map<string, SelectionRow[]>();
        for (const r of testRows) testUnits.set(unitKey(r), [...(testUnits.get(unitKey(r)) ?? []), r]);
        const pins = (await loadPins(db, "subject_test", [test.id], [...testUnits.keys()])).get(test.id) ?? new Map<string, string>();
        const samples = await subjectVariantSamples(db, test.id, now);
        const { shares, phase } = variantShares(test.variants, new Map(samples.variants.map((v) => [v.variantId, v])), rng);
        const fresh = hashOrder([...testUnits.keys()].filter((u) => !pins.has(u)), `${input.seed}:${test.id}`);
        const dealt = dealVariants(test.variants, shares, fresh.length, rng);
        const assigned = new Map<string, string>(pins);
        for (let i = 0; i < fresh.length; i++) {
          const unit = fresh[i] ?? "";
          const first = testUnits.get(unit)?.[0];
          const arm = await pinArm(db, { scope: "subject_test", testId: test.id, unit, arm: dealt[i] ?? "", contactId: first?.id ?? null, campaignId: input.campaignId, seed: input.seed, stratum: null }, now);
          if (arm) assigned.set(unit, arm);
        }
        const per = new Map<string, number>();
        for (const [unit, variantId] of assigned) {
          const variant = test.variants.find((v) => v.id === variantId);
          if (!variant) continue;
          for (const r of testUnits.get(unit) ?? []) {
            const c = chosen.get(r.id);
            if (!c?.template) continue;
            chosen.set(r.id, { ...c, template: { ...c.template, subject: variant.text }, subject: { testId: test.id, variantId } });
            per.set(variantId, (per.get(variantId) ?? 0) + 1);
          }
        }
        testLines.push(`${test.id} on ${templateId} (${phase}): ${test.variants.map((v) => `${v.id} ${per.get(v.id) ?? 0}`).join(", ")}`);
      }
    }
    // An approved winner is the template's subject from then on, whatever the experiments switch says.
    for (const [templateId, test] of winners) {
      if (running.has(templateId)) continue;
      const winner = test.variants.find((v) => v.id === test.winnerVariantId);
      if (!winner) continue;
      for (const r of rows) {
        const c = chosen.get(r.id);
        if (c?.template?.id === templateId && !c.subject && !c.experiment) chosen.set(r.id, { ...c, template: { ...c.template, subject: winner.text } });
      }
    }
    if (testLines.length > 0) lines.push(`Subject tests: ${testLines.join("; ")}.`);
  } catch (error) {
    // Undo any variant this run planned: an unrecorded variant would be measured as the template.
    for (const [id, c] of chosen) if (c.subject && c.template) chosen.set(id, { template: byId.get(c.template.id) ?? null, ...(c.experiment ? { experiment: c.experiment } : {}) });
    log.warn("subject tests could not be read; this batch uses each template's own subject", { error: sanitizeErrorMessage(error) });
    lines.push("Subject tests: could not be read, so every template keeps its own subject line.");
  }

  // 4. The send-time test.
  const coldWindow = windowForPath("cold", input.sending);
  if ((await readSwitch(flags, EXPERIMENT_FLAGS.sendTime)) && !(coldWindow && slotsFitWindow(coldWindow))) {
    lines.push("Send-time test: the configured send window does not hold both slots (08:00 to 10:00 and 13:00 to 15:00), so no slot is planned.");
  } else if (await readSwitch(flags, EXPERIMENT_FLAGS.sendTime)) {
    try {
      const window = coldWindow;
      const zones = new Map<string, string>();
      for (const chunk of inChunks(rows.map((r) => r.id), { perValue: 1 })) {
        const { results } = await db.prepare(`SELECT id, timezone, location FROM contacts WHERE id IN (${placeholders(chunk.length)})`).bind(...chunk).all<{ id: string; timezone: string | null; location: string | null }>();
        for (const c of results) zones.set(c.id, recipientTimezone(c).timezone);
      }
      const units = rows.map((r) => ({ unit: unitKey(r), timezone: zones.get(r.id) ?? recipientTimezone(null).timezone }));
      const pins = (await loadPins(db, "send_slot", [SEND_TIME_TEST_ID], units.map((u) => u.unit))).get(SEND_TIME_TEST_ID) ?? new Map<string, string>();
      const slots = planSlots(units, pins, input.seed, rng);
      const tally = { early: 0, afternoon: 0 };
      for (const r of rows) {
        const unit = unitKey(r);
        const planned = slots.get(unit);
        if (!planned || !window) continue;
        let slot: string | null = planned.slot;
        if (planned.isNew) {
          slot = await pinArm(db, { scope: "send_slot", testId: SEND_TIME_TEST_ID, unit, arm: planned.slot, contactId: r.id, campaignId: input.campaignId, seed: input.seed, stratum: planned.timezone }, now);
          if (slot) pins.set(unit, slot);
        }
        if (slot !== "early" && slot !== "afternoon") continue;
        const c = chosen.get(r.id);
        if (!c) continue;
        const scheduledAt = nextAllowedTime(now, planned.timezone, slotWindow(window, slot)).toISOString();
        chosen.set(r.id, { ...c, slot: { slot, timezone: planned.timezone, scheduledAt } });
        tally[slot] += 1;
      }
      lines.push(`Send-time test: early ${tally.early}, afternoon ${tally.afternoon}.`);
    } catch (error) {
      for (const [id, c] of chosen) if (c.slot) chosen.set(id, { template: c.template, ...(c.experiment ? { experiment: c.experiment } : {}), ...(c.subject ? { subject: c.subject } : {}) });
      log.warn("the send-time test could not be planned; this batch sends in the usual window", { error: sanitizeErrorMessage(error) });
      lines.push("Send-time test: could not be planned, so this batch sends in the usual window.");
    }
  }

  return {
    mode,
    lines,
    rotationFor: (row) => fixedRotation(chosen.get(row.id)?.template ?? null),
    experimentFor: (contactId) => chosen.get(contactId)?.experiment,
    async record(drafts) {
      const at = now.toISOString();
      const statements: D1PreparedStatement[] = [];
      for (const d of drafts) {
        const c = chosen.get(d.contactId);
        if (c?.subject) {
          statements.push(
            db
              .prepare("INSERT INTO subject_assignments (id, test_id, variant_id, contact_id, campaign_id, draft_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
              .bind(`sa_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`, c.subject.testId, c.subject.variantId, d.contactId, input.campaignId, d.draftId, at),
          );
        }
        if (c?.slot) {
          statements.push(
            db
              .prepare("INSERT OR IGNORE INTO send_slot_schedules (draft_id, contact_id, slot, timezone, scheduled_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
              .bind(d.draftId, d.contactId, c.slot.slot, c.slot.timezone, c.slot.scheduledAt, at),
          );
        }
      }
      for (let i = 0; i < statements.length; i += 50) {
        try {
          await db.batch(statements.slice(i, i + 50));
        } catch (error) {
          log.warn("subject variants or send slots could not be recorded; those drafts are measured without them", { error: sanitizeErrorMessage(error) });
        }
      }
    },
  };
}

/**
 * The templates with any approved weight override (experiments:template_weight:<template>) in place
 * of the file's volume_weight. An override that is unset, unreadable or malformed leaves the file's
 * weight.
 */
export async function withWeightOverrides(templates: readonly ServedTemplate[], flags: FlagReader): Promise<ServedTemplate[]> {
  const out: ServedTemplate[] = [];
  for (const t of templates) {
    const weight = await readWeightOverride(flags, t.id);
    out.push(weight === null ? t : { ...t, meta: { ...t.meta, volume_weight: weight } });
  }
  return out;
}
