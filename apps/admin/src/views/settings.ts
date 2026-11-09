// GTM-agents: the Settings view: the configuration (read only), the cron schedule, the session's
// capabilities, the feature flags and the security audit. A flag can be set or unset here except
// the autonomy keys, which change only through the operator's two-step autonomy command.
import { html } from "lit";
import type { MethodResult } from "@gtm-agents/core/gateway/protocol";
import { humanizeKey } from "../format.ts";
import { isFlagEditable, parseFlagInput } from "../state.ts";
import { confirmAction } from "../ui/dialog.ts";
import type { ConfirmField } from "../ui/dialog.ts";
import { renderValue } from "../ui/record.ts";
import { GtmView, LOADING, section, settle } from "./base.ts";
import type { Loadable } from "./base.ts";

type Flag = MethodResult<"flags.list">[number];

export class GtmSettings extends GtmView {
  static override properties = { config: { state: true }, jobs: { state: true }, flags: { state: true }, audit: { state: true } };

  declare config: Loadable<MethodResult<"config.get">>;
  declare jobs: Loadable<MethodResult<"agents.status">>;
  declare flags: Loadable<Flag[]>;
  declare audit: Loadable<MethodResult<"security.audit">>;

  constructor() {
    super();
    this.config = LOADING;
    this.jobs = LOADING;
    this.flags = LOADING;
    this.audit = LOADING;
  }

  override async load(): Promise<void> {
    const [config, jobs, flags, audit] = await Promise.all([
      settle(this.rpc.call("config.get", {})),
      settle(this.rpc.call("agents.status", {})),
      settle(this.rpc.call("flags.list", {})),
      settle(this.rpc.call("security.audit", {})),
    ]);
    this.config = config;
    this.jobs = jobs;
    this.flags = flags;
    this.audit = audit;
  }

  async #runAudit(): Promise<void> {
    this.audit = LOADING;
    this.audit = await settle(this.rpc.call("security.audit", {}));
  }

  async #set(flag: Flag): Promise<void> {
    if (!isFlagEditable(flag.key)) return;
    const field: ConfirmField =
      flag.kind === "boolean"
        ? { name: "value", label: "Value", required: true, options: ["true", "false"], value: flag.value ?? flag.default ?? "false" }
        : { name: "value", label: "Value", required: true, type: flag.kind === "number" ? "number" : "text", value: flag.value ?? flag.default ?? "" };
    const answer = await confirmAction({
      title: "Set a flag",
      body: html`<p class="mono">${flag.key}</p>
        <p class="small muted text">${flag.description}</p>
        ${flag.key === "admin:enabled" ? html`<p class="banner warn">Setting this to false closes this dashboard for every operator.</p>` : ""}`,
      fields: [field],
      validate: (values) => {
        const parsed = parseFlagInput(flag.kind, values.value ?? "");
        return parsed.ok ? null : parsed.message;
      },
      confirmLabel: "Set flag",
    });
    if (!answer.confirmed) return;
    const parsed = parseFlagInput(flag.kind, answer.values.value ?? "");
    if (!parsed.ok) return;
    await this.perform("Set flag", async () => {
      const result = await this.rpc.call("flags.set", { key: flag.key, value: parsed.value });
      return `${flag.key} is now ${result.value ?? "unset"}.`;
    });
  }

  async #unset(flag: Flag): Promise<void> {
    if (!isFlagEditable(flag.key)) return;
    const answer = await confirmAction({
      title: "Unset a flag",
      body: html`<p class="mono">${flag.key}</p>
        <p class="small">It returns to its default, ${flag.default ?? "none"}.</p>
        ${flag.key === "admin:enabled" ? html`<p class="banner warn">Its default is off, which closes this dashboard for every operator.</p>` : ""}`,
      confirmLabel: "Unset flag",
      danger: true,
    });
    if (!answer.confirmed) return;
    await this.perform("Unset flag", async () => {
      await this.rpc.call("flags.set", { key: flag.key, value: null });
      return `${flag.key} is back to its default.`;
    });
  }

  #flags(flags: Flag[]) {
    return html`<div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Flag</th>
            <th scope="col">Value</th>
            <th scope="col">Default</th>
            <th scope="col">Description</th>
            <th scope="col"><span class="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          ${flags.map(
            (flag) => html`<tr>
              <td class="mono">${flag.key}</td>
              <td class="mono">${flag.value ?? html`<span class="muted">unset</span>`}</td>
              <td class="mono">${flag.default ?? "none"}</td>
              <td class="small text">${flag.description}</td>
              <td>
                ${isFlagEditable(flag.key)
                  ? html`<div class="row">
                      <button @click=${() => void this.#set(flag)} ?disabled=${this.busy} aria-label="Set ${flag.key}">Set</button>
                      ${flag.value !== null
                        ? html`<button class="danger" @click=${() => void this.#unset(flag)} ?disabled=${this.busy} aria-label="Unset ${flag.key}">Unset</button>`
                        : ""}
                    </div>`
                  : html`<span class="small muted">Change with autonomy-set in the operator chat.</span>`}
              </td>
            </tr>`,
          )}
        </tbody>
      </table>
    </div>`;
  }

  override render() {
    const capabilities = this.session?.capabilities ?? [];
    return html`${this.heading("Settings", html`<button @click=${() => void this.load()}>Refresh</button>`)}
      ${this.renderNotice()}
      <div class="stack">
        <section class="card" aria-labelledby="s-flags">
          <h2 id="s-flags">Feature flags</h2>
          ${section(this.flags, (flags) => this.#flags(flags))}
        </section>
        <section class="card" aria-labelledby="s-audit">
          <div class="row spread">
            <h2 id="s-audit">Security audit</h2>
            <button @click=${() => void this.#runAudit()}>Run audit</button>
          </div>
          ${section(
            this.audit,
            (checks) => html`<div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Check</th>
                    <th scope="col">Result</th>
                    <th scope="col">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  ${checks.map(
                    (check) => html`<tr>
                      <td>${check.check}</td>
                      <td><span class="pill ${check.ok ? "ok" : "bad"}">${check.ok ? "pass" : "fail"}</span></td>
                      <td class="small text">${check.detail}</td>
                    </tr>`,
                  )}
                </tbody>
              </table>
            </div>`,
          )}
        </section>
        <section class="card" aria-labelledby="s-cron">
          <h2 id="s-cron">Cron schedule</h2>
          ${section(
            this.jobs,
            (jobs) => html`<div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Job</th>
                    <th scope="col">Schedule</th>
                    <th scope="col">Flag</th>
                  </tr>
                </thead>
                <tbody>
                  ${jobs.map(
                    (job) => html`<tr>
                      <td>${job.job}</td>
                      <td class="mono">${job.schedule}</td>
                      <td class="mono">${job.flag ?? "none"}</td>
                    </tr>`,
                  )}
                </tbody>
              </table>
            </div>`,
          )}
        </section>
        <section class="card" aria-labelledby="s-caps">
          <h2 id="s-caps">Capabilities</h2>
          ${capabilities.length
            ? html`<p class="row">${capabilities.map((capability) => html`<span class="pill">${humanizeKey(capability)}</span>`)}</p>`
            : html`<p class="muted">None reported.</p>`}
        </section>
        <section class="card" aria-labelledby="s-config">
          <h2 id="s-config">Configuration</h2>
          <p class="small muted">Read only. Change it in gtm.config.ts and redeploy.</p>
          ${section(this.config, (config) => renderValue(config))}
        </section>
      </div>`;
  }
}

customElements.define("gtm-settings", GtmSettings);
