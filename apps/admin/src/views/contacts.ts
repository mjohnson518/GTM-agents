// GTM-agents: the Contacts view and the contact detail. The list searches by text and warmth and
// shows who to contact next; the detail shows the record, its activity log and a summary, and
// edits only the fields the server allows (first name, last name, job title, notes).
import { html } from "lit";
import type { PropertyValues } from "lit";
import type { ActivityItem, MethodParams, MethodResult } from "@gtm-agents/core/gateway/protocol";
import { formatRelative, humanizeKey } from "../format.ts";
import { navigate } from "../router.ts";
import { appendActivity } from "../state.ts";
import { barChart } from "../ui/charts.ts";
import { confirmAction } from "../ui/dialog.ts";
import { renderValue } from "../ui/record.ts";
import { renderActivityTable } from "./activity.ts";
import { GtmView, LOADING, describeError, section, settle } from "./base.ts";
import type { Loadable } from "./base.ts";

const WARMTH = ["cold", "contacted", "warming", "engaged", "hot", "customer", "churned", "opted_out"] as const;

type Contact = MethodResult<"contacts.query">["items"][number];
type Patch = MethodParams<"contacts.update">["patch"];

const EDITABLE: ReadonlyArray<{ key: keyof Patch; label: string; aliases: string[]; multiline?: boolean }> = [
  { key: "firstName", label: "First name", aliases: ["firstName", "first_name"] },
  { key: "lastName", label: "Last name", aliases: ["lastName", "last_name"] },
  { key: "jobTitle", label: "Job title", aliases: ["jobTitle", "job_title", "title"] },
  { key: "notes", label: "Notes", aliases: ["notes"], multiline: true },
];

function currentValue(record: Record<string, unknown>, aliases: readonly string[]): string {
  for (const alias of aliases) {
    const value = record[alias];
    if (typeof value === "string") return value;
  }
  return "";
}

export class GtmContacts extends GtmView {
  static override properties = {
    contactId: { attribute: false },
    stats: { state: true },
    next: { state: true },
    results: { state: true },
    q: { state: true },
    warmth: { state: true },
    record: { state: true },
    log: { state: true },
    logCursor: { state: true },
    summary: { state: true },
  };

  declare contactId: string | null;
  declare stats: Loadable<MethodResult<"contacts.stats">>;
  declare next: Loadable<MethodResult<"contacts.next">>;
  declare results: Loadable<{ items: Contact[]; cursor?: string }>;
  declare q: string;
  declare warmth: string;
  declare record: Loadable<Record<string, unknown>>;
  declare log: Loadable<ActivityItem[]>;
  declare logCursor: string | undefined;
  declare summary: Loadable<string> | null;

  constructor() {
    super();
    this.contactId = null;
    this.stats = LOADING;
    this.next = LOADING;
    this.results = LOADING;
    this.q = "";
    this.warmth = "";
    this.record = LOADING;
    this.log = LOADING;
    this.logCursor = undefined;
    this.summary = null;
  }

  override updated(changed: PropertyValues<this>): void {
    if (changed.has("contactId") && !changed.has("session") && this.session && this.client) void this.load();
    super.updated(changed);
  }

  override async load(): Promise<void> {
    if (this.contactId) return this.#loadDetail(this.contactId);
    const [stats, next] = await Promise.all([settle(this.rpc.call("contacts.stats", {})), settle(this.rpc.call("contacts.next", {}))]);
    this.stats = stats;
    this.next = next;
    await this.#query();
  }

