// GTM-agents: the Product and ICP view. The operator gives their site's URL (or pastes its text), an
// AI drafts a product description and an ideal customer profile into editable items, and they edit
// and approve each one as a brain component. A draft steers nothing: approval is an ordinary brain
// proposal, shown here with its exact diff and approved with the digest of that detail, the same
// way the Proposals view approves it. Drafted text came from the operator's site through a model,
// so every string is rendered as text. Unsaved edits survive a reconnect, and leaving the page with
// them asks first.
//
// A readiness card says what discovery and fit scoring have to work with. Below the two cards, the
// operator can ask for suggested search queries and personas drawn only from the approved product
// and ICP, pick and edit them, and approve each component as every served item plus the picks.
import { html, nothing } from "lit";
import type { TargetingCheck, TargetingItem, TargetingState, TargetingSuggestComponent } from "@gtm-agents/core/gateway/protocol";
import { formatDateTime } from "../format.ts";
import {
  KINDS,
  LIST_FIELDS,
  STEERS,
  SUGGEST_EDITABLE,
  TEXT_MAX,
  addItem,
  editPick,
  fromItems,
  grouped,
  isApproved,
  kindLabel,
  pickedItems,
  readinessLines,
  reloadEditor,
  reloadPicks,
  removeItem,
  reviewDue,
  sameItems,
  toItems,
  togglePick,
  updateItem,
  type EditorItem,
  type PicksCore,
  type TargetingComponent,
} from "../targeting.ts";
import { confirmAction } from "../ui/dialog.ts";
import { GtmView, LOADING, describeError, section, settle } from "./base.ts";
import type { Loadable } from "./base.ts";

const COMPONENTS: readonly TargetingComponent[] = ["product", "icp"];
const SUGGESTED: readonly TargetingSuggestComponent[] = ["keyword-portfolio", "personas"];
const SUGGEST_TITLES: Record<TargetingSuggestComponent, string> = { "keyword-portfolio": "Search queries", personas: "Personas" };
const SUGGEST_ONE: Record<TargetingSuggestComponent, string> = { "keyword-portfolio": "search query", personas: "persona" };
const READONLY_FIELDS: Record<TargetingSuggestComponent, readonly string[]> = { "keyword-portfolio": ["intent", "segment"], personas: ["role", "seat", "seniority", "exclude_titles"] };

interface Picker extends PicksCore {
  check: TargetingCheck | null;
}
const TITLES: Record<TargetingComponent, string> = { product: "Product or service", icp: "Ideal customer profile" };
const POLL_MS = 2000;
const POLL_LIMIT = 45;

interface Editor {
  items: EditorItem[];
  /** The items the editor was loaded from, to tell whether it has unsaved changes. */
  base: ReturnType<typeof toItems>;
  check: TargetingCheck | null;
  newKind: string;
}

export class GtmTargeting extends GtmView {
  static override properties = {
    ...GtmView.properties,
    state: { state: true },
    editors: { state: true },
    url: { state: true },
    pasting: { state: true },
    drafting: { state: true },
    pickers: { state: true },
    suggesting: { state: true },
  };

  declare state: Loadable<TargetingState>;
  declare editors: Record<TargetingComponent, Editor> | null;
  declare url: string;
  declare pasting: boolean;
  declare drafting: boolean;
  declare pickers: Record<TargetingSuggestComponent, Picker> | null;
  declare suggesting: boolean;
  #draftId: string | null = null;
  #suggestionId: string | null = null;

  constructor() {
    super();
    this.state = LOADING;
    this.editors = null;
    this.url = "";
    this.pasting = false;
    this.drafting = false;
    this.pickers = null;
    this.suggesting = false;
  }

  /** True while an editor or a picker holds changes that are not saved. */
  get dirty(): boolean {
    return (this.editors !== null && COMPONENTS.some((c) => this.#dirty(c))) || SUGGESTED.some((c) => this.#picksDirty(c));
  }

  #picksDirty(c: TargetingSuggestComponent): boolean {
    const p = this.pickers?.[c];
    return p !== undefined && !sameItems(pickedItems(p.list), p.base);
  }

  #dirty(c: TargetingComponent): boolean {
    const e = this.editors?.[c];
    return e !== undefined && !sameItems(toItems(e.items), e.base);
  }

  #beforeUnload = (event: BeforeUnloadEvent) => {
    if (this.dirty) event.preventDefault();
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("beforeunload", this.#beforeUnload);
  }

