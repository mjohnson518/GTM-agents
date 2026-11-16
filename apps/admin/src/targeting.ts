// GTM-agents: the Product and ICP view's editor state, kept apart from the view so it can be tested.
// It also holds the readiness lines and the picks made from suggested search queries and personas.
// An editor is a list of brain items (a kind, a text and, for an ICP hard stop, its lists). The
// server renders and validates the file; this module only edits the list, tells whether it differs
// from what it was loaded from, and groups it for display. It imports types from core, never code.
import type { TargetingDraftItem, TargetingItem, TargetingReadiness, TargetingState, TargetingSuggestionView } from "@gtm-agents/core/gateway/protocol";

export type TargetingComponent = "product" | "icp";

export interface EditorItem {
  /** Unique within the editor, for rendering; not stored. */
  key: string;
  id: string;
  kind: string;
  text: string;
  /** The other fields of the item: an ICP hard stop's domains, accounts and titles. */
  extra: Record<string, string>;
  /** Where the item came from: the AI draft, the served file, or the operator. */
  origin: "drafted" | "served" | "added";
  basis?: "stated" | "inferred";
  figures?: boolean;
}

export const TEXT_MAX = 300;
/** A served component older than this gets a gentle "review this" hint. */
export const REVIEW_AFTER_DAYS = 90;

export const KINDS: Record<TargetingComponent, ReadonlyArray<{ kind: string; label: string }>> = {
  product: [
    { kind: "summary", label: "What it is" },
    { kind: "problem", label: "Problem" },
    { kind: "capability", label: "Capability" },
    { kind: "outcome", label: "Outcome" },
    { kind: "use_case", label: "Use case" },
    { kind: "differentiator", label: "Differentiator" },
    { kind: "not_for", label: "Not for" },
  ],
  icp: [
    { kind: "who", label: "Who" },
    { kind: "why_now", label: "Why now" },
    { kind: "must_have", label: "Must have" },
    { kind: "trigger", label: "Triggers" },
    { kind: "ignore", label: "Ignore" },
    { kind: "never", label: "Never" },
    { kind: "unknown", label: "Open questions" },
  ],
};

export const LIST_FIELDS = ["domains", "accounts", "titles"] as const;

let counter = 0;
const nextKey = () => `k${(counter += 1)}`;

/** Editor items from stored items. Drafted items keep their basis and figure flag. */
export function fromItems(items: readonly TargetingItem[], origin: EditorItem["origin"], drafted: readonly TargetingDraftItem[] = []): EditorItem[] {
  const byId = new Map(drafted.map((d) => [d.id, d]));
  return items.map((item) => {
    const { kind = "", text = "", ...extra } = item.fields;
    const d = byId.get(item.id);
    // Only an item still holding the drafted text is shown as drafted; edited and saved, it is the operator's.
    const fromDraft = origin === "drafted" && d !== undefined && d.text === text && d.kind === kind;
    return {
      key: nextKey(),
      id: item.id,
      kind,
      text,
      extra,
      origin: fromDraft ? "drafted" : origin === "drafted" ? (kind === "never" ? "served" : "added") : origin,
      ...(fromDraft ? { basis: d.basis, figures: d.figures } : {}),
    };
  });
}

/** The items to send: each with its kind, its text and any non-empty list field. */
export function toItems(list: readonly EditorItem[]): TargetingItem[] {
  return list.map((item) => {
    const fields: Record<string, string> = { kind: item.kind, text: item.text.replace(/\s+/g, " ").trim() };
    for (const [k, v] of Object.entries(item.extra)) if (v.trim() !== "") fields[k] = v.trim();
    return { id: item.id, fields };
  });
}

