// GTM-agents: the Overview view: system status, active agents, the contact base, pipeline value,
// cost today, security posture, infrastructure checks and the fitness trend. Each panel loads on
// its own, so one unreadable source never blanks the others.
import { html } from "lit";
import type { MethodResult } from "@gtm-agents/core/gateway/protocol";
import { formatCents, formatNumber, formatRate, humanizeKey } from "../format.ts";
import { barChart, sparkline } from "../ui/charts.ts";
import { GtmView, LOADING, section, settle } from "./base.ts";
import type { Loadable } from "./base.ts";

interface OverviewData {
  status: Loadable<MethodResult<"status">>;
  health: Loadable<MethodResult<"health">>;
  agents: Loadable<MethodResult<"agents.list">>;
  contacts: Loadable<MethodResult<"contacts.stats">>;
  pipeline: Loadable<MethodResult<"pipeline.summary">>;
  cost: Loadable<MethodResult<"cost.summary">>;
  audit: Loadable<MethodResult<"security.audit">>;
  fitness: Loadable<MethodResult<"fitness.trend">>;
}

export class GtmOverview extends GtmView {
  static override properties = { data: { state: true } };

  declare data: OverviewData;

  constructor() {
    super();
    this.data = { status: LOADING, health: LOADING, agents: LOADING, contacts: LOADING, pipeline: LOADING, cost: LOADING, audit: LOADING, fitness: LOADING };
  }

  override async load(): Promise<void> {
    const rpc = this.rpc;
    const [status, health, agents, contacts, pipeline, cost, audit, fitness] = await Promise.all([
      settle(rpc.call("status", {})),
      settle(rpc.call("health", {})),
      settle(rpc.call("agents.list", {})),
      settle(rpc.call("contacts.stats", {})),
      settle(rpc.call("pipeline.summary", {})),
      settle(rpc.call("cost.summary", { days: 1 })),
      settle(rpc.call("security.audit", {})),
      settle(rpc.call("fitness.trend", { days: 30 })),
    ]);
    this.data = { status, health, agents, contacts, pipeline, cost, audit, fitness };
  }

  override render() {
    const d = this.data;
    return html`${this.heading("Overview", html`<button @click=${() => void this.load()}>Refresh</button>`)}
      <div class="grid">
        <section class="card" aria-labelledby="o-status">
          <h2 id="o-status">System status</h2>
          ${section(d.status, (s) => {
            const paused = s.coldPause.paused;
            return html`<p>
                <span class="pill ${s.halted ? "bad" : "ok"}">${s.halted ? "Halted" : "Running"}</span>
                <span class="pill ${paused ? (s.coldPause.severity === "critical" ? "bad" : "warn") : "ok"}">${paused ? "Cold outreach paused" : "Cold outreach active"}</span>
                <span class="pill ${s.measurementHealthy ? "ok" : "warn"}">${s.measurementHealthy ? "Measurement healthy" : "Measurement degraded"}</span>
              </p>
              ${paused && s.coldPause.reason ? html`<p class="small text">Reason: ${s.coldPause.reason}</p>` : ""}
              <p class="small muted">${s.flagsOn.length} flag(s) on, ${s.failingJobs.length} failing job(s).</p>
              ${s.failingJobs.length
                ? html`<ul class="plain small">
                    ${s.failingJobs.map((job) => html`<li><strong>${job.job}</strong> <span class="text">${job.lastError ?? ""}</span></li>`)}
                  </ul>`
                : ""}`;
          })}
        </section>
        <section class="card" aria-labelledby="o-agents">
          <h2 id="o-agents">Active agents</h2>
          ${section(d.agents, (agents) => html`<p class="big">${agents.length}</p>
              <p class="small muted">${agents.map((agent) => agent.name).join(", ") || "none"}</p>`)}
        </section>
        <section class="card" aria-labelledby="o-contacts">
          <h2 id="o-contacts">Contact base</h2>
          ${section(d.contacts, (stats) =>
            barChart(
              Object.entries(stats).map(([label, value]) => ({ label: humanizeKey(label), value })),
              "Contacts",
            ),
          )}
        </section>
        <section class="card" aria-labelledby="o-pipeline">
          <h2 id="o-pipeline">Pipeline value</h2>
          ${section(d.pipeline, (p) => {
            const total = Object.values(p.byStage).reduce((sum, stage) => sum + (stage.value || 0), 0);
            return html`<p class="big">${formatNumber(total)}</p>
              <p class="small muted">Weighted forecast ${formatNumber(p.weightedForecast)}, win rate ${formatRate(p.winRate)}.</p>`;
          })}
        </section>
        <section class="card" aria-labelledby="o-cost">
          <h2 id="o-cost">Cost today</h2>
          ${section(d.cost, (c) => html`<p class="big">${formatCents(c.totalCents)}</p>
              ${barChart(
                Object.entries(c.byProvider).map(([label, value]) => ({ label, value })),
                "Cost by provider",
                formatCents,
              )}`)}
        </section>
        <section class="card" aria-labelledby="o-security">
          <h2 id="o-security">Security posture</h2>
          ${section(d.audit, (checks) => {
            const failing = checks.filter((check) => !check.ok);
            return html`<p><span class="pill ${failing.length ? "bad" : "ok"}">${checks.length - failing.length} of ${checks.length} checks pass</span></p>
              ${failing.length
                ? html`<ul class="plain small">
                    ${failing.map((check) => html`<li><strong>${check.check}</strong>: <span class="text">${check.detail}</span></li>`)}
                  </ul>`
                : ""}`;
          })}
        </section>
        <section class="card" aria-labelledby="o-infra">
          <h2 id="o-infra">Infrastructure</h2>
          ${section(d.health, (h) => html`<ul class="plain small">
            ${h.checks.map(
              (check) => html`<li>
                <span class="pill ${check.ok ? "ok" : "bad"}">${check.ok ? "ok" : "failing"}</span> ${check.name}
                ${check.detail ? html`<span class="muted text">${check.detail}</span>` : ""}
              </li>`,
            )}
          </ul>`)}
        </section>
        <section class="card" aria-labelledby="o-fitness">
          <h2 id="o-fitness">Fitness, 30 days</h2>
          ${section(d.fitness, (days) => {
            const latest = [...days].reverse().find((day) => day.score !== null);
            return html`${sparkline(
                days.map((day) => day.score),
                "Fitness score",
              )}
              <p class="small muted">Latest score ${latest ? formatNumber(latest.score, 2) : "n/a"}.</p>`;
          })}
        </section>
      </div>`;
  }
}

customElements.define("gtm-overview", GtmOverview);
