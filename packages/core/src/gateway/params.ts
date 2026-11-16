// GTM-agents: the parameter schemas for every dashboard method. A request whose params do not parse
// is refused with "invalid" before any handler runs. Objects are strict: an unknown field is refused,
// so a client can never slip an identity, a status or a digest past a handler that ignores it.
import { z } from "zod";
import { DEAL_STAGES, DRAFT_KINDS, WARMTH_STATES } from "../data/enums.ts";
import { ADDITIONS_MAX } from "../targeting/propose.ts";
import type { MethodName } from "./protocol.ts";

const id = z.string().regex(/^[A-Za-z0-9_:.-]{1,120}$/, "an id is 1 to 120 letters, digits or _ : . -");
const cursor = z.string().max(200);
const digest = z.string().regex(/^[0-9a-f]{64}$/, "a digest is 64 lowercase hex characters");
const shortText = (max: number) => z.string().max(max);
const reason = z.string().trim().min(1).max(300);
const none = z.strictObject({});
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[0-9:.]+Z)?$/, "use an ISO date such as 2026-11-01");

export const INBOUND_STATUSES = ["new", "notified", "draft_created", "responded", "ignored", "archived"] as const;
export const PROPOSAL_SOURCES = ["autonomy", "experiment", "learning", "brain", "copy", "self_review"] as const;

// A brain item from the Product and ICP editor: a kebab-case id and single-line fields. The server
// renders and validates the file; these bounds only keep a request small.
const brainItem = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "item ids are kebab-case").max(64),
  fields: z.record(z.string().regex(/^[a-z][a-z_]{0,31}$/, "field names are lowercase"), z.string().max(400)).refine((f) => Object.keys(f).length <= 8, "at most 8 fields"),
});
const targetingComponent = z.enum(["product", "icp"]);
const targetingItems = z.array(brainItem).max(40);
const suggestComponent = z.enum(["keyword-portfolio", "personas"]);
const additions = z.array(brainItem).max(ADDITIONS_MAX);

