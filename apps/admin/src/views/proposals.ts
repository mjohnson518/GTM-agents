// GTM-agents: the Proposals and Learning views. Approving echoes the digest of the detail text the
// operator was shown. A two-step proposal (an autonomy change, an experiment start) first shows
// the full record, then asks for its confirm code before anything is sent. Every proposal can be
// rejected; rejecting an autonomy proposal dismisses it, which changes no level and leaves it
// impossible to confirm.
import { html } from "lit";
import type { MethodResult, Proposal } from "@gtm-agents/core/gateway/protocol";
import { formatDateTime, humanizeKey, shortDigest } from "../format.ts";
import { rejectConsequence } from "../state.ts";
import { confirmAction } from "../ui/dialog.ts";
import { renderValue } from "../ui/record.ts";
import { GtmView, LOADING, describeError, section, settle } from "./base.ts";
import type { Loadable } from "./base.ts";

const SOURCES: ReadonlyArray<Proposal["source"]> = ["autonomy", "experiment", "learning", "brain", "copy", "self_review"];

function renderRecord(proposal: Proposal, withCode: boolean) {
  return html`<dl>
      <dt>Title</dt>
      <dd class="text">${proposal.title}</dd>
      <dt>Source</dt>
      <dd>${humanizeKey(proposal.source)}</dd>
      <dt>Created</dt>
      <dd>${formatDateTime(proposal.createdAt)}</dd>
      ${proposal.expiresAt ? html`<dt>Expires</dt><dd>${formatDateTime(proposal.expiresAt)}</dd>` : ""}
      <dt>Digest</dt>
      <dd class="mono" title=${proposal.digest}>${shortDigest(proposal.digest)}</dd>
      ${withCode && proposal.confirmCode ? html`<dt>Confirm code</dt><dd class="mono">${proposal.confirmCode}</dd>` : ""}
    </dl>
    <pre class="text draft-body">${proposal.detail}</pre>`;
}

/** The approve and reject flows, shared by both views. */
async function approveFlow(view: GtmView, shown: Proposal): Promise<void> {
  if (shown.confirmCode) {
    const review = await confirmAction({
      title: "Review the proposal",
      body: html`<p class="small muted">This change takes two steps. Read the record, then confirm it with its code.</p>
        ${renderRecord(shown, true)}`,
      confirmLabel: "Continue",
    });
    if (!review.confirmed) return;
    const code = shown.confirmCode;
    const confirm = await confirmAction({
      title: "Confirm the change",
      body: html`<p class="text">${shown.title}</p>
        <p class="small muted">Type the confirm code shown with the record.</p>`,
      fields: [{ name: "code", label: "Confirm code", required: true }],
      validate: (values) => (values.code === code ? null : "The code does not match the record."),
      confirmLabel: "Apply change",
      danger: true,
    });
    if (!confirm.confirmed) return;
    await view.perform("Approve", async () => {
      const result = await view.rpc.call("proposals.approve", { id: shown.id, shownDigest: shown.digest, confirmCode: confirm.values.code ?? "" });
      return result.message ? `${humanizeKey(result.status)}: ${result.message}` : `Proposal ${humanizeKey(result.status).toLowerCase()}.`;
    });
    return;
  }
  const answer = await confirmAction({
    title: "Approve the proposal",
    body: html`<p class="small muted">Approving applies exactly this text.</p>
      ${renderRecord(shown, false)}`,
    confirmLabel: "Approve",
  });
  if (!answer.confirmed) return;
  await view.perform("Approve", async () => {
    const result = await view.rpc.call("proposals.approve", { id: shown.id, shownDigest: shown.digest });
    return result.message ? `${humanizeKey(result.status)}: ${result.message}` : `Proposal ${humanizeKey(result.status).toLowerCase()}.`;
  });
}

async function rejectFlow(view: GtmView, shown: Proposal): Promise<void> {
  const answer = await confirmAction({
    title: "Reject the proposal",
    body: html`<p class="text">${shown.title}</p>
      <p class="small muted">${rejectConsequence(shown.source)}</p>`,
    fields: [{ name: "reason", label: "Reason", multiline: true }],
    confirmLabel: "Reject",
    danger: true,
  });
  if (!answer.confirmed) return;
  await view.perform("Reject", async () => {
    const params: { id: string; reason?: string } = { id: shown.id };
    if (answer.values.reason) params.reason = answer.values.reason;
    await view.rpc.call("proposals.reject", params);
    return shown.source === "autonomy" ? "Proposal dismissed. No level changed." : "Proposal rejected.";
  });
}

