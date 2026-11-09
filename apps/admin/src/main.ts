// GTM-agents: the operator dashboard shell. It opens the gateway socket on the page's own origin
// (the Cloudflare Access session cookie authenticates the upgrade; the dashboard holds no
// credentials of its own), shows the connection state, including "not configured" and "not
// allowed", carries the navigation and the system status, and hosts one view at a time.
import { LitElement, css, html, nothing } from "lit";
import type { SystemStatus } from "@gtm-agents/core/gateway/protocol";
import { GatewayClient, browserProbe, browserSocketFactory, socketUrl } from "./rpc.ts";
import type { ConnectionState, Session } from "./rpc.ts";
import { VIEWS, parseRoute } from "./router.ts";
import type { Route } from "./router.ts";
import { pageStyles, sharedStyles } from "./styles.ts";
import "./ui/dialog.ts";
import "./views/overview.ts";
import "./views/cockpit.ts";
import "./views/pipeline.ts";
import "./views/inbound.ts";
import "./views/proposals.ts";
import "./views/agents.ts";
import "./views/chat.ts";
import "./views/activity.ts";
import "./views/settings.ts";
import "./views/misc.ts";
import "./views/contacts.ts";

if (pageStyles.styleSheet) document.adoptedStyleSheets = [...document.adoptedStyleSheets, pageStyles.styleSheet];

type Theme = "system" | "light" | "dark";
const THEME_KEY = "gtm-admin-theme";

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage can be unavailable; the theme still applies for this visit.
  }
}

export class GtmAdmin extends LitElement {
  static override properties = {
    conn: { state: true },
    session: { state: true },
    status: { state: true },
    route: { state: true },
    theme: { state: true },
  };

  static override styles = [
    sharedStyles,
    css`
      :host {
        display: grid;
        grid-template-columns: 13rem 1fr;
        grid-template-rows: auto 1fr;
        min-height: 100vh;
      }
      header {
        grid-column: 1 / -1;
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
        align-items: center;
        justify-content: space-between;
        padding: 0.6rem 1rem;
        background: var(--surface);
        border-bottom: 1px solid var(--border);
      }
      .brand {
        font-weight: 700;
      }
      nav {
        background: var(--surface);
        border-right: 1px solid var(--border);
        padding: 0.75rem 0.5rem;
      }
      nav ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      nav a {
        display: block;
        padding: 0.4rem 0.7rem;
        border-radius: 6px;
        color: var(--text);
        text-decoration: none;
      }
      nav a[aria-current="page"] {
        background: var(--surface-2);
        font-weight: 600;
      }
      main {
        padding: 1.25rem;
        min-width: 0;
      }
      main:focus {
        outline: none;
      }
      .skip {
        position: absolute;
        left: -999px;
        top: 0.5rem;
        z-index: 10;
      }
      .skip:focus {
        left: 0.5rem;
      }
      .center {
        max-width: 36rem;
        margin: 4rem auto;
      }
      @media (max-width: 900px) {
        :host {
          grid-template-columns: 1fr;
          grid-template-rows: auto auto 1fr;
        }
        nav {
          border-right: none;
          border-bottom: 1px solid var(--border);
          overflow-x: auto;
        }
        nav ul {
          display: flex;
          gap: 0.25rem;
        }
        nav a {
          white-space: nowrap;
        }
      }
    `,
  ];