export const PARAMS = {
  connect: z.strictObject({ protocolVersion: z.number().int().min(1).max(1000) }),
  status: none,
  health: none,

  "chat.send": z.strictObject({ text: z.string().trim().min(1).max(4000) }),
  "chat.history": z.strictObject({ limit: z.number().int().min(1).max(100).optional() }),
  "chat.abort": z.strictObject({ turnId: id }),

  "cockpit.get": none,
  "cockpit.pause": z.strictObject({ reason }),
  "cockpit.resume": none,
  "cockpit.drain": z.strictObject({ reason }),
  "cockpit.replay": none,

  "pipeline.summary": none,
  "pipeline.deals": z.strictObject({ stage: z.enum(DEAL_STAGES).optional(), cursor: cursor.optional() }),
  "pipeline.create": z.strictObject({ contactId: id, value: z.number().finite().min(0).max(1e9).optional(), notes: shortText(2000).optional() }),
  "pipeline.update": z.strictObject({ dealId: id, value: z.number().finite().min(0).max(1e9).optional(), notes: shortText(2000).optional() }),
  "pipeline.transition": z.strictObject({ dealId: id, to: z.enum(DEAL_STAGES), reason: shortText(300).optional() }),

  "contacts.query": z.strictObject({ q: shortText(100).optional(), warmth: z.enum(WARMTH_STATES).optional(), cursor: cursor.optional(), limit: z.number().int().min(1).max(100).optional() }),
  "contacts.get": z.strictObject({ id }),
  "contacts.update": z.strictObject({
    id,
    patch: z.strictObject({ firstName: shortText(80).optional(), lastName: shortText(80).optional(), jobTitle: shortText(160).optional(), notes: shortText(4000).optional() }),
  }),
  "contacts.stats": none,
  "contacts.next": none,
  "contacts.log": z.strictObject({ id, cursor: cursor.optional() }),
  "contacts.summary": z.strictObject({ id }),

  "inbound.list": z.strictObject({ status: z.enum(INBOUND_STATUSES).optional(), cursor: cursor.optional() }),
  "inbound.action": z.strictObject({ id, action: z.enum(["archive", "ignore", "done"]) }),
  "inbound.draftSend": z.strictObject({ draftId: id, shownDigest: digest }),
  "inbound.stats": none,

  "drafts.list": z.strictObject({ status: z.enum(["draft", "pending_approval", "approved"]).optional(), kind: z.enum(DRAFT_KINDS).optional(), cursor: cursor.optional() }),
  "drafts.approve": z.strictObject({ draftId: id, shownDigest: digest }),
  "drafts.reject": z.strictObject({ draftId: id, reason: shortText(300).optional() }),

  "proposals.list": z.strictObject({ source: z.enum(PROPOSAL_SOURCES).optional() }),
  "proposals.approve": z.strictObject({ id, shownDigest: digest, confirmCode: z.string().regex(/^[A-Za-z0-9]{1,16}$/).optional() }),
  "proposals.reject": z.strictObject({ id, reason: shortText(300).optional() }),

  "targeting.get": none,
  "targeting.draft": z.strictObject({ url: z.string().trim().min(1).max(2000).optional(), text: z.string().max(24_000).optional() }),
  "targeting.validate": z.strictObject({ component: targetingComponent, items: targetingItems }),
  "targeting.save": z.strictObject({ component: targetingComponent, items: targetingItems, draftId: id.optional() }),
  "targeting.discard": z.strictObject({ draftId: id }),
  "targeting.propose": z.strictObject({ component: targetingComponent, items: targetingItems, confirmRemoved: z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64)).max(40).optional() }),
  "targeting.suggest": none,
  "targeting.saveSuggestions": z.strictObject({ suggestionId: id, component: suggestComponent, items: additions }),
  "targeting.discardSuggestions": z.strictObject({ suggestionId: id }),
  "targeting.checkAdditions": z.strictObject({ suggestionId: id, component: suggestComponent, items: additions }),
  "targeting.proposeAdditions": z.strictObject({ suggestionId: id, component: suggestComponent, items: additions }),

  "agents.list": none,
  "agents.status": none,

  "activity.list": z.strictObject({ cursor: cursor.optional(), kind: shortText(80).optional(), limit: z.number().int().min(1).max(200).optional() }),
  "activity.subscribe": z.strictObject({ on: z.boolean() }),
  "activity.export": z.strictObject({ from: isoDay, to: isoDay }),

  "security.audit": none,
  "config.get": none,
  "flags.list": none,
  "flags.set": z.strictObject({ key: z.string().min(1).max(200), value: z.string().max(16 * 1024).nullable() }),
  "cost.summary": z.strictObject({ days: z.number().int().min(1).max(90).optional() }),
  "fitness.trend": z.strictObject({ days: z.number().int().min(1).max(365).optional() }),

  "learning.summary": none,
  "learning.list": z.strictObject({ status: shortText(40).optional() }),
  "learning.historySearch": z.strictObject({ q: z.string().trim().min(2).max(200), limit: z.number().int().min(1).max(50).optional() }),
  "linkTriage.status": none,
  "changelog.list": z.strictObject({ q: shortText(200).optional(), area: shortText(60).optional() }),
} satisfies Record<MethodName, z.ZodType>;

/** Parse a method's params. A missing params object counts as {}. */
export function parseParams<M extends MethodName>(method: M, params: unknown): { ok: true; value: z.output<(typeof PARAMS)[M]> } | { ok: false; message: string } {
  const result = PARAMS[method].safeParse(params === undefined || params === null ? {} : params);
  if (result.success) return { ok: true, value: result.data as z.output<(typeof PARAMS)[M]> };
  const first = result.error.issues[0];
  const where = first?.path.length ? `${first.path.join(".")}: ` : "";
  return { ok: false, message: `${where}${first?.message ?? "the params do not match this method"}`.slice(0, 200) };
}