  override disconnectedCallback(): void {
    window.removeEventListener("beforeunload", this.#beforeUnload);
    super.disconnectedCallback();
  }

  override async load(): Promise<void> {
    const next = await settle(this.rpc.call("targeting.get", {}));
    this.state = next;
    if (next.state !== "ok") return;
    if (!this.url) this.url = next.value.draft?.url ?? next.value.company.url;
    // A reload never clobbers unsaved edits: an editor with changes keeps them.
    const editors = {} as Record<TargetingComponent, Editor>;
    for (const c of COMPONENTS) {
      const current = this.editors?.[c];
      const core = reloadEditor(current, next.value, c);
      editors[c] = core === current ? current : { ...core, check: null, newKind: current?.newKind ?? KINDS[c][0]?.kind ?? "" };
    }
    this.editors = editors;
    const pickers = {} as Record<TargetingSuggestComponent, Picker>;
    for (const c of SUGGESTED) {
      const current = this.pickers?.[c];
      const core = reloadPicks(current, next.value.suggestion, c);
      pickers[c] = core === current ? current : { ...core, check: null };
    }
    this.pickers = pickers;
  }

  #edit(c: TargetingComponent, change: (items: EditorItem[]) => EditorItem[]): void {
    if (!this.editors) return;
    this.editors = { ...this.editors, [c]: { ...this.editors[c], items: change(this.editors[c].items), check: null } };
  }