  async #query(cursor?: string): Promise<void> {
    const params: MethodParams<"contacts.query"> = { limit: 50 };
    if (this.q) params.q = this.q;
    if (this.warmth) params.warmth = this.warmth;
    if (cursor) params.cursor = cursor;
    const page = await settle(this.rpc.call("contacts.query", params));
    if (cursor && page.state === "ok" && this.results.state === "ok") {
      this.results = { state: "ok", value: { items: [...this.results.value.items, ...page.value.items], cursor: page.value.cursor } };
    } else {
      this.results = page;
    }
  }

  async #loadDetail(id: string): Promise<void> {
    this.summary = null;
    this.record = LOADING;
    this.log = LOADING;
    this.logCursor = undefined;
    const [record, log] = await Promise.all([settle(this.rpc.call("contacts.get", { id })), settle(this.rpc.call("contacts.log", { id }))]);
    if (this.contactId !== id) return;
    this.record = record;
    this.log = log.state === "ok" ? { state: "ok", value: log.value.items } : log;
    this.logCursor = log.state === "ok" ? log.value.cursor : undefined;
  }

  async #moreLog(id: string): Promise<void> {
    if (!this.logCursor || this.log.state !== "ok") return;
    try {
      const page = await this.rpc.call("contacts.log", { id, cursor: this.logCursor });
      this.log = { state: "ok", value: appendActivity(this.log.value, page.items) };
      this.logCursor = page.cursor;
    } catch (err) {
      this.notice = { tone: "bad", text: `More activity could not be read. ${describeError(err)}` };
    }
  }

  async #summarize(id: string): Promise<void> {
    this.summary = LOADING;
    const result = await settle(this.rpc.call("contacts.summary", { id }));
    this.summary = result.state === "ok" ? { state: "ok", value: result.value.text } : result;
  }

  async #edit(id: string, record: Record<string, unknown>): Promise<void> {
    const initial = Object.fromEntries(EDITABLE.map((field) => [field.key, currentValue(record, field.aliases)]));
    const answer = await confirmAction({
      title: "Edit the contact",
      fields: EDITABLE.map((field) => ({ name: field.key, label: field.label, value: initial[field.key] ?? "", multiline: field.multiline ?? false })),
      validate: (values) => (EDITABLE.some((field) => (values[field.key] ?? "") !== (initial[field.key] ?? "")) ? null : "Nothing changed."),
      confirmLabel: "Save changes",
    });
    if (!answer.confirmed) return;
    const patch: Patch = {};
    for (const field of EDITABLE) {
      const value = answer.values[field.key] ?? "";
      if (value !== (initial[field.key] ?? "")) patch[field.key] = value;
    }
    await this.perform("Save contact", async () => {
      await this.rpc.call("contacts.update", { id, patch });
      return "Contact saved.";
    });
  }

  #detail(id: string) {
    return html`${this.heading("Contact", html`<button @click=${() => navigate({ view: "contacts" })}>All contacts</button>`)}
      ${this.renderNotice()}
      <p class="mono small muted">${id}</p>
      <div class="stack">
        <section class="card" aria-labelledby="d-record">
          <div class="row spread">
            <h2 id="d-record">Record</h2>
            ${this.record.state === "ok" ? html`<button class="primary" @click=${() => this.record.state === "ok" && void this.#edit(id, this.record.value)} ?disabled=${this.busy}>Edit</button>` : ""}
          </div>
          ${section(this.record, (record) => renderValue(record))}
        </section>
        <section class="card" aria-labelledby="d-summary">
          <div class="row spread">
            <h2 id="d-summary">Summary</h2>
            <button @click=${() => void this.#summarize(id)}>${this.summary ? "Summarize again" : "Summarize"}</button>
          </div>
          ${this.summary ? section(this.summary, (text) => html`<p class="text">${text}</p>`) : html`<p class="muted small">Ask for a summary of this contact's history.</p>`}
        </section>
        <section class="card" aria-labelledby="d-log">
          <h2 id="d-log">Activity</h2>
          ${section(this.log, (items) => renderActivityTable(items))}
          ${this.logCursor ? html`<p><button @click=${() => void this.#moreLog(id)}>Load more</button></p>` : ""}
        </section>
      </div>`;
  }

  #list() {
    return html`${this.heading("Contacts", html`<button @click=${() => void this.load()}>Refresh</button>`)}
      ${this.renderNotice()}
      <div class="grid">
        <section class="card" aria-labelledby="ct-stats">
          <h2 id="ct-stats">Contact base</h2>
          ${section(this.stats, (stats) =>
            barChart(
              Object.entries(stats).map(([label, value]) => ({ label: humanizeKey(label), value })),
              "Contacts",
            ),
          )}
        </section>
        <section class="card" aria-labelledby="ct-next">
          <h2 id="ct-next">Contact next</h2>
          ${section(this.next, (next) =>
            next.length === 0
              ? html`<p class="muted">Nobody is due.</p>`
              : html`<ul class="plain small">
                  ${next.slice(0, 10).map(
                    (entry) => html`<li>
                      <button class="link" @click=${() => navigate({ view: "contacts", id: entry.id })}>Open</button>
                      <span class="text">${entry.reason}</span>
                    </li>`,
                  )}
                </ul>`,
          )}
        </section>
      </div>
      <form
        class="row spaced"
        role="search"
        @submit=${(event: Event) => {
          event.preventDefault();
          this.q = this.renderRoot.querySelector<HTMLInputElement>("#ct-q")?.value.trim() ?? "";
          this.warmth = this.renderRoot.querySelector<HTMLSelectElement>("#ct-warmth")?.value ?? "";
          void this.#query();
        }}
      >
        <label for="ct-q">Search <input id="ct-q" type="search" .value=${this.q} /></label>
        <label for="ct-warmth"
          >Warmth
          <select id="ct-warmth" .value=${this.warmth}>
            <option value="">Any</option>
            ${WARMTH.map((warmth) => html`<option value=${warmth}>${humanizeKey(warmth)}</option>`)}
          </select>
        </label>
        <button type="submit">Search</button>
      </form>
      <div class="spaced">
        ${section(this.results, (page) =>
          page.items.length === 0
            ? html`<p class="muted">No contacts match.</p>`
            : html`<div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Name</th>
                        <th scope="col">Email</th>
                        <th scope="col">Account</th>
                        <th scope="col">Warmth</th>
                        <th scope="col">Last contacted</th>
                        <th scope="col"><span class="visually-hidden">Open</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      ${page.items.map(
                        (contact) => html`<tr>
                          <td>${contact.name ?? html`<span class="muted">unknown</span>`}</td>
                          <td class="text">${contact.email}</td>
                          <td>${contact.accountKey ?? ""}</td>
                          <td><span class="pill">${humanizeKey(contact.warmth)}</span></td>
                          <td>${contact.lastContactedAt ? formatRelative(contact.lastContactedAt) : "never"}</td>
                          <td><button @click=${() => navigate({ view: "contacts", id: contact.id })} aria-label="Open ${contact.email}">Open</button></td>
                        </tr>`,
                      )}
                    </tbody>
                  </table>
                </div>
                ${page.cursor ? html`<p><button @click=${() => void this.#query(page.cursor)}>Load more</button></p>` : ""}`,
        )}
      </div>`;
  }

  override render() {
    return this.contactId ? this.#detail(this.contactId) : this.#list();
  }
}

customElements.define("gtm-contacts", GtmContacts);
