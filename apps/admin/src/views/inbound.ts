// GTM-agents: the Inbound view: totals, the email list, and the reply drafts. Sending or approving
// a draft echoes the digest of exactly the draft the operator was shown, so the server refuses it
// if the stored text changed in between. Mail text is from outside and is only ever shown as text.
import { html } from "lit";
import type { DraftView, MethodResult } from "@gtm-agents/core/gateway/protocol";
import { formatDateTime, humanizeKey, shortDigest } from "../format.ts";
import { barChart } from "../ui/charts.ts";
import { confirmAction } from "../ui/dialog.ts";
import { GtmView, LOADING, describeError, section, settle } from "./base.ts";
import type { Loadable } from "./base.ts";

type Inbound = MethodResult<"inbound.list">["items"][number];
type ItemAction = "archive" | "ignore" | "done";

const STATUS_FILTERS = ["", "new", "drafted", "done", "archived", "ignored"] as const;

/** The draft exactly as it will be sent: recipient, subject, body and the digest that binds them. */
export function renderDraft(draft: DraftView) {
  return html`<dl>
      <dt>To</dt>
      <dd class="text">${draft.to}</dd>
      <dt>Subject</dt>
      <dd class="text">${draft.subject}</dd>
      <dt>Status</dt>
      <dd>${draft.status}</dd>
      <dt>Digest</dt>
      <dd class="mono" title=${draft.digest}>${shortDigest(draft.digest)}</dd>
    </dl>
    <pre class="text draft-body">${draft.body}</pre>`;
}

export class GtmInbound extends GtmView {
  static override properties = { stats: { state: true }, items: { state: true }, cursor: { state: true }, filter: { state: true }, listError: { state: true } };

  declare stats: Loadable<MethodResult<"inbound.stats">>;
  declare items: Inbound[] | null;
  declare cursor: string | undefined;
  declare filter: string;
  declare listError: string;

  constructor() {
    super();
    this.stats = LOADING;
    this.items = null;
    this.cursor = undefined;
    this.filter = "";
    this.listError = "";
  }

  override async load(): Promise<void> {
    this.stats = await settle(this.rpc.call("inbound.stats", {}));
    await this.#list();
  }

