// GTM-agents: account-clustered assignment: colleagues share an arm.
//
// When two people at one company get different arms, what one hears reaches the other, and both
// arms are contaminated. So the unit of assignment is the account key; a contact with no account is
// its own unit (contact:<id>). For each running experiment, in the order they started:
//   - a unit pinned in experiment_assignments keeps its arm for the life of the experiment;
//   - a new unit is considered in salted-hash order (the batch seed and the experiment id are the
//     salt, so the order is reproducible but unrelated to fit rank). Its arm is drawn from the
//     batch's seeded generator, half and half, and it enters only if that arm has room for every
//     member of the account (the contacts the account holds, against max_sample_per_arm). Without
//     room it is planned without the experiment and gets no arm credit; it is never moved to the
//     other arm, which would make arm membership depend on account size;
//   - a unit enters only when both arms' templates may be offered to every contact of the unit in
//     this batch, and never once the experiment has reached its max duration;
//   - a pinned unit's contacts get the arm's template or neither of the experiment's templates:
//     when a colleague cannot be offered the arm's template, when the arm has grown past its cap,
//     or when the experiment's copy changed since it started (frozen), they get some other template
//     or none, never the other arm's;
//   - a unit that is not enrolled but got one of the experiment's templates anyway is pinned
//     "excluded" (plan.ts), so no colleague enrolls later after hearing that copy;
//   - arms are pinned (INSERT OR IGNORE, then read back) before any draft is composed. A pin that
//     cannot be written leaves the unit without the experiment: no draft is credited to an arm
//     that was not recorded.
import type { Uniform } from "../metrics/index.ts";
import { EXPERIMENT_ARMS, type ExperimentArm } from "../metrics/index.ts";
import { inChunks, placeholders } from "../data/d1.ts";
import { hashOrder } from "./hash.ts";
import { ageDays, type ExperimentRecord } from "./store.ts";

export { hashOrder, saltedHash } from "./hash.ts";

export type AssignmentScope = "template_experiment" | "subject_test" | "send_slot";

/** A contact's unit: its account key, or contact:<id> when it has none. Pure. */
export function unitKey(row: { id: string; account_key: string | null }): string {
  return row.account_key ? row.account_key : `contact:${row.id}`;
}

/** Pinned arms for these units in these tests. Throws on a database error. */
export async function loadPins(db: D1Database, scope: AssignmentScope, testIds: readonly string[], units: readonly string[]): Promise<Map<string, Map<string, string>>> {
  const pins = new Map<string, Map<string, string>>();
  if (testIds.length === 0 || units.length === 0) return pins;
  for (const testId of testIds) {
    const byUnit = new Map<string, string>();
    for (const chunk of inChunks([...new Set(units)], { perValue: 1, reserved: 2 })) {
      const { results } = await db
        .prepare(`SELECT unit_key, arm FROM experiment_assignments WHERE scope = ?1 AND test_id = ?2 AND unit_key IN (${placeholders(chunk.length, 3)})`)
        .bind(scope, testId, ...chunk)
        .all<{ unit_key: string; arm: string }>();
      for (const r of results) byUnit.set(r.unit_key, r.arm);
    }
    pins.set(testId, byUnit);
  }
  return pins;
}

/** How many contacts each unit holds: the members an arm must have room for. Throws on a database error. */
export async function unitSizes(db: D1Database, units: readonly string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  const accounts = [...new Set(units.filter((u) => !u.startsWith("contact:")))];
  for (const u of units) if (u.startsWith("contact:")) sizes.set(u, 1);
  for (const chunk of inChunks(accounts, { perValue: 1 })) {
    const { results } = await db
      .prepare(`SELECT account_key, COUNT(*) AS n FROM contacts WHERE account_key IN (${placeholders(chunk.length)}) GROUP BY account_key`)
      .bind(...chunk)
      .all<{ account_key: string; n: number }>();
    for (const r of results) sizes.set(r.account_key, Math.max(1, Number(r.n)));
  }
  for (const u of accounts) if (!sizes.has(u)) sizes.set(u, 1);
  return sizes;
}

/** Contacts already in each arm of a template experiment (members of its pinned units). Throws on a database error. */
export async function armLoads(db: D1Database, experimentId: string): Promise<Record<ExperimentArm, number>> {
  const [accounts, contacts] = await db.batch<{ arm: string; n: number | null }>([
    db
      .prepare(
        `SELECT ea.arm AS arm, COUNT(c.id) AS n FROM experiment_assignments ea JOIN contacts c ON c.account_key = ea.unit_key
          WHERE ea.scope = 'template_experiment' AND ea.test_id = ?1 AND ea.unit_key NOT LIKE 'contact:%' GROUP BY ea.arm`,
      )
      .bind(experimentId),
    db.prepare("SELECT arm, COUNT(*) AS n FROM experiment_assignments WHERE scope = 'template_experiment' AND test_id = ?1 AND unit_key LIKE 'contact:%' GROUP BY arm").bind(experimentId),
  ]);
  const loads: Record<ExperimentArm, number> = { control: 0, treatment: 0 };
  for (const r of [...(accounts?.results ?? []), ...(contacts?.results ?? [])]) if (r.arm === "control" || r.arm === "treatment") loads[r.arm] += Number(r.n ?? 0);
  return loads;
}

export interface ExperimentUnitInput {
  unit: string;
  /** Every template id each contact of the unit in this batch may be offered, per contact. */
  eligible: ReadonlyArray<ReadonlySet<string>>;
}

export interface PlannedArm {
  experimentId: string;
  arm: ExperimentArm;
  templateId: string;
  /** True when this batch pins the unit for the first time. */
  isNew: boolean;
}