function idFor(kind: string, taken: ReadonlySet<string>): string {
  const base = kind.replace(/_/g, "-");
  for (let n = 1; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function addItem(list: readonly EditorItem[], kind: string): EditorItem[] {
  const id = idFor(kind, new Set(list.map((i) => i.id)));
  return [...list, { key: nextKey(), id, kind, text: "", extra: {}, origin: "added" }];
}

export function removeItem(list: readonly EditorItem[], key: string): EditorItem[] {
  return list.filter((i) => i.key !== key);
}

export function updateItem(list: readonly EditorItem[], key: string, change: Partial<Pick<EditorItem, "text" | "kind">> & { field?: { name: string; value: string } }): EditorItem[] {
  return list.map((i) => {
    if (i.key !== key) return i;
    const next: EditorItem = { ...i, ...(change.text !== undefined ? { text: change.text } : {}), ...(change.kind !== undefined ? { kind: change.kind } : {}) };
    if (change.field) next.extra = { ...i.extra, [change.field.name]: change.field.value };
    // An item the operator edited is theirs now: no longer "drafted from your site".
    if (change.text !== undefined && change.text !== i.text && next.origin === "drafted") {
      next.origin = "added";
      delete next.basis;
      delete next.figures;
    }
    return next;
  });
}

/** True when two item lists hold the same items in the same order. */
export function sameItems(a: readonly TargetingItem[], b: readonly TargetingItem[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * True when the served file holds this item exactly: the same id and the same fields, as it would be
 * sent. Where the item came from does not decide it: a drafted item is approved once its file is, and
 * a served item the operator edited is not approved until its file is approved again.
 */
export function isApproved(item: EditorItem, served: readonly TargetingItem[]): boolean {
  const mine = toItems([item])[0];
  const theirs = served.find((s) => s.id === item.id);
  if (!mine || !theirs) return false;
  const a = Object.entries(mine.fields);
  const b = Object.entries(theirs.fields).filter(([, v]) => v.trim() !== "");
  return a.length === b.length && a.every(([k, v]) => theirs.fields[k]?.trim() === v);
}

/** Items grouped by kind, in the kinds' order; kinds with no items are left out. */
export function grouped(component: TargetingComponent, list: readonly EditorItem[]): Array<{ kind: string; label: string; items: EditorItem[] }> {
  const known = KINDS[component];
  const groups = known.map((k) => ({ ...k, items: list.filter((i) => i.kind === k.kind) }));
  const other = list.filter((i) => !known.some((k) => k.kind === i.kind));
  if (other.length) groups.push({ kind: "", label: "Other", items: other });
  return groups.filter((g) => g.items.length > 0);
}

/**
 * What the editor starts from: saved edits or the draft's working copy when there is one, else the
 * served file. A hard stop the brain serves now that the working copy lacks (added since the draft)
 * is put back, so loading an older draft never drops it without the operator seeing it.
 */
export function baseline(state: TargetingState, component: TargetingComponent): { items: TargetingItem[]; origin: EditorItem["origin"]; drafted: TargetingDraftItem[] } {
  const working = state.draft && state.draft.status === "ready" ? state.draft.working?.[component] : undefined;
  if (working) {
    const servedStops = component === "icp" ? (state.served?.icp.items ?? []).filter((i) => i.fields.kind === "never" && !working.some((w) => w.id === i.id)) : [];
    return { items: [...working, ...servedStops], origin: "drafted", drafted: state.draft?.draft?.[component] ?? [] };
  }
  return { items: state.served?.[component].items ?? [], origin: "served", drafted: [] };
}

/** True when a served component was last approved more than REVIEW_AFTER_DAYS ago. */
export function reviewDue(updated: string | null, now: Date): boolean {
  if (!updated) return false;
  const t = Date.parse(`${updated}T00:00:00Z`);
  return Number.isFinite(t) && now.getTime() - t > REVIEW_AFTER_DAYS * 86_400_000;
}

export function kindLabel(component: TargetingComponent, kind: string): string {
  return KINDS[component].find((k) => k.kind === kind)?.label ?? kind;
}

/** An editor's items and the items it was loaded from. */
export interface EditorCore {
  items: EditorItem[];
  base: TargetingItem[];
}

/**
 * The editor after a reload of `state`: one with unsaved changes is kept exactly as it is, so a
 * reconnect (which reloads the view) never loses typing; any other starts again from the baseline.
 */
export function reloadEditor(current: EditorCore | undefined, state: TargetingState, component: TargetingComponent): EditorCore {
  if (current && !sameItems(toItems(current.items), current.base)) return current;
  const b = baseline(state, component);
  return { items: fromItems(b.items, b.origin, b.drafted), base: b.items };
}


/** One line of the readiness panel: ok (in place), warn (discovery is missing something), off (a flag or an optional part). */
export interface ReadinessLine {
  tone: "ok" | "warn" | "off";
  text: string;
}

/** What each approved component steers, in plain words, for the readiness panel. */
export const STEERS: Record<"product" | "icp" | "personas" | "keyword-portfolio", string> = {
  product: "the model fit score and the chat agent's planning",
  icp: "the model fit score, the fit gate before paid enrichment and promotion, and sourcing's hard stops",
  personas: "which people pass person fit, so who is enriched, qualified and promoted, and the cold mail writers",
  "keyword-portfolio": "what search looks for, and so what discovery spends on",
};

/** The readiness panel's lines: what discovery and fit scoring are missing first, then the flags. */
export function readinessLines(r: TargetingReadiness | null): ReadinessLine[] {
  if (!r) return [{ tone: "warn", text: "The brain could not be read, so readiness is unknown." }];
  const lines: ReadinessLine[] = [];
  if (r.sourcing.degraded) {
    lines.push({ tone: "warn", text: "The brain could not be read whole, so discovery does nothing until it is uploaded again." });
  } else {
    if (!r.components.icp.served) lines.push({ tone: "warn", text: "No ICP is approved: fit scoring has nothing to judge accounts against, and sourcing has no hard stops." });
    if (r.sourcing.personas === 0) lines.push({ tone: "warn", text: "No personas are approved: search still runs and spends, but nobody it finds is enriched, qualified or promoted." });
    if (r.sourcing.queries === 0) lines.push({ tone: "warn", text: "No search queries are approved, so search looks for nothing." });
  }
  if (!r.components.product.served) lines.push({ tone: "off", text: "No product description is approved; fit scoring and the chat agent go without it." });
  lines.push(r.flags.discovery ? { tone: "ok", text: "Discovery is on (discovery:enabled)." } : { tone: "off", text: "Discovery is off (discovery:enabled): nothing is searched, enriched or promoted." });
  lines.push(r.flags.fitScoring ? { tone: "ok", text: "Fit scoring is on (fit:scoring_enabled)." } : { tone: "off", text: "Fit scoring is off (fit:scoring_enabled): accounts keep their prescore." });
  lines.push(r.flags.research ? { tone: "ok", text: "Account research is on (enrichment:research_enabled)." } : { tone: "off", text: "Account research is off (enrichment:research_enabled)." });
  return lines;
}

export type SuggestComponent = "keyword-portfolio" | "personas";

/** The fields of a suggestion the operator may edit: its main text. The server enforces the same. */
export const SUGGEST_EDITABLE: Readonly<Record<SuggestComponent, readonly string[]>> = { "keyword-portfolio": ["query"], personas: ["titles", "text"] };

/** One suggestion in the picker: as suggested, as edited, and whether it is picked. */
export interface SuggestionPick {
  id: string;
  suggested: Record<string, string>;
  fields: Record<string, string>;
  picked: boolean;
}

/** The picker for one component: every suggestion, with the saved picks and their edits applied. */
export function picksFrom(suggestion: TargetingSuggestionView | null, component: SuggestComponent): SuggestionPick[] {
  if (!suggestion?.suggestions) return [];
  const saved = new Map((suggestion.working?.[component] ?? []).map((i) => [i.id, i.fields]));
  return suggestion.suggestions[component].map((s) => {
    const edited = saved.get(s.id);
    return { id: s.id, suggested: s.fields, fields: { ...(edited ?? s.fields) }, picked: edited !== undefined };
  });
}

export function togglePick(list: readonly SuggestionPick[], id: string): SuggestionPick[] {
  return list.map((p) => (p.id === id ? { ...p, picked: !p.picked } : p));
}

/** Edit one field of a suggestion. Only its main text can change; editing picks it. */
export function editPick(list: readonly SuggestionPick[], component: SuggestComponent, id: string, field: string, value: string): SuggestionPick[] {
  if (!SUGGEST_EDITABLE[component].includes(field)) return [...list];
  return list.map((p) => (p.id === id ? { ...p, picked: true, fields: { ...p.fields, [field]: value } } : p));
}

/** The picked items to save or propose, their text on one line. */
export function pickedItems(list: readonly SuggestionPick[]): TargetingItem[] {
  return list.filter((p) => p.picked).map((p) => ({ id: p.id, fields: Object.fromEntries(Object.entries(p.fields).map(([k, v]) => [k, v.replace(/\s+/g, " ").trim()])) }));
}

/** A picker and what it was loaded from. */
export interface PicksCore {
  suggestionId: string | null;
  list: SuggestionPick[];
  base: TargetingItem[];
}

/**
 * The picker after a reload: one with unsaved changes to the same suggestion is kept exactly as it
 * is; any other starts again from the suggestion and its saved picks.
 */
export function reloadPicks(current: PicksCore | undefined, suggestion: TargetingSuggestionView | null, component: SuggestComponent): PicksCore {
  const id = suggestion?.status === "ready" ? suggestion.id : null;
  if (current && current.suggestionId === id && !sameItems(pickedItems(current.list), current.base)) return current;
  const list = id ? picksFrom(suggestion, component) : [];
  return { suggestionId: id, list, base: pickedItems(list) };
}
