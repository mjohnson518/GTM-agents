// GTM-agents: proposals in the dashboard, dispatched by source.
//
// Each source keeps its own rules; the dashboard is never a second path around them:
//   - autonomy: level proposals (autonomy/proposals.ts). Approving is the second step,
//     confirmProposal, with the confirm code shown with the record; it re-checks the class's level,
//     its latest change, incidents and the permanently human-only cap. They are not rejected: one
//     that is not confirmed expires;
//   - experiment: setting and copy proposals (experiments/proposals.ts), applied by approveProposal
//     under its locks, only while the setting still holds the value proposed against;
//   - learning: proposals from the self-improvement module when it is installed (a ProposalSource
//     given to createWorker's `dashboard.proposals`); without it, pending rows are listed read-only.
// A proposal's id in the dashboard is "<source>:<id>". Its digest covers the source, the id and the
// exact detail text; approving re-reads the proposal and refuses when the digest no longer matches.
import { confirmProposal, loadProposal as loadAutonomyProposal, openProposals, type Proposal as AutonomyProposal } from "../autonomy/proposals.ts";
import { servedTemplates } from "../experiments/jobs.ts";
import { approveProposal, loadProposal as loadExperimentProposal, pendingProposals, rejectProposal, type ExperimentProposal } from "../experiments/proposals.ts";
import { constantTimeEqual } from "../http/auth.ts";
import { canonicalJson } from "../security/approval-digest.ts";
import { sha256Hex } from "../shared/hash.ts";
import { RpcError, type GatewayContext, type Handler } from "./context.ts";
import type { Proposal } from "./protocol.ts";
import { tryBuild, type ProposalSource } from "./wiring.ts";

export async function proposalDigest(source: string, id: string, detail: string): Promise<string> {
  return sha256Hex(canonicalJson({ kind: "proposal", v: 1, source, id, detail }));
}

async function withDigest(p: Omit<Proposal, "digest">): Promise<Proposal> {
  return { ...p, digest: await proposalDigest(p.source, p.id, p.detail) };
}

function autonomyView(p: AutonomyProposal): Promise<Proposal> {
  const by = p.origin === "review" ? "the weekly autonomy review" : `${p.requestedBy ?? "the operator"}`;
  return withDigest({
    id: p.id,
    source: "autonomy",
    title: `${p.actionClass}: level ${p.from} to ${p.to}`,
    detail: `Set ${p.actionClass} from level ${p.from} to level ${p.to}. Proposed by ${by}. It applies only if ${p.actionClass} is still at level ${p.from} with no change or incident since.`,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    confirmCode: p.code,
  });
}

function experimentView(p: ExperimentProposal): Promise<Proposal> {
  return withDigest({
    id: p.id,
    source: "experiment",
    title: `${p.kind.replace(/_/g, " ")}: ${p.target}`,
    detail: [`${p.kind.replace(/_/g, " ")}: ${p.target} from ${p.current === "" ? "unset" : p.current} to ${p.proposed}.`, `Why: ${p.reason}`, `Prediction: ${p.prediction}`].join("\n"),
    createdAt: p.createdAt,
  });
}

function autonomySource(ctx: GatewayContext): ProposalSource {
  const db = ctx.env.DB;
  return {
    source: "autonomy",
    list: async (now) => Promise.all((await openProposals(db, now)).map(autonomyView)),
    get: async (id) => {
      const p = await loadAutonomyProposal(db, id);
      return p ? autonomyView(p) : null;
    },
    approve: async (id, input) => {
      if (!input.confirmCode) return { ok: false, message: "an autonomy proposal is applied with its confirm code" };
      const result = await confirmProposal({ db, kv: ctx.env.KV, flags: ctx.flags, config: ctx.wiring.config, userId: ctx.state.email, now: input.now }, { id, code: input.confirmCode });
      return { ok: result.ok, message: result.text };
    },
    reject: () => Promise.reject(new RpcError("invalid", "autonomy proposals are not rejected: one that is not confirmed expires on its own")),
  };
}

function experimentSource(ctx: GatewayContext): ProposalSource {
  const { env, wiring } = ctx;
  return {
    source: "experiment",
    list: async () => Promise.all((await pendingProposals(env.DB)).map(experimentView)),
    get: async (id) => {
      const p = await loadExperimentProposal(env.DB, id);
      return p ? experimentView(p) : null;
    },
    approve: async (id, input) => {
      const result = await approveProposal({ db: env.DB, kv: env.KV, flags: ctx.flags, templates: servedTemplates(env.KV, wiring.config, ctx.flags, wiring.agent.templates), userId: ctx.state.email, now: input.now }, id);
      return { ok: result.ok, message: result.text };
    },
    reject: async (id, input) => {
      const result = await rejectProposal(env.DB, id, input.actor, input.now);
      return { ok: result.ok, message: result.text };
    },
  };
}

interface LearningRow {
  id: string;
  section: string;
  proposed_text: string;
  rationale: string | null;
  status: string;
  created_at: string;
}

const learningView = (r: LearningRow): Promise<Proposal> =>
  withDigest({ id: r.id, source: "learning", title: `Learning: ${r.section}`, detail: `${r.section}\n\n${r.proposed_text}${r.rationale ? `\n\nWhy: ${r.rationale}` : ""}`, createdAt: r.created_at });

