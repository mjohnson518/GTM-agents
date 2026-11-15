// GTM-agents: the dashboard's Product and ICP methods (docs/TARGETING.md).
//
// targeting.get shows what is served for `product` and `icp`, the newest draft or saved edits, and
// the flags and limits. targeting.validate renders the operator's items as the component's next file
// and checks it with the rest of the brain, changing nothing. The write methods run only while
// targeting:enabled is on (read fail closed): targeting.draft starts an AI draft (also behind
// targeting:draft_enabled, and listed in capabilities only when a model gateway is wired) and lets it
// finish after the response, because a site read and a model call outlast one request;
// targeting.save and targeting.discard keep or drop the editor's text; targeting.propose stores an
// ordinary brain proposal and returns exactly the detail and digest the Proposals view shows, so the
// view approves it through proposals.approve. It needs the learning module's proposal source
// (learningDashboard(), which the template wires), the only one that can approve a brain proposal.
// Nothing here writes the brain.
//
// Drafted text came from the operator's site through a model: it is returned as plain strings and
// the dashboard renders it as text. Audit rows carry ids, counts and enum values, never the text.
import { tryBuild } from "./wiring.ts";
import { RpcError, type GatewayContext, type Handler } from "./context.ts";
import { proposalDigest } from "./proposals.ts";
import type { ProposalSource } from "./wiring.ts";
import type { BrainKv } from "../learning/brain-edit.ts";
import {
  TARGETING_DRAFTS_DAILY_MAX,
  checkTargetingFile,
  discardDraft,
  draftsStartedOn,
  insertDraft,
  isTargetingDraftEnabled,
  isTargetingEnabled,
  latestDraft,
  loadDraft,
  newDraftId,
  proposeTargeting,
  saveWorking,
  servedTargeting,
  startTargetingDraft,
  targetingDraftsDailyMax,
} from "../targeting/index.ts";

function brainKv(ctx: GatewayContext): BrainKv {
  return ctx.env.KV;
}

async function requireEnabled(ctx: GatewayContext): Promise<void> {
  if (!(await isTargetingEnabled(ctx.flags))) throw new RpcError("unavailable", "the Product and ICP page is off; set targeting:enabled to true");
}

/** The learning module's proposal source, which can approve brain proposals, or null when the Worker does not wire it. */
function approvingSource(ctx: GatewayContext): ProposalSource | null {
  for (const factory of ctx.wiring.extensions.proposals ?? []) {
    const source = tryBuild(factory, ctx.env);
    if (source?.source === "learning") return source;
  }
  return null;
}

function operatorActor(ctx: GatewayContext): string {
  return ctx.actor.startsWith("operator:") ? ctx.actor : `operator:${ctx.state.email}`;
}

export const targetingGet: Handler<"targeting.get"> = async (_p, ctx) => {
  const now = ctx.now();
  const [enabled, draftOn, dailyMax, usedToday] = await Promise.all([
    isTargetingEnabled(ctx.flags),
    isTargetingDraftEnabled(ctx.flags),
    targetingDraftsDailyMax(ctx.flags),
    draftsStartedOn(ctx.env.DB, now).catch(() => null),
  ]);
  let served: Awaited<ReturnType<typeof servedTargeting>> | null = null;
  let servedError: string | undefined;
  try {
    served = await servedTargeting(brainKv(ctx));
  } catch {
    servedError = "the served brain could not be read";
  }
  const draft = await latestDraft(ctx.env.DB, now).catch(() => null);
  const { company } = ctx.wiring.config;
  return {
    flags: { enabled, draft: draftOn, dailyMax, usedToday, defaultDailyMax: TARGETING_DRAFTS_DAILY_MAX.default },
    draftAvailable: ctx.wiring.model !== undefined,
    approvable: approvingSource(ctx) !== null,
    company: { name: company.name, url: company.url, description: company.product.description },
    served: served
      ? {
          brainVersion: served.brainVersion,
          product: { content: served.product.content, sha256: served.product.sha256, version: served.product.version, updated: served.product.updated, items: served.product.items },
          icp: { content: served.icp.content, sha256: served.icp.sha256, version: served.icp.version, updated: served.icp.updated, items: served.icp.items },
        }
      : null,
    ...(servedError ? { servedError } : {}),
    draft: draft
      ? {
          id: draft.id,
          status: draft.status,
          source: draft.source,
          url: draft.url,
          reason: draft.reason,
          pages: draft.pages.map((p) => ({ url: p.url, title: p.title, bytes: p.bytes })),
          skipped: draft.skipped,
          draft: draft.draft,
          dropped: draft.dropped,
          working: draft.working,
          startedAt: draft.startedAt,
          finishedAt: draft.finishedAt,
          updatedAt: draft.updatedAt,
        }
      : null,
  };
};

