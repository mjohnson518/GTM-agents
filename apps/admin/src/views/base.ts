// GTM-agents: what every dashboard view shares: the client and session it is given, loading a
// section so a failure says "could not be read" instead of showing zero, and running an action
// with a visible outcome.
import { LitElement, html, nothing } from "lit";
import type { PropertyDeclarations, PropertyValues, TemplateResult } from "lit";
import { errorMessage } from "../format.ts";
import { RpcError } from "../rpc.ts";
import type { GatewayClient, Session } from "../rpc.ts";
import { sharedStyles } from "../styles.ts";

export type Loadable<T> = { state: "loading" } | { state: "ok"; value: T } | { state: "error"; message: string };

export const LOADING = { state: "loading" } as const;

export function settle<T>(promise: Promise<T>): Promise<Loadable<T>> {
  return promise.then(
    (value): Loadable<T> => ({ state: "ok", value }),
    (err: unknown): Loadable<T> => ({ state: "error", message: describeError(err) }),
  );
}

export function describeError(err: unknown): string {
  if (err instanceof RpcError) {
    switch (err.code) {
      case "conflict":
        return `${err.message} The content changed since it was shown; reload and review it again.`;
      case "forbidden":
        return `Not allowed: ${err.message}`;
      case "not_found":
        return `Not found: ${err.message}`;
      case "timeout":
        return "The deployment did not answer in time.";
      case "disconnected":
        return "Not connected to the deployment.";
      default:
        return err.message;
    }
  }
  return errorMessage(err);
}

/** Renders a section: a loading line, the reason it could not be read, or its content. */
export function section<T>(value: Loadable<T> | undefined, render: (value: T) => unknown): unknown {
  if (!value || value.state === "loading") return html`<p class="muted" aria-busy="true">Loading...</p>`;
  if (value.state === "error") return html`<p class="error">Could not be read: ${value.message}</p>`;
  return render(value.value);
}

export abstract class GtmView extends LitElement {
  static override properties: PropertyDeclarations = {
    client: { attribute: false },
    session: { attribute: false },
    notice: { state: true },
    busy: { state: true },
  };

  static override styles = [sharedStyles];

  declare client: GatewayClient | null;
  declare session: Session | null;
  declare notice: { tone: "ok" | "bad"; text: string } | null;
  declare busy: boolean;

  constructor() {
    super();
    this.client = null;
    this.session = null;
    this.notice = null;
    this.busy = false;
  }

  /** Loads the view's data. Runs on first connection and again after every reconnect. */
  abstract load(): Promise<void>;

  get rpc(): GatewayClient {
    if (!this.client) throw new RpcError("disconnected", "Not connected to the deployment.");
    return this.client;
  }

  override updated(changed: PropertyValues<this>): void {
    if ((changed.has("session") || changed.has("client")) && this.session && this.client) void this.load();
  }

  /** Runs an action, shows its outcome, and reloads the view when it succeeded. */
  async perform(label: string, action: () => Promise<string | void>, reload = true): Promise<boolean> {
    this.busy = true;
    this.notice = null;
    let ok = false;
    try {
      const message = await action();
      this.notice = { tone: "ok", text: message || `${label}: done.` };
      ok = true;
    } catch (err) {
      this.notice = { tone: "bad", text: `${label} failed. ${describeError(err)}` };
    } finally {
      this.busy = false;
    }
    if (ok && reload) {
      try {
        await this.load();
      } catch {
        // The action succeeded; a failed refresh shows in the sections it could not read.
      }
    }
    return ok;
  }

  protected renderNotice(): TemplateResult {
    return html`<div role="status" aria-live="polite">
      ${this.notice ? html`<p class="banner ${this.notice.tone}">${this.notice.text}</p>` : nothing}
    </div>`;
  }

  protected heading(text: string, extra: unknown = nothing): TemplateResult {
    return html`<div class="row spread"><h1 tabindex="-1">${text}</h1>${extra}</div>`;
  }
}