/** Pending learnings as stored, read-only: approving them is the learning module's job. */
function storedLearningSource(ctx: GatewayContext): ProposalSource {
  const db = ctx.env.DB;
  const unavailable = () => Promise.resolve({ ok: false, message: "the learning module is not installed, so learnings cannot be applied from here" });
  return {
    source: "learning",
    list: async () => listStoredLearnings(ctx, "pending"),
    get: async (id) => {
      const row = await db.prepare("SELECT id, section, proposed_text, rationale, status, created_at FROM learnings_proposals WHERE id = ?1").bind(id).first<LearningRow>();
      return row ? learningView(row) : null;
    },
    approve: unavailable,
    reject: unavailable,
  };
}

async function listStoredLearnings(ctx: GatewayContext, status: string): Promise<Proposal[]> {
  try {
    const { results } = await ctx.env.DB.prepare("SELECT id, section, proposed_text, rationale, status, created_at FROM learnings_proposals WHERE status = ?1 ORDER BY created_at DESC LIMIT 50")
      .bind(status)
      .all<LearningRow>();
    return Promise.all(results.map(learningView));
  } catch {
    return [];
  }
}

/** Every source, by name. A source the deployment registers replaces a built-in one of the same name. */
export function proposalSources(ctx: GatewayContext): Map<Proposal["source"], ProposalSource> {
  const sources = new Map<Proposal["source"], ProposalSource>([
    ["autonomy", autonomySource(ctx)],
    ["experiment", experimentSource(ctx)],
    ["learning", storedLearningSource(ctx)],
  ]);
  for (const factory of ctx.wiring.extensions.proposals ?? []) {
    const source = tryBuild(factory, ctx.env);
    if (source) sources.set(source.source, source);
  }
  return sources;
}

const prefixed = (p: Proposal): Proposal => ({ ...p, id: `${p.source}:${p.id}` });

function split(id: string): { source: Proposal["source"]; raw: string } {
  const colon = id.indexOf(":");
  if (colon <= 0) throw new RpcError("invalid", "a proposal id is <source>:<id>");
  return { source: id.slice(0, colon) as Proposal["source"], raw: id.slice(colon + 1) };
}

/** The proposal as it stands now, with the digest recomputed here (never taken from the source). */
async function resolve(ctx: GatewayContext, id: string): Promise<{ source: ProposalSource; raw: string; digest: string; sourceDigest: string }> {
  const { source: name, raw } = split(id);
  const source = proposalSources(ctx).get(name);
  if (!source) throw new RpcError("not_found", "no such proposal source");
  const current = await source.get(raw, ctx.now());
  if (!current) throw new RpcError("not_found", "no such proposal");
  return { source, raw, digest: await proposalDigest(source.source, raw, current.detail), sourceDigest: current.digest };
}

export const proposalsList: Handler<"proposals.list"> = async (p, ctx) => {
  const now = ctx.now();
  const out: Proposal[] = [];
  for (const source of proposalSources(ctx).values()) {
    if (p.source && source.source !== p.source) continue;
    try {
      for (const proposal of await source.list(now)) out.push(prefixed(await withDigest({ ...proposal, source: source.source })));
    } catch {
      // A source that cannot be read is left out of the list; the others still show.
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
};

export const proposalsApprove: Handler<"proposals.approve"> = async (p, ctx) => {
  ctx.audit.proposalId = p.id.slice(0, 80);
  const { source, raw, digest, sourceDigest } = await resolve(ctx, p.id);
  if (!(await constantTimeEqual(p.shownDigest, digest))) throw new RpcError("conflict", "this proposal changed after it was shown; reload it and review it again");
  const result = await source.approve(raw, { actor: ctx.actor, ...(p.confirmCode ? { confirmCode: p.confirmCode } : {}), sourceDigest, now: ctx.now() });
  ctx.audit.applied = result.ok;
  return { status: result.ok ? "applied" : "refused", message: result.message };
};

export const proposalsReject: Handler<"proposals.reject"> = async (p, ctx) => {
  ctx.audit.proposalId = p.id.slice(0, 80);
  const { source, raw } = await resolve(ctx, p.id);
  const result = await source.reject(raw, { actor: ctx.actor, ...(p.reason ? { reason: p.reason } : {}), now: ctx.now() });
  if (!result.ok) throw new RpcError("conflict", result.message);
  return { ok: true };
};

export const learningList: Handler<"learning.list"> = async (p, ctx) => {
  const source = proposalSources(ctx).get("learning");
  if (source && (ctx.wiring.extensions.proposals ?? []).length > 0 && !p.status) {
    const listed = await source.list(ctx.now()).catch(() => []);
    return Promise.all(listed.map(async (l) => prefixed(await withDigest({ ...l, source: "learning" }))));
  }
  return (await listStoredLearnings(ctx, p.status ?? "pending")).map(prefixed);
};

/** Search operator chat history. Text comes back as plain strings; tool output in it was fenced as data. */
export const learningHistorySearch: Handler<"learning.historySearch"> = async (p, ctx) => {
  const limit = p.limit ?? 20;
  const learning = tryBuild(ctx.wiring.extensions.learning, ctx.env);
  if (learning?.historySearch) return learning.historySearch(p.q, limit, ctx.now());
  const needle = p.q.toLowerCase();
  const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const since = new Date(ctx.now().getTime() - 90 * 86_400_000).toISOString();
  const { results } = await ctx.env.DB.prepare(
    "SELECT session_key, content, created_at FROM chat_messages WHERE created_at >= ?1 AND lower(content) LIKE ?2 ESCAPE '\\' ORDER BY id DESC LIMIT ?3",
  )
    .bind(since, like, limit)
    .all<{ session_key: string; content: string; created_at: string }>();
  return results.map((r) => {
    const text = r.content;
    const at = text.toLowerCase().indexOf(needle);
    const start = Math.max(0, at - 80);
    return { sessionKey: r.session_key, at: r.created_at, snippet: text.slice(start, start + 200) };
  });
};
