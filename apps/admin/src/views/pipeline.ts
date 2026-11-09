// GTM-agents: the Pipeline view: a kanban across deal stages with the total, the weighted forecast
// and the win rate, and create, update and transition. Moving a deal uses a stage picker rather
// than drag and drop, so it works from the keyboard; the server decides which moves are allowed.
import { css, html } from "lit";
import type { MethodResult } from "@gtm-agents/core/gateway/protocol";
import { formatDateTime, formatNumber, formatRate, humanizeKey } from "../format.ts";
import { navigate } from "../router.ts";
import { groupByStage, stageOrder } from "../state.ts";
import { barChart } from "../ui/charts.ts";
import { confirmAction } from "../ui/dialog.ts";
import { sharedStyles } from "../styles.ts";
import { GtmView, LOADING, describeError, section, settle } from "./base.ts";
import type { Loadable } from "./base.ts";

type Deal = MethodResult<"pipeline.deals">["items"][number];

function parseValue(raw: string | undefined): number | undefined | null {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export class GtmPipeline extends GtmView {
  static override properties = { summary: { state: true }, deals: { state: true }, cursor: { state: true }, dealsError: { state: true } };

  // Kanban columns scroll sideways on narrow screens instead of squeezing the cards.
  static override styles = [
    sharedStyles,
    css`
    .kanban {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(13rem, 1fr);
      gap: 0.75rem;
      overflow-x: auto;
      padding-bottom: 0.5rem;
    }
    .column {
      background: var(--surface-2);
      border-radius: var(--radius);
      padding: 0.6rem;
      min-height: 6rem;
    }
    .deal {
      padding: 0.6rem;
    }
    .deal p {
      margin: 0 0 0.3rem;
    }
  `,
  ];

  declare summary: Loadable<MethodResult<"pipeline.summary">>;
  declare deals: Deal[] | null;
  declare cursor: string | undefined;
  declare dealsError: string;

  constructor() {
    super();
    this.summary = LOADING;
    this.deals = null;
    this.cursor = undefined;
    this.dealsError = "";
  }

  override async load(): Promise<void> {
    this.summary = await settle(this.rpc.call("pipeline.summary", {}));
    try {
      const page = await this.rpc.call("pipeline.deals", {});
      this.deals = page.items;
      this.cursor = page.cursor;
      this.dealsError = "";
    } catch (err) {
      this.dealsError = describeError(err);
    }
  }

  async #more(): Promise<void> {
    if (!this.cursor) return;
    try {
      const page = await this.rpc.call("pipeline.deals", { cursor: this.cursor });
      const seen = new Set((this.deals ?? []).map((deal) => deal.id));
      this.deals = [...(this.deals ?? []), ...page.items.filter((deal) => !seen.has(deal.id))];
      this.cursor = page.cursor;
    } catch (err) {
      this.dealsError = describeError(err);
    }
  }

  async #create(): Promise<void> {
    const answer = await confirmAction({
      title: "Create a deal",
      fields: [
        { name: "contactId", label: "Contact id", required: true },
        { name: "value", label: "Value", type: "number" },
        { name: "notes", label: "Notes", multiline: true },
      ],
      validate: (values) => (parseValue(values.value) === null ? "Value must be a number of zero or more." : null),
      confirmLabel: "Create deal",
    });
    if (!answer.confirmed) return;
    const value = parseValue(answer.values.value);
    await this.perform("Create deal", async () => {
      const params: { contactId: string; value?: number; notes?: string } = { contactId: answer.values.contactId ?? "" };
      if (typeof value === "number") params.value = value;
      if (answer.values.notes) params.notes = answer.values.notes;
      const result = await this.rpc.call("pipeline.create", params);
      return `Created deal ${result.id}.`;
    });
  }

  async #update(deal: Deal): Promise<void> {
    const answer = await confirmAction({
      title: "Update the deal",
      body: html`<p class="small muted">Deal <span class="mono">${deal.id}</span>${deal.accountKey ? html`, account ${deal.accountKey}` : ""}.</p>`,
      fields: [
        { name: "value", label: "Value", type: "number", value: deal.value === null ? "" : String(deal.value) },
        { name: "notes", label: "Notes", multiline: true },
      ],
      validate: (values) => (parseValue(values.value) === null ? "Value must be a number of zero or more." : !values.value && !values.notes ? "Change the value or add a note." : null),
      confirmLabel: "Save",
    });
    if (!answer.confirmed) return;
    const value = parseValue(answer.values.value);
    await this.perform("Update deal", async () => {
      const params: { dealId: string; value?: number; notes?: string } = { dealId: deal.id };
      if (typeof value === "number") params.value = value;
      if (answer.values.notes) params.notes = answer.values.notes;
      await this.rpc.call("pipeline.update", params);
      return "Deal updated.";
    });
  }

  async #transition(deal: Deal, stages: string[]): Promise<void> {
    const options = stages.filter((stage) => stage !== deal.stage);
    const answer = await confirmAction({
      title: "Move the deal",
      body: html`<p class="small muted">Deal <span class="mono">${deal.id}</span> is in ${humanizeKey(deal.stage)}.</p>`,
      fields: [
        { name: "to", label: "New stage", required: true, options, value: options[0] ?? "" },
        { name: "reason", label: "Reason", multiline: true },
      ],
      confirmLabel: "Move deal",
    });
    if (!answer.confirmed) return;
    await this.perform("Move deal", async () => {
      const params: { dealId: string; to: string; reason?: string } = { dealId: deal.id, to: answer.values.to ?? "" };
      if (answer.values.reason) params.reason = answer.values.reason;
      const result = await this.rpc.call("pipeline.transition", params);
      return `Deal moved to ${humanizeKey(result.stage)}.`;
    });
  }

  #card(deal: Deal, stages: string[]) {
    return html`<li class="card deal">
      <p><strong>${deal.accountKey ?? "No account"}</strong></p>
      <p class="small">Value ${formatNumber(deal.value)}</p>
      <p class="small muted">Updated ${formatDateTime(deal.updatedAt)}</p>
      <div class="row">
        <button @click=${() => void this.#update(deal)} ?disabled=${this.busy}>Edit</button>
        <button @click=${() => void this.#transition(deal, stages)} ?disabled=${this.busy}>Move</button>
        ${deal.contactId
          ? html`<button
              @click=${() => {
                if (deal.contactId) navigate({ view: "contacts", id: deal.contactId });
              }}
            >
              Contact
            </button>`
          : ""}
      </div>
    </li>`;
  }

  override render() {
    const summaryStages = this.summary.state === "ok" ? Object.keys(this.summary.value.byStage) : [];
    const stages = stageOrder(summaryStages);
    return html`${this.heading(
        "Pipeline",
        html`<div class="row">
          <button class="primary" @click=${() => void this.#create()} ?disabled=${this.busy}>New deal</button>
          <button @click=${() => void this.load()}>Refresh</button>
        </div>`,
      )}
      ${this.renderNotice()}
      <section class="card" aria-labelledby="p-summary">
        <h2 id="p-summary">Summary</h2>
        ${section(this.summary, (s) => {
          const total = Object.values(s.byStage).reduce((sum, stage) => sum + (stage.value || 0), 0);
          return html`<div class="row">
              <div><p class="small muted">Total pipeline</p><p class="big">${formatNumber(total)}</p></div>
              <div><p class="small muted">Weighted forecast</p><p class="big">${formatNumber(s.weightedForecast)}</p></div>
              <div><p class="small muted">Win rate</p><p class="big">${formatRate(s.winRate)}</p></div>
            </div>
            ${barChart(
              stages.filter((stage) => s.byStage[stage]).map((stage) => ({ label: humanizeKey(stage), value: s.byStage[stage]?.count ?? 0 })),
              "Deals by stage",
            )}`;
        })}
      </section>
      ${this.dealsError ? html`<p class="error">Deals could not be read: ${this.dealsError}</p>` : ""}
      ${this.deals === null
        ? this.dealsError
          ? ""
          : html`<p class="muted" aria-busy="true">Loading deals...</p>`
        : html`<div class="kanban spaced">
              ${groupByStage(this.deals, stages).map(
                (column) => html`<section class="column" aria-labelledby="col-${column.stage}">
                  <h2 id="col-${column.stage}">${humanizeKey(column.stage)} <span class="pill">${column.deals.length}</span></h2>
                  <ul class="plain">
                    ${column.deals.map((deal) => this.#card(deal, stages))}
                  </ul>
                </section>`,
              )}
            </div>
            ${this.cursor ? html`<p><button @click=${() => void this.#more()}>Load more deals</button></p>` : ""}`}`;
  }
}

customElements.define("gtm-pipeline", GtmPipeline);
