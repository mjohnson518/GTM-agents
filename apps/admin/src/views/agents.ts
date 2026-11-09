// GTM-agents: the Agents view: every agent grouped by role with its model and tool count, and
// every scheduled job with its schedule, flag and last run.
import { html } from "lit";
import type { MethodResult } from "@gtm-agents/core/gateway/protocol";
import { formatDateTime, humanizeKey } from "../format.ts";
import { GtmView, LOADING, section, settle } from "./base.ts";
import type { Loadable } from "./base.ts";

type Agent = MethodResult<"agents.list">[number];

function byRole(agents: readonly Agent[]): Array<[string, Agent[]]> {
  const groups = new Map<string, Agent[]>();
  for (const agent of agents) groups.set(agent.role, [...(groups.get(agent.role) ?? []), agent]);
  return [...groups.entries()];
}

export function runTone(status: string | undefined): string {
  if (!status) return "";
  if (/^(ok|success|succeeded|completed|done)$/i.test(status)) return "ok";
  if (/^(error|failed|failure)$/i.test(status)) return "bad";
  return "warn";
}

export class GtmAgents extends GtmView {
  static override properties = { agents: { state: true }, jobs: { state: true } };

  declare agents: Loadable<MethodResult<"agents.list">>;
  declare jobs: Loadable<MethodResult<"agents.status">>;

  constructor() {
    super();
    this.agents = LOADING;
    this.jobs = LOADING;
  }

  override async load(): Promise<void> {
    const [agents, jobs] = await Promise.all([settle(this.rpc.call("agents.list", {})), settle(this.rpc.call("agents.status", {}))]);
    this.agents = agents;
    this.jobs = jobs;
  }

  override render() {
    return html`${this.heading("Agents", html`<button @click=${() => void this.load()}>Refresh</button>`)}
      <section class="card" aria-labelledby="a-agents">
        <h2 id="a-agents">Hierarchy</h2>
        ${section(this.agents, (agents) =>
          agents.length === 0
            ? html`<p class="muted">No agents registered.</p>`
            : byRole(agents).map(
                ([role, members]) => html`<h3>${humanizeKey(role)}</h3>
                  <div class="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">Agent</th>
                          <th scope="col">Model</th>
                          <th scope="col">Tools</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${members.map(
                          (agent) => html`<tr>
                            <td>${agent.name}</td>
                            <td class="mono">${agent.model ?? "default for the role"}</td>
                            <td>${agent.tools}</td>
                          </tr>`,
                        )}
                      </tbody>
                    </table>
                  </div>`,
              ),
        )}
      </section>
      <section class="card spaced" aria-labelledby="a-jobs">
        <h2 id="a-jobs">Jobs</h2>
        ${section(
          this.jobs,
          (jobs) => html`<div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">Schedule</th>
                  <th scope="col">Flag</th>
                  <th scope="col">Last run</th>
                </tr>
              </thead>
              <tbody>
                ${jobs.map(
                  (job) => html`<tr>
                    <td>${job.job}</td>
                    <td class="mono">${job.schedule}</td>
                    <td class="mono">${job.flag ?? "none"}</td>
                    <td>
                      ${job.lastRun
                        ? html`<span class="pill ${runTone(job.lastRun.status)}">${job.lastRun.status}</span> ${formatDateTime(job.lastRun.at)}
                            ${job.lastRun.summary ? html`<div class="small muted text">${job.lastRun.summary}</div>` : ""}`
                        : html`<span class="muted">never run</span>`}
                    </td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>`,
        )}
      </section>`;
  }
}

customElements.define("gtm-agents", GtmAgents);