export const targetingDraft: Handler<"targeting.draft"> = async (p, ctx) => {
  ctx.audit.source = p.url !== undefined ? "url" : "text";
  const started = await startTargetingDraft(
    {
      db: ctx.env.DB,
      kv: brainKv(ctx),
      flags: ctx.flags,
      models: ctx.wiring.config.models,
      model: tryBuild(ctx.wiring.model, ctx.env),
      ...(ctx.wiring.agent.fetch ? { fetch: ctx.wiring.agent.fetch } : {}),
      now: ctx.now,
    },
    { ...(p.url !== undefined ? { url: p.url } : {}), ...(p.text !== undefined ? { text: p.text } : {}), requestedBy: operatorActor(ctx) },
  );
  if (!started.ok) throw new RpcError(started.code, started.reason);
  ctx.audit.draftId = started.draftId;
  ctx.defer(started.run());
  return { draftId: started.draftId };
};

export const targetingValidate: Handler<"targeting.validate"> = async (p, ctx) => {
  try {
    const file = await checkTargetingFile(brainKv(ctx), p.component, p.items, ctx.now());
    return { removedHardStops: file.removedHardStops, content: file.content, sha256: file.sha256, baseSha256: file.baseSha256, previousContent: file.previousContent, budgets: file.budgets, issues: file.issues };
  } catch {
    throw new RpcError("unavailable", "the served brain could not be read");
  }
};

export const targetingSave: Handler<"targeting.save"> = async (p, ctx) => {
  await requireEnabled(ctx);
  const now = ctx.now();
  ctx.audit.component = p.component;
  ctx.audit.items = p.items.length;
  if (p.draftId !== undefined) {
    ctx.audit.draftId = p.draftId;
    if (!(await saveWorking(ctx.env.DB, p.draftId, p.component, p.items, now))) throw new RpcError("conflict", "that draft is no longer open; reload the page");
    return { draftId: p.draftId };
  }
  // Without a draft id: into the newest open row, so saving one card never hides the other's saved edits.
  const latest = await latestDraft(ctx.env.DB, now);
  if (latest && latest.status === "ready" && (await saveWorking(ctx.env.DB, latest.id, p.component, p.items, now))) {
    ctx.audit.draftId = latest.id;
    return { draftId: latest.id };
  }
  // Edits written without any draft: kept as a manual working copy, which no model touched.
  const id = newDraftId();
  await insertDraft(ctx.env.DB, { id, status: "ready", source: "manual", url: null, requestedBy: operatorActor(ctx), working: { [p.component]: p.items } }, now);
  ctx.audit.draftId = id;
  return { draftId: id };
};

export const targetingDiscard: Handler<"targeting.discard"> = async (p, ctx) => {
  await requireEnabled(ctx);
  ctx.audit.draftId = p.draftId;
  const row = await loadDraft(ctx.env.DB, p.draftId, ctx.now());
  if (!row) throw new RpcError("not_found", "no such draft");
  await discardDraft(ctx.env.DB, p.draftId, ctx.now());
  return { ok: true };
};

export const targetingPropose: Handler<"targeting.propose"> = async (p, ctx) => {
  await requireEnabled(ctx);
  ctx.audit.component = p.component;
  ctx.audit.items = p.items.length;
  const source = approvingSource(ctx);
  if (!source) throw new RpcError("unavailable", "brain proposals cannot be approved from this dashboard: pass learningDashboard() to createWorker as `dashboard`");
  let result: Awaited<ReturnType<typeof proposeTargeting>>;
  try {
    result = await proposeTargeting({ db: ctx.env.DB, kv: brainKv(ctx), now: ctx.now() }, p.component, p.items, operatorActor(ctx), p.confirmRemoved ?? []);
  } catch {
    throw new RpcError("unavailable", "the served brain could not be read");
  }
  if (!result.ok) throw new RpcError("invalid", result.problems.slice(0, 5).join("; "));
  const shortId = result.proposal.shortId;
  ctx.audit.proposalId = `learning:${shortId}`;
  // The detail and digest exactly as the Proposals view shows and proposals.approve checks them.
  const current = await source.get(shortId, ctx.now());
  if (!current) throw new RpcError("unavailable", "the proposal was stored but could not be read back; find it in the Proposals view");
  return { proposalId: `learning:${shortId}`, detail: current.detail, digest: await proposalDigest("learning", shortId, current.detail), created: result.created };
};
