// GTM-agents: the GTM cockpit: the cold outreach state and every panel the cockpit record holds
// (send caps, the deferred queue, monitor hits, outreach and discovery counts, recommendations,
// today's moves), with pause, resume, drain and replay. Each action asks for confirmation first,
// and pause and drain record a reason.
import { html } from "lit";
import type { MethodResult } from "@gtm-agents/core/gateway/protocol";
import { formatDateTime, formatNumber, humanizeKey } from "../format.ts";
import { confirmAction } from "../ui/dialog.ts";
import { renderValue } from "../ui/record.ts";
import { GtmView, LOADING, section, settle } from "./base.ts";
import type { Loadable } from "./base.ts";

export class GtmCockpit extends GtmView {
  static override properties = { cockpit: { state: true }, status: { state: true } };

  declare cockpit: Loadable<MethodResult<"cockpit.get">>;
  declare status: Loadable<MethodResult<"status">>;

  constructor() {
    super();
    this.cockpit = LOADING;
    this.status = LOADING;
  }

  override async load(): Promise<void> {
    const [cockpit, status] = await Promise.all([settle(this.rpc.call("cockpit.get", {})), settle(this.rpc.call("status", {}))]);
    this.cockpit = cockpit;
    this.status = status;
  }

  async #pause(): Promise<void> {
    const answer = await confirmAction({
      title: "Pause cold outreach",
      body: "New cold sends stop until someone resumes them.",
      fields: [{ name: "reason", label: "Reason", required: true, multiline: true, hint: "Recorded with the pause and shown in the cockpit." }],
      confirmLabel: "Pause outreach",
      danger: true,
    });
    if (!answer.confirmed) return;
    await this.perform("Pause", async () => {
      await this.rpc.call("cockpit.pause", { reason: answer.values.reason ?? "" });
      return "Cold outreach is paused.";
    });
  }

  async #resume(): Promise<void> {
    const answer = await confirmAction({
      title: "Resume cold outreach",
      body: "Cold sends start again within their send windows and caps.",
      confirmLabel: "Resume outreach",
    });
    if (!answer.confirmed) return;
    await this.perform("Resume", async () => {
      await this.rpc.call("cockpit.resume", {});
      return "Cold outreach resumed.";
    });
  }

  async #drain(): Promise<void> {
    const answer = await confirmAction({
      title: "Drain pending monitor hits",
      body: "Every pending monitor hit is cancelled and will not produce outreach.",
      fields: [{ name: "reason", label: "Reason", required: true, multiline: true }],
      confirmLabel: "Drain deferred sends",
      danger: true,
    });
    if (!answer.confirmed) return;
    await this.perform("Drain", async () => {
      const result = await this.rpc.call("cockpit.drain", { reason: answer.values.reason ?? "" });
      return `Cancelled ${formatNumber(result.cancelled)} pending monitor hit(s).`;
    });
  }

  async #replay(): Promise<void> {
    const answer = await confirmAction({
      title: "Replay deferred sends",
      body: "Deferred sends go back through the send path, which checks every gate again before anything is sent.",
      confirmLabel: "Replay deferred",
    });
    if (!answer.confirmed) return;
    await this.perform("Replay", async () => {
      const result = await this.rpc.call("cockpit.replay", {});
      return `Replayed ${formatNumber(result.replayed)} deferred send(s).`;
    });
  }

  override render() {
    return html`${this.heading("GTM cockpit", html`<button @click=${() => void this.load()} ?disabled=${this.busy}>Refresh</button>`)}
      ${this.renderNotice()}
      <section class="card" aria-labelledby="c-state">
        <h2 id="c-state">Cold outreach</h2>
        ${section(this.status, (s) => {
          const pause = s.coldPause;
          return html`<p>
              <span class="pill ${pause.paused ? (pause.severity === "critical" ? "bad" : "warn") : "ok"}">${pause.paused ? "Paused" : "Active"}</span>
              ${s.halted ? html`<span class="pill bad">Halted</span>` : ""}
            </p>
            ${pause.paused
              ? html`<p class="small">
                  <span class="text">${pause.reason ?? "No reason recorded."}</span>
                  ${pause.since ? html`<span class="muted">Since ${formatDateTime(pause.since)}.</span>` : ""}
                </p>`
              : ""}
            <div class="row">
              ${pause.paused
                ? html`<button class="primary" @click=${() => void this.#resume()} ?disabled=${this.busy}>Resume</button>`
                : html`<button class="danger" @click=${() => void this.#pause()} ?disabled=${this.busy}>Pause with reason</button>`}
              <button @click=${() => void this.#drain()} ?disabled=${this.busy}>Drain deferred sends</button>
              <button @click=${() => void this.#replay()} ?disabled=${this.busy}>Replay deferred</button>
            </div>`;
        })}
      </section>
      <div class="grid spaced">
        ${section(this.cockpit, (record) =>
          Object.entries(record).map(
            ([key, value]) => html`<section class="card">
              <h2>${humanizeKey(key)}</h2>
              ${renderValue(value)}
            </section>`,
          ),
        )}
      </div>`;
  }
}

customElements.define("gtm-cockpit", GtmCockpit);