  /** Load a component's served file into its editor, replacing unsaved edits after asking. */
  async #startFromServed(c: TargetingComponent): Promise<void> {
    if (this.state.state !== "ok" || !this.editors) return;
    if (this.#dirty(c)) {
      const answer = await confirmAction({ title: "Replace your edits", body: html`<p>Load the approved ${TITLES[c].toLowerCase()} into the editor? Your unsaved edits are lost.</p>`, confirmLabel: "Replace", danger: true });
      if (!answer.confirmed) return;
    }
    const items = this.state.value.served?.[c].items ?? [];
    this.editors = { ...this.editors, [c]: { ...this.editors[c], items: fromItems(items, "served"), base: items, check: null } };
  }

  async #draft(text?: string): Promise<void> {
    if (this.dirty) {
      const answer = await confirmAction({ title: "Draft again", body: html`<p>A new draft replaces what the editors show once it is ready, and your unsaved edits are lost.</p>`, confirmLabel: "Draft", danger: true });
      if (!answer.confirmed) return;
    }
    this.drafting = true;
    const ok = await this.perform(
      "Draft",
      async () => {
        const started = await this.rpc.call("targeting.draft", text !== undefined ? { text } : { url: this.url.trim() });
        this.#draftId = started.draftId;
        return "Reading the site and drafting. This takes up to a minute.";
      },
      false,
    );
    if (!ok) {
      this.drafting = false;
      return;
    }
    for (let i = 0; i < POLL_LIMIT && this.isConnected; i++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const next = await settle(this.rpc.call("targeting.get", {}));
      if (next.state === "ok" && next.value.draft?.id === this.#draftId && next.value.draft.status !== "running") {
        this.editors = null;
        await this.load();
        const d = next.value.draft;
        this.notice = d.status === "ready" ? { tone: "ok", text: "The draft is in the editors below. Nothing is approved: read every item, fix what is wrong, then review and approve each card." } : { tone: "bad", text: `No draft was made: ${d.reason ?? "it failed"}` };
        this.drafting = false;
        return;
      }
    }
    this.drafting = false;
    if (this.isConnected) this.notice = { tone: "bad", text: "The draft is still running. Refresh in a minute to see it." };
  }

  async #check(c: TargetingComponent): Promise<TargetingCheck | null> {
    if (!this.editors) return null;
    try {
      const check = await this.rpc.call("targeting.validate", { component: c, items: toItems(this.editors[c].items) });
      this.editors = { ...this.editors, [c]: { ...this.editors[c], check } };
      return check;
    } catch (err) {
      this.notice = { tone: "bad", text: `Checking failed. ${describeError(err)}` };
      return null;
    }
  }

  async #save(c: TargetingComponent): Promise<void> {
    if (!this.editors || this.state.state !== "ok") return;
    const items = toItems(this.editors[c].items);
    const draft = this.state.value.draft;
    const draftId = draft && draft.status === "ready" ? draft.id : undefined;
    const ok = await this.perform(
      "Save",
      async () => {
        await this.rpc.call("targeting.save", { component: c, items, ...(draftId ? { draftId } : {}) });
        return `${TITLES[c]}: saved. Nothing is approved yet.`;
      },
      false,
    );
    if (ok && this.editors) {
      this.editors = { ...this.editors, [c]: { ...this.editors[c], base: items } };
      await this.load();
    }
  }

  async #approve(c: TargetingComponent): Promise<void> {
    if (!this.editors) return;
    const check = await this.#check(c);
    if (!check) return;
    const errors = check.issues.filter((i) => i.severity === "error");
    if (errors.length > 0) {
      this.notice = { tone: "bad", text: `Fix ${errors.length} issue(s) in ${TITLES[c].toLowerCase()} first.` };
      return;
    }
    const items = toItems(this.editors[c].items);
    const removed = check.removedHardStops;
    if (removed.length > 0) {
      const sure = await confirmAction({
        title: "Remove hard stops",
        body: html`<p>This ICP leaves out ${removed.length} hard stop(s) the brain serves now:</p>
          <ul class="plain">${removed.map((id) => html`<li class="mono">${id}</li>`)}</ul>
          <p class="small muted">Once approved, sourcing stops excluding them. Cancel to keep them, then use Start from approved or add them back.</p>`,
        confirmLabel: "Remove them",
        danger: true,
      });
      if (!sure.confirmed) return;
    }
    let proposal: { proposalId: string; detail: string; digest: string };
    try {
      proposal = await this.rpc.call("targeting.propose", { component: c, items, ...(removed.length > 0 ? { confirmRemoved: removed } : {}) });
    } catch (err) {
      this.notice = { tone: "bad", text: `Proposing failed. ${describeError(err)}` };
      return;
    }
    const answer = await confirmAction({
      title: `Approve the ${TITLES[c].toLowerCase()}`,
      body: html`<p class="small muted">Approving replaces the ${c} component with exactly this file. From then on it steers ${c === "icp" ? "fit scoring, the fit gate before paid enrichment, the hard stops in sourcing, and the agent's planning" : "fit scoring and the chat agent's planning, and so the drafts it writes for you to approve; template emails never read it"}. It is also listed in the Proposals view until it is decided.</p>
        <pre class="text draft-body">${proposal.detail}</pre>`,
      confirmLabel: "Approve",
    });
    if (!answer.confirmed) {
      this.notice = { tone: "ok", text: "Not approved. The proposal stays in the Proposals view until it is decided or expires." };
      return;
    }
    const ok = await this.perform("Approve", async () => {
      const result = await this.rpc.call("proposals.approve", { id: proposal.proposalId, shownDigest: proposal.digest });
      return result.message ?? `Proposal ${result.status}.`;
    }, false);
    if (ok && this.editors) {
      this.editors = { ...this.editors, [c]: { ...this.editors[c], base: items } };
      await this.load();
    }
  }

  async #discard(): Promise<void> {
    if (this.state.state !== "ok" || !this.state.value.draft) return;
    const id = this.state.value.draft.id;
    const answer = await confirmAction({ title: "Discard the draft", body: html`<p>Drop the draft and every saved edit? What is approved does not change.</p>`, confirmLabel: "Discard", danger: true });
    if (!answer.confirmed) return;
    this.editors = null;
    await this.perform("Discard", async () => {
      await this.rpc.call("targeting.discard", { draftId: id });
      return "Discarded.";
    });
  }

  async #copy(c: TargetingComponent): Promise<void> {
    const content = this.state.state === "ok" ? this.state.value.served?.[c].content : null;
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      this.notice = { tone: "ok", text: `Copied ${c}.md. Save it in your brain folder, or run gtm brain pull.` };
    } catch {
      this.notice = { tone: "bad", text: "The browser did not allow copying. Run gtm brain pull instead." };
    }
  }

  #setPicker(c: TargetingSuggestComponent, change: (p: Picker) => Picker): void {
    if (!this.pickers) return;
    this.pickers = { ...this.pickers, [c]: change(this.pickers[c]) };
  }

  async #suggest(): Promise<void> {
    if (SUGGESTED.some((c) => this.#picksDirty(c))) {
      const answer = await confirmAction({ title: "Suggest again", body: html`<p>New suggestions replace the ones shown, and your unsaved picks are lost.</p>`, confirmLabel: "Suggest", danger: true });
      if (!answer.confirmed) return;
    }
    this.suggesting = true;
    const ok = await this.perform(
      "Suggest",
      async () => {
        const started = await this.rpc.call("targeting.suggest", {});
        this.#suggestionId = started.suggestionId;
        return "Reading your approved product and ICP and suggesting. This takes up to a minute.";
      },
      false,
    );
    if (!ok) {
      this.suggesting = false;
      return;
    }
    for (let i = 0; i < POLL_LIMIT && this.isConnected; i++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const next = await settle(this.rpc.call("targeting.get", {}));
      if (next.state === "ok" && next.value.suggestion?.id === this.#suggestionId && next.value.suggestion.status !== "running") {
        this.pickers = null;
        await this.load();
        const sg = next.value.suggestion;
        this.notice = sg.status === "ready" ? { tone: "ok", text: "Suggestions are below. Nothing is approved: pick the ones that fit, edit their wording, then review and approve." } : { tone: "bad", text: `Nothing was suggested: ${sg.reason ?? "it failed"}` };
        this.suggesting = false;
        return;
      }
    }
    this.suggesting = false;
    if (this.isConnected) this.notice = { tone: "bad", text: "The suggestion is still running. Refresh in a minute to see it." };
  }

  async #checkPicks(c: TargetingSuggestComponent): Promise<TargetingCheck | null> {
    const picker = this.pickers?.[c];
    if (!picker?.suggestionId) return null;
    try {
      const check = await this.rpc.call("targeting.checkAdditions", { suggestionId: picker.suggestionId, component: c, items: pickedItems(picker.list) });
      this.#setPicker(c, (p) => ({ ...p, check }));
      return check;
    } catch (err) {
      this.notice = { tone: "bad", text: `Checking failed. ${describeError(err)}` };
      return null;
    }
  }

  async #savePicks(c: TargetingSuggestComponent): Promise<void> {
    const picker = this.pickers?.[c];
    if (!picker?.suggestionId) return;
    const items = pickedItems(picker.list);
    const suggestionId = picker.suggestionId;
    const ok = await this.perform(
      "Save",
      async () => {
        await this.rpc.call("targeting.saveSuggestions", { suggestionId, component: c, items });
        return `${SUGGEST_TITLES[c]}: picks saved. Nothing is approved yet.`;
      },
      false,
    );
    if (ok) {
      this.#setPicker(c, (p) => ({ ...p, base: items }));
      await this.load();
    }
  }

  async #approvePicks(c: TargetingSuggestComponent): Promise<void> {
    const picker = this.pickers?.[c];
    if (!picker?.suggestionId) return;
    const check = await this.#checkPicks(c);
    if (!check) return;
    const errors = check.issues.filter((i) => i.severity === "error");
    if (errors.length > 0) {
      this.notice = { tone: "bad", text: `Fix ${errors.length} issue(s) in ${SUGGEST_TITLES[c].toLowerCase()} first.` };
      return;
    }
    const items = pickedItems(picker.list);
    const suggestionId = picker.suggestionId;
    let proposal: { proposalId: string; detail: string; digest: string };
    try {
      proposal = await this.rpc.call("targeting.proposeAdditions", { suggestionId, component: c, items });
    } catch (err) {
      this.notice = { tone: "bad", text: `Proposing failed. ${describeError(err)}` };
      return;
    }
    const answer = await confirmAction({
      title: `Approve ${items.length} new ${items.length === 1 ? SUGGEST_ONE[c] : SUGGEST_TITLES[c].toLowerCase()}`,
      body: html`<p class="small muted">Approving keeps every ${c} item served now and adds the ${items.length} you picked, as exactly this file. From then on they steer ${STEERS[c]}. It is also listed in the Proposals view until it is decided.</p>
        <pre class="text draft-body">${proposal.detail}</pre>`,
      confirmLabel: "Approve",
    });
    if (!answer.confirmed) {
      this.notice = { tone: "ok", text: "Not approved. The proposal stays in the Proposals view until it is decided or expires." };
      return;
    }
    const ok = await this.perform("Approve", async () => {
      const result = await this.rpc.call("proposals.approve", { id: proposal.proposalId, shownDigest: proposal.digest });
      return result.message ?? `Proposal ${result.status}.`;
    }, false);
    if (ok) {
      // The picks are served now: clear them, so the picker starts empty.
      await settle(this.rpc.call("targeting.saveSuggestions", { suggestionId, component: c, items: [] }));
      this.#setPicker(c, (p) => ({ ...p, list: p.list.map((x) => ({ ...x, picked: false })), base: [], check: null }));
      await this.load();
    }
  }

  async #discardSuggestion(): Promise<void> {
    if (this.state.state !== "ok" || !this.state.value.suggestion) return;
    const id = this.state.value.suggestion.id;
    const answer = await confirmAction({ title: "Discard the suggestions", body: html`<p>Drop these suggestions and your saved picks? What is approved does not change.</p>`, confirmLabel: "Discard", danger: true });
    if (!answer.confirmed) return;
    this.pickers = null;
    await this.perform("Discard", async () => {
      await this.rpc.call("targeting.discardSuggestions", { suggestionId: id });
      return "Discarded.";
    });
  }

  #renderReadiness(s: TargetingState) {
    const r = s.readiness;
    return html`<section class="card" aria-labelledby="t-ready">
      <h2 id="t-ready">Readiness</h2>
      <ul class="plain">${readinessLines(r).map((l) => html`<li class=${l.tone === "warn" ? "error" : l.tone === "off" ? "muted" : ""}>${l.text}</li>`)}</ul>
      ${r
        ? html`<details><summary class="small">What each part of the brain steers</summary>
            <ul class="plain small">${(["product", "icp", "personas", "keyword-portfolio"] as const).map((c) => {
              const part = r.components[c];
              const state = part.served ? `version ${part.version ?? "?"}, ${part.items} item(s)` : part.unverified ? "does not match the brain's lock" : "not approved";
              return html`<li><span class="mono">${c}</span> (${state}): steers ${STEERS[c]}.</li>`;
            })}</ul>
          </details>`
        : nothing}
    </section>`;
  }

  #renderPick(c: TargetingSuggestComponent, p: Picker["list"][number], writable: boolean) {
    const id = `t-${c}-pick-${p.id}`;
    const edit = (field: string) => (e: Event) => this.#setPicker(c, (x) => ({ ...x, list: editPick(x.list, c, p.id, field, (e.target as HTMLInputElement | HTMLTextAreaElement).value), check: null }));
    const changed = (field: string) => p.fields[field] !== p.suggested[field];
    return html`<li class="stack">
      <div class="row">
        <label for="${id}" class="small"><input id="${id}" type="checkbox" .checked=${p.picked} ?disabled=${!writable} @change=${() => this.#setPicker(c, (x) => ({ ...x, list: togglePick(x.list, p.id), check: null }))} /> Pick</label>
        ${READONLY_FIELDS[c].filter((f) => p.fields[f]).map((f) => html`<span class="pill">${f}: ${p.fields[f]}</span>`)}
        <span class="pill">Suggested by the model</span>
        ${SUGGEST_EDITABLE[c].some(changed) ? html`<span class="pill">Edited</span>` : nothing}
      </div>
      ${SUGGEST_EDITABLE[c].map(
        (f) => html`<label for="${id}-${f}" class="small">${f === "query" ? "Query" : f === "titles" ? "Titles, comma separated" : "What they care about"}</label>
          <textarea id="${id}-${f}" rows=${f === "titles" ? 1 : 2} .value=${p.fields[f] ?? ""} ?disabled=${!writable} @input=${edit(f)}></textarea>`,
      )}
    </li>`;
  }

  #renderSuggestions(s: TargetingState) {
    const writes = s.flags.enabled;
    const basics = Boolean(s.readiness?.components.product.served && s.readiness.components.icp.served);
    const canSuggest = writes && s.flags.suggest && s.draftAvailable && basics;
    const sg = s.suggestion;
    const why = !writes
      ? "The page is read only: targeting:enabled is off."
      : !s.draftAvailable
        ? "No model gateway is wired, so suggestions cannot run."
        : !s.flags.suggest
          ? "Suggestions are off (targeting:suggest_enabled). You can still write search queries and personas in your brain folder."
          : !basics
            ? "Approve a product description and an ICP first: suggestions read only those."
            : "";
    return html`<section class="card spaced" aria-labelledby="t-suggest">
      <h2 id="t-suggest">Search queries and personas</h2>
      <p class="small muted">Suggestions read only your approved product and ICP. Pick the ones that fit, edit their wording, then review and approve. Every query and persona already approved is kept.</p>
      ${why ? html`<p class="muted">${why}</p>` : nothing}
      <div class="row">
        <button type="button" @click=${() => void this.#suggest()} ?disabled=${!canSuggest || this.suggesting || this.busy}>Suggest search queries and personas</button>
        ${sg && writes ? html`<button type="button" @click=${() => void this.#discardSuggestion()} ?disabled=${this.busy}>Discard suggestions</button>` : nothing}
      </div>
      ${this.suggesting ? html`<p class="muted" aria-busy="true">Suggesting. This takes up to a minute.</p>` : nothing}
      ${sg ? html`<p class="small">Suggested ${formatDateTime(sg.startedAt)}: <strong>${sg.status}</strong>${sg.reason ? html`. ${sg.reason}` : nothing}</p>` : nothing}
      ${sg && sg.dropped.length
        ? html`<details><summary class="small">Left out of the suggestions (${sg.dropped.length})</summary><ul class="plain small">${sg.dropped.map((x) => html`<li>${x.component}: ${x.reason}${x.preview ? html` <span class="muted">"${x.preview}"</span>` : nothing}</li>`)}</ul></details>`
        : nothing}
      ${SUGGESTED.map((c) => {
        const picker = this.pickers?.[c];
        const served = s.served?.[c].items ?? [];
        const servedIds = new Set(served.map((i) => i.id));
        // A suggestion already approved is in "Approved now"; it is not offered again.
        const open = picker ? picker.list.filter((p) => !servedIds.has(p.id)) : [];
        const picked = picker ? pickedItems(picker.list).length : 0;
        const check = picker?.check ?? null;
        const tight = check?.budgets.reduce<{ task: string; bytes: number; room: number } | null>((m, b) => (m === null || b.room < m.room ? b : m), null);
        return html`<div class="spaced">
          <h3>${SUGGEST_TITLES[c]}</h3>
          <details><summary class="small">Approved now (${served.length})</summary>
            <ul class="plain small">${served.map((i) => html`<li><span class="mono">${i.id}</span>: ${c === "personas" ? `${i.fields.titles ?? ""} (${i.fields.role ?? ""})` : `${i.fields.query ?? ""} (${i.fields.intent ?? ""})`}</li>`)}</ul>
          </details>
          ${picker && open.length
            ? html`<ul class="plain stack">${open.map((p) => this.#renderPick(c, p, writes))}</ul>
                ${this.#picksDirty(c) ? html`<p class="small">Unsaved picks.</p>` : nothing}
                ${check
                  ? html`<div class="spaced">
                      ${tight ? html`<p class="small ${tight.bytes > tight.room ? "error" : "muted"}">${tight.bytes} of ${tight.room} bytes in the ${tight.task} slice, the tightest task that reads it</p>` : nothing}
                      ${check.issues.length ? html`<ul class="plain small">${check.issues.map((i) => html`<li class=${i.severity === "error" ? "error" : "muted"}>${i.message}</li>`)}</ul>` : html`<p class="small muted">No issues.</p>`}
                    </div>`
                  : nothing}
                ${writes
                  ? html`<div class="row spaced">
                      <button type="button" @click=${() => void this.#checkPicks(c)} ?disabled=${this.busy || picked === 0}>Check</button>
                      <button type="button" @click=${() => void this.#savePicks(c)} ?disabled=${this.busy || !this.#picksDirty(c)}>Save picks</button>
                      <button type="button" @click=${() => void this.#approvePicks(c)} ?disabled=${this.busy || picked === 0 || !s.approvable}>Review and approve</button>
                    </div>`
                  : nothing}`
            : html`<p class="small muted">${sg?.status === "ready" ? "Nothing new was suggested here." : "No suggestions yet."}</p>`}
        </div>`;
      })}
    </section>`;
  }

  #renderWebsite(s: TargetingState) {
    const writes = s.flags.enabled;
    const canDraft = writes && s.flags.draft && s.draftAvailable;
    const d = s.draft;
    const why = !writes ? "The page is read only: targeting:enabled is off." : !s.draftAvailable ? "No model gateway is wired, so drafts cannot run." : !s.flags.draft ? "AI drafts are off (targeting:draft_enabled). You can still write the items yourself." : "";
    return html`<section class="card" aria-labelledby="t-site">
      <h2 id="t-site">Your website</h2>
      <p class="small muted">${s.company.name}: ${s.company.description}</p>
      ${why ? html`<p class="muted">${why}</p>` : nothing}
      <form class="row" @submit=${(e: Event) => { e.preventDefault(); void this.#draft(); }}>
        <label for="t-url">Website URL <input id="t-url" type="url" .value=${this.url} @input=${(e: Event) => (this.url = (e.target as HTMLInputElement).value)} ?disabled=${!canDraft || this.drafting} /></label>
        <button type="submit" ?disabled=${!canDraft || this.drafting || this.busy}>Draft with AI</button>
        <button type="button" @click=${() => (this.pasting = !this.pasting)} ?disabled=${!canDraft}>Paste text instead</button>
      </form>
      ${this.pasting
        ? html`<form class="stack" @submit=${(e: Event) => { e.preventDefault(); const t = this.renderRoot.querySelector<HTMLTextAreaElement>("#t-paste"); void this.#draft(t?.value ?? ""); }}>
            <label for="t-paste">Text from your site</label>
            <textarea id="t-paste" rows="8" maxlength="24000"></textarea>
            <button type="submit" ?disabled=${this.drafting || this.busy}>Draft from this text</button>
          </form>`
        : nothing}
      ${this.drafting ? html`<p class="muted" aria-busy="true">Reading the site, then drafting. This takes up to a minute.</p>` : nothing}
      ${d
        ? html`<div class="spaced">
            <p class="small">Draft from ${d.url ?? (d.source === "manual" ? "your own edits" : "pasted text")}, ${formatDateTime(d.startedAt)}: <strong>${d.status}</strong>${d.reason ? html`. ${d.reason}` : nothing}</p>
            ${d.pages.length ? html`<p class="small muted">Pages read:</p><ul class="plain small">${d.pages.map((p) => html`<li><span class="mono">${p.url}</span> ${p.title}</li>`)}</ul>` : nothing}
            ${d.skipped.length ? html`<p class="small muted">Not read:</p><ul class="plain small">${d.skipped.map((p) => html`<li><span class="mono">${p.url}</span>: ${p.reason}</li>`)}</ul>` : nothing}
            ${d.dropped.length
              ? html`<details><summary class="small">Left out of the draft (${d.dropped.length})</summary><ul class="plain small">${d.dropped.map((x) => html`<li>${x.component} ${x.kind}: ${x.reason}${x.preview ? html` <span class="muted">"${x.preview}"</span>` : nothing}</li>`)}</ul></details>`
              : nothing}
            ${writes ? html`<button type="button" @click=${() => void this.#discard()} ?disabled=${this.busy}>Discard draft</button>` : nothing}
          </div>`
        : nothing}
    </section>`;
  }

  #renderItem(c: TargetingComponent, item: EditorItem, writable: boolean, served: readonly TargetingItem[]) {
    const id = `t-${c}-${item.key}`;
    const over = item.text.length > TEXT_MAX;
    return html`<li class="stack">
      <div class="row">
        <label for="${id}-kind" class="small">Kind
          <select id="${id}-kind" .value=${item.kind} ?disabled=${!writable} @change=${(e: Event) => this.#edit(c, (l) => updateItem(l, item.key, { kind: (e.target as HTMLSelectElement).value }))}>
            ${KINDS[c].map((k) => html`<option value=${k.kind} ?selected=${k.kind === item.kind}>${k.label}</option>`)}
          </select>
        </label>
        ${item.origin === "drafted" ? html`<span class="pill">Drafted from your site: ${item.basis === "stated" ? "stated" : "inferred"}</span>` : nothing}
        ${item.figures ? html`<span class="pill">States a figure: check it</span>` : nothing}
        ${isApproved(item, served) ? nothing : html`<span class="pill">Not yet approved</span>`}
        ${writable ? html`<button type="button" @click=${() => this.#edit(c, (l) => removeItem(l, item.key))}>Remove</button>` : nothing}
      </div>
      <label for="${id}" class="visually-hidden">${kindLabel(c, item.kind)} text</label>
      <textarea id="${id}" rows="2" .value=${item.text} ?disabled=${!writable} @input=${(e: Event) => this.#edit(c, (l) => updateItem(l, item.key, { text: (e.target as HTMLTextAreaElement).value }))}></textarea>
      <p class="small ${over ? "error" : "muted"}">${item.text.length} of ${TEXT_MAX} characters</p>
      ${c === "icp" && item.kind === "never"
        ? html`<div class="row">${LIST_FIELDS.map(
            (f) => html`<label for="${id}-${f}" class="small">${f}, comma separated
              <input id="${id}-${f}" .value=${item.extra[f] ?? ""} ?disabled=${!writable} @input=${(e: Event) => this.#edit(c, (l) => updateItem(l, item.key, { field: { name: f, value: (e.target as HTMLInputElement).value } }))} />
            </label>`,
          )}</div>`
        : nothing}
    </li>`;
  }

  #renderCard(s: TargetingState, c: TargetingComponent) {
    const editor = this.editors?.[c];
    if (!editor) return nothing;
    const writable = s.flags.enabled;
    const served = s.served?.[c];
    const check = editor.check;
    const tight = check?.budgets.reduce<{ task: string; bytes: number; room: number } | null>((m, b) => (m === null || b.room < m.room ? b : m), null);
    return html`<section class="card spaced" aria-labelledby="t-${c}">
      <div class="row spread">
        <h2 id="t-${c}">${TITLES[c]}</h2>
        <span class="small muted">
          ${served?.content ? html`Approved version ${served.version}, ${served.updated ?? ""}` : "Nothing approved yet"}
          ${reviewDue(served?.updated ?? null, new Date()) ? html` <span class="pill">Over 90 days old: review this</span>` : nothing}
        </span>
      </div>
      ${this.#dirty(c) ? html`<p class="small">Unsaved changes.</p>` : nothing}
      ${grouped(c, editor.items).map(
        (g) => html`<h3>${g.label}</h3>
          <ul class="plain stack">${g.items.map((item) => this.#renderItem(c, item, writable, served?.items ?? []))}</ul>`,
      )}
      ${editor.items.length === 0 ? html`<p class="muted">No items yet.</p>` : nothing}
      ${writable
        ? html`<div class="row">
            <label for="t-${c}-new" class="small">Add
              <select id="t-${c}-new" .value=${editor.newKind} @change=${(e: Event) => this.editors && (this.editors = { ...this.editors, [c]: { ...editor, newKind: (e.target as HTMLSelectElement).value } })}>
                ${KINDS[c].map((k) => html`<option value=${k.kind}>${k.label}</option>`)}
              </select>
            </label>
            <button type="button" @click=${() => this.#edit(c, (l) => addItem(l, editor.newKind))}>Add item</button>
          </div>`
        : nothing}
      ${check
        ? html`<div class="spaced">
            ${tight ? html`<p class="small ${tight.bytes > tight.room ? "error" : "muted"}">${tight.bytes} of ${tight.room} bytes in the ${tight.task} slice, the tightest task that reads it</p>` : nothing}
            ${check.issues.length ? html`<ul class="plain small">${check.issues.map((i) => html`<li class=${i.severity === "error" ? "error" : "muted"}>${i.message}</li>`)}</ul>` : html`<p class="small muted">No issues.</p>`}
          </div>`
        : nothing}
      <div class="row spaced">
        <button type="button" @click=${() => void this.#check(c)} ?disabled=${this.busy}>Check</button>
        ${writable
          ? html`<button type="button" @click=${() => void this.#save(c)} ?disabled=${this.busy || !this.#dirty(c)}>Save draft</button>
              <button type="button" @click=${() => void this.#approve(c)} ?disabled=${this.busy || editor.items.length === 0 || !s.approvable}>Review and approve</button>`
          : nothing}
        ${served?.content
          ? html`<button type="button" @click=${() => void this.#startFromServed(c)}>Start from approved</button>
              <button type="button" @click=${() => void this.#copy(c)}>Copy file</button>`
          : nothing}
      </div>
      ${!s.approvable && writable ? html`<p class="small muted">Approving needs the learning module's dashboard source (learningDashboard() in createWorker).</p>` : nothing}
    </section>`;
  }

  override render() {
    return html`${this.heading("Product and ICP", html`<button @click=${() => void this.load()}>Refresh</button>`)}
      ${this.renderNotice()}
      ${section(this.state, (s) => html`
        ${s.servedError ? html`<p class="error">${s.servedError}</p>` : nothing}
        ${this.#renderReadiness(s)}
        ${this.#renderWebsite(s)}
        ${COMPONENTS.map((c) => this.#renderCard(s, c))}
        ${this.#renderSuggestions(s)}
        <p class="small muted spaced">After approving here, run gtm brain pull before your next gtm brain upload; an upload from older local files stops rather than undo an approval.</p>
      `)}`;
  }
}

customElements.define("gtm-targeting", GtmTargeting);