function renderProposals(view: GtmView, proposals: Proposal[]) {
  if (proposals.length === 0) return html`<p class="muted">Nothing pending.</p>`;
  return html`<ul class="plain">
    ${proposals.map(
      (proposal) => html`<li class="card">
        <article aria-labelledby="p-${proposal.id}">
          <div class="row spread">
            <h3 id="p-${proposal.id}" class="text">${proposal.title}</h3>
            <span class="pill">${humanizeKey(proposal.source)}${proposal.confirmCode ? ", two-step" : ""}</span>
          </div>
          <p class="small muted">
            Created ${formatDateTime(proposal.createdAt)}${proposal.expiresAt ? html`, expires ${formatDateTime(proposal.expiresAt)}` : ""}
          </p>
          <pre class="text draft-body">${proposal.detail}</pre>
          <div class="row">
            <button class="primary" @click=${() => void approveFlow(view, proposal)} ?disabled=${view.busy}>
              ${proposal.confirmCode ? "Review and confirm" : "Approve"}
            </button>
            <button class="danger" @click=${() => void rejectFlow(view, proposal)} ?disabled=${view.busy}>Reject</button>
          </div>
        </article>
      </li>`,
    )}
  </ul>`;
}

export class GtmProposals extends GtmView {
  static override properties = { proposals: { state: true }, source: { state: true } };

  declare proposals: Loadable<Proposal[]>;
  declare source: Proposal["source"] | "";

  constructor() {
    super();
    this.proposals = LOADING;
    this.source = "";
  }

  override async load(): Promise<void> {
    this.proposals = await settle(this.rpc.call("proposals.list", this.source ? { source: this.source } : {}));
  }

  override render() {
    return html`${this.heading("Proposals", html`<button @click=${() => void this.load()}>Refresh</button>`)}
      ${this.renderNotice()}
      <div class="row">
        <label for="p-source"
          >Source
          <select
            id="p-source"
            .value=${this.source}
            @change=${(event: Event) => {
              this.source = (event.target as HTMLSelectElement).value as Proposal["source"] | "";
              void this.load();
            }}
          >
            <option value="">All</option>
            ${SOURCES.map((source) => html`<option value=${source}>${humanizeKey(source)}</option>`)}
          </select>
        </label>
      </div>
      <div class="spaced">${section(this.proposals, (list) => renderProposals(this, list))}</div>`;
  }
}

export class GtmLearning extends GtmView {
  static override properties = { summary: { state: true }, proposals: { state: true }, query: { state: true }, results: { state: true }, searchError: { state: true } };

  declare summary: Loadable<MethodResult<"learning.summary">>;
  declare proposals: Loadable<Proposal[]>;
  declare query: string;
  declare results: MethodResult<"learning.historySearch"> | null;
  declare searchError: string;

  constructor() {
    super();
    this.summary = LOADING;
    this.proposals = LOADING;
    this.query = "";
    this.results = null;
    this.searchError = "";
  }

  override async load(): Promise<void> {
    const [summary, proposals] = await Promise.all([settle(this.rpc.call("learning.summary", {})), settle(this.rpc.call("learning.list", { status: "pending" }))]);
    this.summary = summary;
    this.proposals = proposals;
  }

  async #search(event: Event): Promise<void> {
    event.preventDefault();
    const input = this.renderRoot.querySelector<HTMLInputElement>("#l-q");
    const q = input?.value.trim() ?? "";
    this.query = q;
    if (!q) return;
    try {
      this.results = await this.rpc.call("learning.historySearch", { q, limit: 25 });
      this.searchError = "";
    } catch (err) {
      this.searchError = describeError(err);
    }
  }

  override render() {
    return html`${this.heading("Learning", html`<button @click=${() => void this.load()}>Refresh</button>`)}
      ${this.renderNotice()}
      <section class="card" aria-labelledby="l-summary">
        <h2 id="l-summary">Summary</h2>
        ${section(this.summary, (summary) => renderValue(summary))}
      </section>
      <section class="spaced" aria-labelledby="l-pending">
        <h2 id="l-pending">Pending proposals</h2>
        ${section(this.proposals, (list) => renderProposals(this, list))}
      </section>
      <section class="card spaced" aria-labelledby="l-search">
        <h2 id="l-search">Session search</h2>
        <form class="row" @submit=${(event: Event) => void this.#search(event)}>
          <label for="l-q">Search past sessions <input id="l-q" type="search" .value=${this.query} /></label>
          <button type="submit">Search</button>
        </form>
        ${this.searchError ? html`<p class="error">The search failed: ${this.searchError}</p>` : ""}
        ${this.results === null
          ? ""
          : this.results.length === 0
            ? html`<p class="muted">No sessions match.</p>`
            : html`<ul class="plain spaced">
                ${this.results.map(
                  (hit) => html`<li>
                    <p class="small muted"><span class="mono">${hit.sessionKey}</span> ${formatDateTime(hit.at)}</p>
                    <p class="text">${hit.snippet}</p>
                  </li>`,
                )}
              </ul>`}
      </section>`;
  }
}

customElements.define("gtm-proposals", GtmProposals);
customElements.define("gtm-learning", GtmLearning);
