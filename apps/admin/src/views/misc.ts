// GTM-agents: the Link triage and Changelog views. Link triage is an optional module, so the view
// says plainly when it is not installed; the changelog lists every release with a search box and
// an area filter.
import { html } from "lit";
import type { MethodResult } from "@gtm-agents/core/gateway/protocol";
import { formatDateTime, humanizeKey } from "../format.ts";
import { renderValue } from "../ui/record.ts";
import { GtmView, LOADING, section, settle } from "./base.ts";
import type { Loadable } from "./base.ts";

export class GtmLinkTriage extends GtmView {
  static override properties = { status: { state: true } };

  declare status: Loadable<MethodResult<"linkTriage.status">>;

  constructor() {
    super();
    this.status = LOADING;
  }

  override async load(): Promise<void> {
    this.status = LOADING;
    this.status = await settle(this.rpc.call("linkTriage.status", {}));
  }

  override render() {
    return html`${this.heading("Link triage", html`<button @click=${() => void this.load()}>Refresh</button>`)}
      ${section(this.status, (status) =>
        status.installed
          ? html`<section class="card">${status.detail ? renderValue(status.detail) : html`<p class="muted">Installed. No detail reported.</p>`}</section>`
          : html`<p class="banner">Link triage is not installed on this deployment. It is the optional link-intake module; install it and turn its flag on to use this view.</p>`,
      )}`;
  }
}

type Entry = MethodResult<"changelog.list">[number];

export class GtmChangelog extends GtmView {
  static override properties = { entries: { state: true }, areas: { state: true }, q: { state: true }, area: { state: true } };

  declare entries: Loadable<Entry[]>;
  declare areas: string[];
  declare q: string;
  declare area: string;

  constructor() {
    super();
    this.entries = LOADING;
    this.areas = [];
    this.q = "";
    this.area = "";
  }

  override async load(): Promise<void> {
    const params: { q?: string; area?: string } = {};
    if (this.q) params.q = this.q;
    if (this.area) params.area = this.area;
    this.entries = await settle(this.rpc.call("changelog.list", params));
    if (this.entries.state === "ok" && !this.q && !this.area) this.areas = [...new Set(this.entries.value.map((entry) => entry.area))].sort();
  }

  override render() {
    return html`${this.heading("Changelog")}
      <form
        class="row"
        role="search"
        @submit=${(event: Event) => {
          event.preventDefault();
          this.q = this.renderRoot.querySelector<HTMLInputElement>("#c-q")?.value.trim() ?? "";
          void this.load();
        }}
      >
        <label for="c-q">Search <input id="c-q" type="search" .value=${this.q} /></label>
        <label for="c-area"
          >Area
          <select
            id="c-area"
            .value=${this.area}
            @change=${(event: Event) => {
              this.area = (event.target as HTMLSelectElement).value;
              void this.load();
            }}
          >
            <option value="">All areas</option>
            ${this.areas.map((area) => html`<option value=${area}>${humanizeKey(area)}</option>`)}
          </select>
        </label>
        <button type="submit">Search</button>
      </form>
      <div class="spaced">
        ${section(this.entries, (entries) =>
          entries.length === 0
            ? html`<p class="muted">No entries match.</p>`
            : html`<ul class="plain">
                ${entries.map(
                  (entry) => html`<li class="card">
                    <p class="row"><strong>${entry.version}</strong> <span class="muted small">${formatDateTime(entry.date)}</span> <span class="pill">${entry.area}</span></p>
                    <p class="text">${entry.text}</p>
                  </li>`,
                )}
              </ul>`,
        )}
      </div>`;
  }
}

customElements.define("gtm-link-triage", GtmLinkTriage);
customElements.define("gtm-changelog", GtmChangelog);