  declare conn: ConnectionState;
  declare session: Session | null;
  declare status: SystemStatus | null;
  declare route: Route;
  declare theme: Theme;
  readonly client: GatewayClient;
  #off: Array<() => void> = [];
  #routeChanged = false;
  #onHash = () => {
    this.route = parseRoute(location.hash);
    this.#routeChanged = true;
  };
  #onOnline = () => this.client.retryNow();

  constructor() {
    super();
    this.client = new GatewayClient({ url: socketUrl(location), socketFactory: browserSocketFactory, probe: browserProbe });
    this.conn = this.client.state;
    this.session = null;
    this.status = null;
    this.route = parseRoute(location.hash);
    this.theme = readTheme();
    applyTheme(this.theme);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("hashchange", this.#onHash);
    window.addEventListener("online", this.#onOnline);
    this.#off.push(
      this.client.onState((state) => {
        this.conn = state;
        if (state.kind === "open") {
          this.session = state.session;
          this.client.call("status", {}).then(
            (status) => (this.status = status),
            () => (this.status = null),
          );
        }
      }),
      this.client.on("status", (status) => (this.status = status)),
    );
    this.client.start();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("hashchange", this.#onHash);
    window.removeEventListener("online", this.#onOnline);
    for (const off of this.#off) off();
    this.#off = [];
    this.client.stop();
  }

  override updated(): void {
    if (!this.#routeChanged) return;
    this.#routeChanged = false;
    void this.#focusView();
  }

  /** After a route change, focus moves to the new view's heading so keyboard and screen reader users land there. */
  async #focusView(): Promise<void> {
    const view = this.renderRoot.querySelector("main > *");
    if (view instanceof LitElement) await view.updateComplete;
    const heading = view?.shadowRoot?.querySelector<HTMLElement>("h1");
    (heading ?? this.renderRoot.querySelector<HTMLElement>("main"))?.focus();
  }

  #view() {
    const { client, session } = this;
    const r = this.route;
    switch (r.view) {
      case "overview":
        return html`<gtm-overview .client=${client} .session=${session}></gtm-overview>`;
      case "cockpit":
        return html`<gtm-cockpit .client=${client} .session=${session}></gtm-cockpit>`;
      case "pipeline":
        return html`<gtm-pipeline .client=${client} .session=${session}></gtm-pipeline>`;
      case "inbound":
        return html`<gtm-inbound .client=${client} .session=${session}></gtm-inbound>`;
      case "proposals":
        return html`<gtm-proposals .client=${client} .session=${session}></gtm-proposals>`;
      case "learning":
        return html`<gtm-learning .client=${client} .session=${session}></gtm-learning>`;
      case "contacts":
        return html`<gtm-contacts .client=${client} .session=${session} .contactId=${r.id ?? null}></gtm-contacts>`;
      case "agents":
        return html`<gtm-agents .client=${client} .session=${session}></gtm-agents>`;
      case "chat":
        return html`<gtm-chat .client=${client} .session=${session}></gtm-chat>`;
      case "activity":
        return html`<gtm-activity .client=${client} .session=${session}></gtm-activity>`;
      case "link-triage":
        return html`<gtm-link-triage .client=${client} .session=${session}></gtm-link-triage>`;
      case "settings":
        return html`<gtm-settings .client=${client} .session=${session}></gtm-settings>`;
      case "changelog":
        return html`<gtm-changelog .client=${client} .session=${session}></gtm-changelog>`;
    }
  }

  /** The full-page message for a state the operator has to act on, or nothing. */
  #blocking() {
    const c = this.conn;
    switch (c.kind) {
      case "not_configured":
        return c.disabled
          ? html`<div class="center card" role="alert">
              <h1>The dashboard is turned off</h1>
              <p>This deployment answered 503: the dashboard is configured, but its flag is off.</p>
              <p class="small muted">Turn the admin:enabled flag on for this deployment, then try again.</p>
              <button class="primary" @click=${() => this.client.retryNow()}>Try again</button>
            </div>`
          : html`<div class="center card" role="alert">
          <h1>The dashboard is not configured</h1>
          <p>This deployment answered 503: its dashboard gateway is not set up yet.</p>
          <p class="small muted">Add the admin section to gtm.config.ts (the Cloudflare Access settings and the operator allowlist), put the deployment behind Cloudflare Access, redeploy, then try again.</p>
          <button class="primary" @click=${() => this.client.retryNow()}>Try again</button>
        </div>`;
      case "not_allowed":
        return html`<div class="center card" role="alert">
          <h1>Not allowed</h1>
          <p>This account is not on the deployment's operator allowlist, or the sign-in has expired.</p>
          <p class="small muted text">${c.message}</p>
          <button class="primary" @click=${() => location.reload()}>Sign in again</button>
        </div>`;
      case "incompatible":
        return html`<div class="center card" role="alert">
          <h1>Version mismatch</h1>
          <p>The dashboard and the deployment speak different protocol versions. Rebuild and redeploy both from the same release.</p>
          <p class="small muted text">${c.message}</p>
        </div>`;
      default:
        return null;
    }
  }

  #connectionBanner() {
    const c = this.conn;
    if (c.kind === "connecting" && !this.session) return html`<p class="banner" role="status">Connecting to the deployment...</p>`;
    if (c.kind === "connecting") return html`<p class="banner warn" role="status">Reconnecting...</p>`;
    if (c.kind === "reconnecting")
      return html`<p class="banner warn row spread" role="status">
        <span>Connection lost. Retrying in ${Math.ceil(c.inMs / 1000)}s. <span class="small text">${c.reason}</span></span>
        <button @click=${() => this.client.retryNow()}>Retry now</button>
      </p>`;
    if (c.kind === "stopped") return html`<p class="banner warn" role="status">Disconnected.</p>`;
    return nothing;
  }

  #statusPills() {
    const s = this.status;
    if (!s) return nothing;
    return html`${s.halted ? html`<span class="pill bad">Halted</span>` : nothing}
    ${s.coldPause.paused ? html`<span class="pill ${s.coldPause.severity === "critical" ? "bad" : "warn"}">Cold outreach paused</span>` : nothing}
    ${s.failingJobs.length ? html`<span class="pill warn">${s.failingJobs.length} failing job(s)</span>` : nothing}
    ${!s.halted && !s.coldPause.paused && !s.failingJobs.length ? html`<span class="pill ok">Running</span>` : nothing}`;
  }

  override render() {
    const blocking = this.#blocking();
    const session = this.session;
    return html`<button class="skip" @click=${() => this.renderRoot.querySelector<HTMLElement>("main")?.focus()}>Skip to content</button>
      <header>
        <div class="row">
          <span class="brand">GTM-agents</span>
          ${session ? html`<span class="small muted">${session.deployment.name}, ${session.deployment.environment}</span>` : nothing}
          <span class="row" role="group" aria-label="System status">${this.#statusPills()}</span>
        </div>
        <div class="row">
          ${session ? html`<span class="small muted">${session.operator.email}</span>` : nothing}
          <label for="theme" class="inline small"
            >Theme
            <select
              id="theme"
              .value=${this.theme}
              @change=${(event: Event) => {
                this.theme = (event.target as HTMLSelectElement).value as Theme;
                applyTheme(this.theme);
              }}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </div>
      </header>
      <nav aria-label="Views">
        <ul>
          ${VIEWS.map(
            (view) => html`<li>
              <a href="#/${view.name}" aria-current=${this.route.view === view.name ? "page" : nothing}>${view.label}</a>
            </li>`,
          )}
        </ul>
      </nav>
      <main id="main" tabindex="-1">${blocking ?? html`${this.#connectionBanner()} ${session ? this.#view() : nothing}`}</main>`;
  }
}

customElements.define("gtm-admin", GtmAdmin);
