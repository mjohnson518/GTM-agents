// GTM-agents: the Activity view: the audit trail, a live stream that can be switched on and off,
// and a CSV export for a date range. The export is saved as a file and never rendered.
import { html } from "lit";
import type { ActivityItem } from "@gtm-agents/core/gateway/protocol";
import { formatDateTime, isoDay } from "../format.ts";
import { addActivity, appendActivity } from "../state.ts";
import { GtmView, describeError } from "./base.ts";

export function renderActivityTable(items: readonly ActivityItem[]) {
  if (items.length === 0) return html`<p class="muted">No activity.</p>`;
  return html`<div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th scope="col">When</th>
          <th scope="col">Kind</th>
          <th scope="col">Actor</th>
          <th scope="col">Summary</th>
          <th scope="col">Ref</th>
        </tr>
      </thead>
      <tbody>
        ${items.map(
          (item) => html`<tr>
            <td>${formatDateTime(item.at)}</td>
            <td class="mono">${item.kind}</td>
            <td>${item.actor}</td>
            <td class="text">${item.summary}</td>
            <td class="mono">${item.ref ? `${item.ref.type} ${item.ref.id}` : ""}</td>
          </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export class GtmActivity extends GtmView {
  static override properties = { items: { state: true }, cursor: { state: true }, kind: { state: true }, liveOn: { state: true }, listError: { state: true } };

  declare items: ActivityItem[] | null;
  declare cursor: string | undefined;
  declare kind: string;
  declare liveOn: boolean;
  declare listError: string;
  #off: (() => void) | null = null;

  constructor() {
    super();
    this.items = null;
    this.cursor = undefined;
    this.kind = "";
    this.liveOn = false;
    this.listError = "";
  }

  override async load(): Promise<void> {
    await this.#page();
    if (this.liveOn) await this.#setLive(true);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.liveOn) void this.#setLive(false);
  }

  async #page(cursor?: string): Promise<void> {
    try {
      const params: { cursor?: string; kind?: string; limit: number } = { limit: 50 };
      if (cursor) params.cursor = cursor;
      if (this.kind) params.kind = this.kind;
      const page = await this.rpc.call("activity.list", params);
      this.items = cursor ? appendActivity(this.items ?? [], page.items) : page.items;
      this.cursor = page.cursor;
      this.listError = "";
    } catch (err) {
      this.listError = describeError(err);
    }
  }

  async #setLive(on: boolean): Promise<void> {
    this.#off?.();
    this.#off = null;
    try {
      if (on && this.client) {
        this.#off = this.client.on("activity", (item) => {
          if (!this.kind || item.kind === this.kind) this.items = addActivity(this.items ?? [], item);
        });
      }
      const result = await this.rpc.call("activity.subscribe", { on });
      this.liveOn = on && result.subscribed;
      if (on && !result.subscribed) this.notice = { tone: "bad", text: "The live stream is not available." };
    } catch (err) {
      this.liveOn = false;
      if (on) this.notice = { tone: "bad", text: `The live stream could not start. ${describeError(err)}` };
    }
    if (!this.liveOn) {
      this.#off?.();
      this.#off = null;
    }
  }

  async #export(event: Event): Promise<void> {
    event.preventDefault();
    const from = this.renderRoot.querySelector<HTMLInputElement>("#x-from")?.value ?? "";
    const to = this.renderRoot.querySelector<HTMLInputElement>("#x-to")?.value ?? "";
    if (!from || !to || from > to) {
      this.notice = { tone: "bad", text: "Choose a start date on or before the end date." };
      return;
    }
    await this.perform(
      "Export",
      async () => {
        const { csv } = await this.rpc.call("activity.export", { from, to });
        download(`activity-${from}-to-${to}.csv`, csv);
        return "The export was saved as a CSV file.";
      },
      false,
    );
  }

  override render() {
    const now = new Date();
    return html`${this.heading("Activity", html`<button @click=${() => void this.#page()}>Refresh</button>`)}
      ${this.renderNotice()}
      <div class="row">
        <label for="a-kind"
          >Kind
          <input
            id="a-kind"
            type="search"
            .value=${this.kind}
            @change=${(event: Event) => {
              this.kind = (event.target as HTMLInputElement).value.trim();
              void this.#page();
            }}
          />
        </label>
        <label for="a-live" class="inline">
          <input id="a-live" type="checkbox" .checked=${this.liveOn} @change=${(event: Event) => void this.#setLive((event.target as HTMLInputElement).checked)} />
          Live stream
        </label>
      </div>
      <form class="row spaced card" @submit=${(event: Event) => void this.#export(event)} aria-label="Export">
        <label for="x-from">From <input id="x-from" type="date" .value=${isoDay(now, 7)} /></label>
        <label for="x-to">To <input id="x-to" type="date" .value=${isoDay(now)} /></label>
        <button type="submit" ?disabled=${this.busy}>Export CSV</button>
      </form>
      ${this.listError ? html`<p class="error">Activity could not be read: ${this.listError}</p>` : ""}
      <div class="spaced">${this.items === null ? html`<p class="muted" aria-busy="true">Loading...</p>` : renderActivityTable(this.items)}</div>
      ${this.cursor ? html`<p><button @click=${() => void this.#page(this.cursor)}>Load more</button></p>` : ""}`;
  }
}

customElements.define("gtm-activity", GtmActivity);