  async #list(cursor?: string): Promise<void> {
    try {
      const params: { status?: string; cursor?: string } = {};
      if (this.filter) params.status = this.filter;
      if (cursor) params.cursor = cursor;
      const page = await this.rpc.call("inbound.list", params);
      this.items = cursor ? [...(this.items ?? []), ...page.items] : page.items;
      this.cursor = page.cursor;
      this.listError = "";
    } catch (err) {
      this.listError = describeError(err);
    }
  }

  async #itemAction(item: Inbound, action: ItemAction): Promise<void> {
    const verbs: Record<ItemAction, string> = { archive: "Archive", ignore: "Ignore", done: "Mark done" };
    const answer = await confirmAction({
      title: `${verbs[action]} this email`,
      body: html`<p class="small">From <span class="text">${item.from}</span>: <span class="text">${item.subject}</span></p>`,
      confirmLabel: verbs[action],
      danger: action === "ignore",
    });
    if (!answer.confirmed) return;
    await this.perform(verbs[action], async () => {
      await this.rpc.call("inbound.action", { id: item.id, action });
    });
  }

  /** Sends the draft that was on screen. `shown` is captured when the button is pressed. */
  async #send(shown: DraftView): Promise<void> {
    const answer = await confirmAction({
      title: "Send this reply",
      body: html`<p class="small muted">This exact text is sent. If it changed since it was loaded, the send is refused.</p>
        ${renderDraft(shown)}`,
      confirmLabel: "Send reply",
    });
    if (!answer.confirmed) return;
    await this.perform("Send reply", async () => {
      const result = await this.rpc.call("inbound.draftSend", { draftId: shown.id, shownDigest: shown.digest });
      return result.message ? `${humanizeKey(result.status)}: ${result.message}` : `Reply ${humanizeKey(result.status).toLowerCase()}.`;
    });
  }

  async #approve(shown: DraftView): Promise<void> {
    const answer = await confirmAction({
      title: "Approve this reply",
      body: html`<p class="small muted">Approval covers this exact text; the send path sends it later with its own checks.</p>
        ${renderDraft(shown)}`,
      confirmLabel: "Approve",
    });
    if (!answer.confirmed) return;
    await this.perform("Approve reply", async () => {
      const result = await this.rpc.call("drafts.approve", { draftId: shown.id, shownDigest: shown.digest });
      return result.message ? `${humanizeKey(result.status)}: ${result.message}` : `Reply ${humanizeKey(result.status).toLowerCase()}.`;
    });
  }

  async #reject(shown: DraftView): Promise<void> {
    const answer = await confirmAction({
      title: "Reject this reply",
      fields: [{ name: "reason", label: "Reason", multiline: true }],
      confirmLabel: "Reject",
      danger: true,
    });
    if (!answer.confirmed) return;
    await this.perform("Reject reply", async () => {
      const params: { draftId: string; reason?: string } = { draftId: shown.id };
      if (answer.values.reason) params.reason = answer.values.reason;
      await this.rpc.call("drafts.reject", params);
    });
  }

  #item(item: Inbound) {
    const draft = item.draft;
    return html`<li class="card">
      <article aria-labelledby="m-${item.id}">
        <div class="row spread">
          <h2 id="m-${item.id}" class="text">${item.subject || "(no subject)"}</h2>
          <span class="pill">${item.status}</span>
        </div>
        <p class="small"><span class="text">${item.from}</span> <span class="muted">${formatDateTime(item.receivedAt)}</span></p>
        <p class="row">
          ${item.classification ? html`<span class="pill">${item.classification}</span>` : ""}
          ${item.intent ? html`<span class="pill">${item.intent}</span>` : ""}
        </p>
        <p class="text small">${item.preview}</p>
        ${draft
          ? html`<details>
              <summary>Draft reply (${draft.status})</summary>
              ${renderDraft(draft)}
              <div class="row">
                <button class="primary" @click=${() => void this.#send(draft)} ?disabled=${this.busy}>Send draft</button>
                <button @click=${() => void this.#approve(draft)} ?disabled=${this.busy}>Approve only</button>
                <button class="danger" @click=${() => void this.#reject(draft)} ?disabled=${this.busy}>Reject draft</button>
              </div>
            </details>`
          : ""}
        <div class="row spaced">
          <button @click=${() => void this.#itemAction(item, "archive")} ?disabled=${this.busy}>Archive</button>
          <button @click=${() => void this.#itemAction(item, "ignore")} ?disabled=${this.busy}>Ignore</button>
          <button @click=${() => void this.#itemAction(item, "done")} ?disabled=${this.busy}>Mark done</button>
        </div>
      </article>
    </li>`;
  }

  override render() {
    return html`${this.heading("Inbound", html`<button @click=${() => void this.load()}>Refresh</button>`)}
      ${this.renderNotice()}
      <section class="card" aria-labelledby="i-totals">
        <h2 id="i-totals">Totals</h2>
        ${section(this.stats, (stats) =>
          barChart(
            Object.entries(stats).map(([label, value]) => ({ label: humanizeKey(label), value })),
            "Inbound totals",
          ),
        )}
      </section>
      <div class="row spaced">
        <label for="i-filter"
          >Status
          <select
            id="i-filter"
            .value=${this.filter}
            @change=${(event: Event) => {
              this.filter = (event.target as HTMLSelectElement).value;
              void this.#list();
            }}
          >
            ${STATUS_FILTERS.map((status) => html`<option value=${status}>${status ? humanizeKey(status) : "All"}</option>`)}
          </select>
        </label>
      </div>
      ${this.listError ? html`<p class="error">The email list could not be read: ${this.listError}</p>` : ""}
      ${this.items === null
        ? ""
        : this.items.length === 0
          ? html`<p class="muted">No email matches.</p>`
          : html`<ul class="plain spaced">
              ${this.items.map((item) => this.#item(item))}
            </ul>`}
      ${this.cursor ? html`<p><button @click=${() => void this.#list(this.cursor)}>Load more</button></p>` : ""}`;
  }
}

customElements.define("gtm-inbound", GtmInbound);