export interface AssignmentPlanInput {
  experiments: readonly ExperimentRecord[];
  /** Running experiments whose copy changed since they started: they keep their pins but enroll no one. */
  frozen?: ReadonlySet<string>;
  units: readonly ExperimentUnitInput[];
  /** Pinned arms, per experiment id, per unit ("excluded" keeps a unit out of that experiment). */
  pins: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Contacts already in each arm, per experiment id. */
  loads: ReadonlyMap<string, Record<ExperimentArm, number>>;
  sizes: ReadonlyMap<string, number>;
  seed: string;
  rng: Uniform;
  now: Date;
}

export interface AssignmentPlan {
  /** Units enrolled this batch, pinned before or new. A contact the arm template cannot be offered to gets neither template. */
  arms: Map<string, PlannedArm>;
  /**
   * Units pinned to an arm that enroll no one this batch (the experiment's copy changed, or the
   * arm is over its cap): their contacts may get neither of that experiment's templates, so no
   * colleague ever hears the other arm.
   */
  restricted: Map<string, Set<string>>;
}

/** The pin value that keeps a unit out of an experiment for good. */
export const EXCLUDED_ARM = "excluded";

const isArm = (v: string | undefined): v is ExperimentArm => v !== undefined && (EXPERIMENT_ARMS as readonly string[]).includes(v);

/** Each unit's experiment and arm, or none. Pure given the generator. */
export function planAssignments(input: AssignmentPlanInput): AssignmentPlan {
  const arms = new Map<string, PlannedArm>();
  const restricted = new Map<string, Set<string>>();
  const byUnit = new Map(input.units.map((u) => [u.unit, u]));
  const templateOf = (e: ExperimentRecord, arm: ExperimentArm) => (arm === "control" ? e.controlTemplateId : e.treatmentTemplateId) ?? "";
  const offerable = (u: ExperimentUnitInput, templateId: string) => templateId !== "" && u.eligible.length > 0 && u.eligible.every((set) => set.has(templateId));
  const restrict = (unit: string, e: ExperimentRecord) => {
    const set = restricted.get(unit) ?? new Set<string>();
    for (const t of [e.controlTemplateId, e.treatmentTemplateId]) if (t) set.add(t);
    restricted.set(unit, set);
  };

  // Pinned units first: a unit keeps its arm for the life of the experiment and belongs to one.
  const pinnedAnywhere = new Set<string>();
  const excluded = new Map<string, Set<string>>();
  for (const e of input.experiments) {
    const pins = input.pins.get(e.id);
    if (!pins) continue;
    const cap = e.maxSamplePerArm ?? 0;
    const load = input.loads.get(e.id) ?? { control: 0, treatment: 0 };
    for (const [unit, arm] of pins) {
      if (arm === EXCLUDED_ARM) {
        excluded.set(e.id, (excluded.get(e.id) ?? new Set<string>()).add(unit));
        continue;
      }
      if (!isArm(arm)) continue;
      pinnedAnywhere.add(unit);
      if (!byUnit.has(unit) || arms.has(unit)) continue;
      // Frozen, or the arm grew past its cap (accounts gained contacts): no one more enrolls, and
      // no colleague may get the other arm's template either.
      if (input.frozen?.has(e.id) || load[arm] > cap) restrict(unit, e);
      else arms.set(unit, { experimentId: e.id, arm, templateId: templateOf(e, arm), isNew: false });
    }
  }

  for (const e of input.experiments) {
    if (input.frozen?.has(e.id) || ageDays(e.startedAt, input.now) >= e.maxDurationDays) continue;
    const cap = e.maxSamplePerArm ?? 0;
    const load = { ...(input.loads.get(e.id) ?? { control: 0, treatment: 0 }) };
    const out = excluded.get(e.id);
    const candidates = input.units.filter(
      (u) => !arms.has(u.unit) && !restricted.has(u.unit) && !pinnedAnywhere.has(u.unit) && !out?.has(u.unit) && offerable(u, templateOf(e, "control")) && offerable(u, templateOf(e, "treatment")),
    );
    const ordered = hashOrder(candidates.map((u) => u.unit), `${input.seed}:${e.id}`);
    for (const unit of ordered) {
      const arm: ExperimentArm = input.rng() < 0.5 ? "control" : "treatment";
      const size = input.sizes.get(unit) ?? 1;
      if (load[arm] + size > cap) continue;
      load[arm] += size;
      arms.set(unit, { experimentId: e.id, arm, templateId: templateOf(e, arm), isNew: true });
    }
  }
  return { arms, restricted };
}

/**
 * Pin a unit's arm and return the arm on record (another run may have pinned it first), or null
 * when the pin could not be written or read. Never throws.
 */
export async function pinArm(
  db: D1Database,
  pin: { scope: AssignmentScope; testId: string; unit: string; arm: string; contactId: string | null; campaignId: string | null; seed: string; stratum: string | null },
  now: Date,
): Promise<string | null> {
  try {
    const at = now.toISOString();
    await db
      .prepare(
        `INSERT OR IGNORE INTO experiment_assignments (scope, test_id, unit_key, arm, contact_id, campaign_id, seed, stratum, assigned_at, created_at)
         SELECT ?1, ?2, ?3, ?4, (SELECT id FROM contacts WHERE id = ?5), ?6, ?7, ?8, ?9, ?9`,
      )
      .bind(pin.scope, pin.testId, pin.unit, pin.arm, pin.contactId, pin.campaignId, pin.seed, pin.stratum, at)
      .run();
    const row = await db.prepare("SELECT arm FROM experiment_assignments WHERE scope = ?1 AND test_id = ?2 AND unit_key = ?3").bind(pin.scope, pin.testId, pin.unit).first<{ arm: string }>();
    return row?.arm ?? null;
  } catch {
    return null;
  }
}
