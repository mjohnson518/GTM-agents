// GTM-agents: the Chat view: a streaming conversation with the hub agent. Tokens arrive as
// chat.delta events and the turn ends with chat.done; a running turn can be aborted. The agent's
// reply is shown as text, never as HTML.
import { css, html } from "lit";
import type { PropertyValues } from "lit";
import { formatDateTime } from "../format.ts";
import { chatDelta, chatDone, chatFromHistory, chatOperatorSaid, chatStreamingTurn, chatTurnStarted, emptyChat } from "../state.ts";
import type { ChatState } from "../state.ts";
import { sharedStyles } from "../styles.ts";
import { GtmView, describeError } from "./base.ts";

export class GtmChat extends GtmView {
  static override properties = { chat: { state: true }, sending: { state: true }, historyError: { state: true }, live: { state: true } };

  static override styles = [
    sharedStyles,
    css`
      ol {
        list-style: none;
        padding: 0;
        margin: 0 0 1rem;
        max-height: 60vh;
        overflow-y: auto;
      }
      li {
        padding: 0.6rem 0.8rem;
        border-radius: var(--radius);
        margin-bottom: 0.5rem;
        background: var(--surface);
        border: 1px solid var(--border);
      }
      li.operator {
        background: var(--surface-2);
        margin-left: 15%;
      }
      li.agent {
        margin-right: 15%;
      }
    `,
  ];

  declare chat: ChatState;
  declare sending: boolean;
  declare historyError: string;
  declare live: string;
  #unsubscribe: Array<() => void> = [];

  constructor() {
    super();
    this.chat = emptyChat;
    this.sending = false;
    this.historyError = "";
    this.live = "";
  }

  override updated(changed: PropertyValues<this>): void {
    if (changed.has("client")) this.#subscribe();
    super.updated(changed);
    if (changed.has("chat")) {
      const list = this.renderRoot.querySelector("ol");
      if (list) list.scrollTop = list.scrollHeight;
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
  }

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.client && this.#unsubscribe.length === 0) this.#subscribe();
  }

  #subscribe(): void {
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    const client = this.client;
    if (!client) return;
    this.#unsubscribe.push(
      client.on("chat.delta", (data) => {
        this.chat = chatDelta(this.chat, data.turnId, data.text);
      }),
      client.on("chat.done", (data) => {
        this.chat = chatDone(this.chat, data.turnId, data.status, data.message);
        this.live = data.status === "completed" ? "The agent finished replying." : `The reply was ${data.status}.`;
      }),
    );
  }

  override async load(): Promise<void> {
    if (chatStreamingTurn(this.chat)) return;
    try {
      this.chat = chatFromHistory(await this.rpc.call("chat.history", { limit: 50 }));
      this.historyError = "";
    } catch (err) {
      this.historyError = describeError(err);
    }
  }

  async #send(event: Event): Promise<void> {
    event.preventDefault();
    const input = this.renderRoot.querySelector<HTMLTextAreaElement>("#chat-input");
    const text = input?.value.trim() ?? "";
    if (!text || this.sending || chatStreamingTurn(this.chat)) return;
    this.sending = true;
    this.notice = null;
    this.chat = chatOperatorSaid(this.chat, text, new Date().toISOString());
    try {
      const { turnId } = await this.rpc.call("chat.send", { text });
      this.chat = chatTurnStarted(this.chat, turnId, new Date().toISOString());
      this.live = "The agent is replying.";
      if (input) input.value = "";
    } catch (err) {
      this.notice = { tone: "bad", text: `The message was not sent. ${describeError(err)}` };
    } finally {
      this.sending = false;
    }
  }

  async #abort(turnId: string): Promise<void> {
    try {
      await this.rpc.call("chat.abort", { turnId });
    } catch (err) {
      this.notice = { tone: "bad", text: `Abort failed. ${describeError(err)}` };
    }
  }

  override render() {
    const streaming = chatStreamingTurn(this.chat);
    return html`${this.heading("Chat")} ${this.renderNotice()}
      <p class="visually-hidden" role="status" aria-live="polite">${this.live}</p>
      ${this.historyError ? html`<p class="error">The history could not be read: ${this.historyError}</p>` : ""}
      <ol aria-label="Conversation">
        ${this.chat.messages.map(
          (message) => html`<li class=${message.role}>
            <p class="small muted">
              ${message.role === "operator" ? "You" : "Agent"}, ${formatDateTime(message.at)}
              ${message.status && message.status !== "completed" ? html`<span class="pill ${message.status === "failed" ? "bad" : "warn"}">${message.status}</span>` : ""}
            </p>
            <div class="text">${message.text}</div>
            ${message.note ? html`<p class="small muted text">${message.note}</p>` : ""}
          </li>`,
        )}
      </ol>
      <form @submit=${(event: Event) => void this.#send(event)}>
        <label for="chat-input" class="visually-hidden">Message to the agent</label>
        <textarea
          id="chat-input"
          placeholder="Message the agent"
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              (event.target as HTMLTextAreaElement).form?.requestSubmit();
            }
          }}
        ></textarea>
        <div class="row spaced">
          <button type="submit" class="primary" ?disabled=${this.sending || streaming !== null}>Send</button>
          ${streaming ? html`<button type="button" class="danger" @click=${() => void this.#abort(streaming)}>Abort</button>` : ""}
          <span class="small muted">Ctrl or Cmd and Enter sends.</span>
        </div>
      </form>`;
  }
}

customElements.define("gtm-chat", GtmChat);
