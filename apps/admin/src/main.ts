// GTM-agents: the operator dashboard shell. It shows whether the deployment is healthy; the full
// views (cockpit, pipeline, inbound, agents, chat, activity, learnings, settings) build on it.
import { LitElement, css, html } from "lit";

interface Health {
  ok: boolean;
  service?: string;
}

export class GtmAdmin extends LitElement {
  static override properties = {
    health: { state: true },
    failed: { state: true },
  };

  static override styles = css`
    :host {
      display: block;
      font-family: system-ui, sans-serif;
      color: #1d1d1f;
      max-width: 40rem;
      margin: 3rem auto;
      padding: 0 1rem;
    }
    h1 {
      font-size: 1.5rem;
      margin: 0 0 1rem;
    }
    .status {
      padding: 0.75rem 1rem;
      border-radius: 0.5rem;
      background: #f2f2f7;
    }
    .ok {
      background: #e6f4ea;
    }
    .down {
      background: #fce8e6;
    }
  `;

  declare health: Health | null;
  declare failed: boolean;

  constructor() {
    super();
    this.health = null;
    this.failed = false;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      const response = await fetch("/health");
      this.health = (await response.json()) as Health;
      this.failed = !response.ok;
    } catch {
      this.failed = true;
    }
  }

  override render() {
    const state = this.failed ? "down" : this.health?.ok ? "ok" : "";
    const text = this.failed ? "The deployment is not responding." : this.health?.ok ? "The deployment is healthy." : "Checking the deployment...";
    return html`
      <h1>GTM-agents</h1>
      <p class="status ${state}" role="status">${text}</p>
    `;
  }
}

customElements.define("gtm-admin", GtmAdmin);
