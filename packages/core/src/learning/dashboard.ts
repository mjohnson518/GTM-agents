// GTM-agents: the learning module's sources for the operator dashboard: its proposals (learnings,
// brain and voice edits, template candidates), the fitness trend, and the learnings summary.
//
// Pass them to createWorker as `dashboard: learningDashboard()`. The gateway lists proposals here,
// shows each one's exact detail with a digest, and verifies the operator's shown digest against the
// proposal as it stands before calling approve with that read's own digest. Approval then runs
// through approveLearningProposal with that digest, which checks it again and claims the proposal,
// so the dashboard is never a second path around the learning module's rules.
import type { Proposal } from "../gateway/protocol.ts";
import type { DashboardExtensions, FitnessSource, LearningSource, ProposalSource } from "../gateway/wiring.ts";
import type { Env } from "../env.ts";
import { approveLearningProposal, rejectLearningProposal } from "./apply.ts";
import { fitnessTrend } from "./fitness.ts";
import { learningsText } from "./learnings.ts";
import { listLearningProposals, loadLearningProposal, toProposalView } from "./proposals.ts";

const view = (p: Parameters<typeof toProposalView>[0]): Proposal => ({ ...toProposalView(p) });

function proposalSource(env: Env): ProposalSource {
  return {
    source: "learning",
    async list() {
      return (await listLearningProposals(env.DB, { status: "pending" })).map(view);
    },
    async get(id) {
      const p = await loadLearningProposal(env.DB, id);
      return p && p.status === "pending" ? view(p) : null;
    },
    async approve(id, input) {
      // The gateway verified the operator's shown digest against the read that returned
      // input.sourceDigest. The learning module approves exactly that digest: it re-checks the row
      // still renders to it and claims the proposal by compare-and-set on it, so a row that changed
      // since is refused rather than applied.
      const outcome = await approveLearningProposal({ db: env.DB, kv: env.KV, now: input.now }, id, input.sourceDigest, input.actor);
      return { ok: outcome.status === "applied" || outcome.status === "approved", message: outcome.message };
    },
    async reject(id, input) {
      const outcome = await rejectLearningProposal({ db: env.DB, now: input.now }, id, input.actor, input.reason);
      return { ok: outcome.status !== "not_found" && outcome.status !== "failed", message: outcome.message };
    },
  };
}

/** The dashboard sources the learning module provides, for createWorker's `dashboard` option. */
export function learningDashboard<E extends Env>(): DashboardExtensions<E> {
  return {
    proposals: [(env) => proposalSource(env)],
    fitness: (env): FitnessSource => ({ trend: (days, now) => fitnessTrend(env.DB, now, days) }),
    learning: (env): LearningSource => ({ summary: async () => ({ learnings: await learningsText(env.DB) }) }),
  };
}
