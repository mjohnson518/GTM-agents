// GTM-agents: renders a server record of unknown shape (the cockpit, configuration, a contact,
// link triage detail) as nested text. Every string is a text binding; a string that is an https
// URL is shown as text with a separate link built only from the checked URL.
import { html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { formatNumber, humanizeKey, safeHttpsUrl } from "../format.ts";

const MAX_DEPTH = 4;
const MAX_ITEMS = 100;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFlat(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && Object.values(value).every((v) => v === null || ["string", "number", "boolean"].includes(typeof v));
}

/** An https URL as text, followed by a link that opens it in a new tab without an opener. */
export function renderUrl(text: string): TemplateResult {
  const url = safeHttpsUrl(text);
  if (!url) return html`<span class="text">${text}</span>`;
  return html`<span class="text">${text}</span>
    <a href=${url} target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Open<span class="visually-hidden"> link in a new tab</span></a>`;
}

function renderScalar(value: unknown): TemplateResult | string {
  if (value === null || value === undefined) return html`<span class="muted">none</span>`;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return formatNumber(value, 2);
  if (typeof value === "string") return safeHttpsUrl(value) ? renderUrl(value) : html`<span class="text">${value}</span>`;
  return html`<span class="text">${JSON.stringify(value) ?? typeof value}</span>`;
}

function renderTable(rows: Array<Record<string, unknown>>): TemplateResult {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0, 8);
  return html`<div class="table-wrap">
    <table>
      <thead>
        <tr>
          ${columns.map((column) => html`<th scope="col">${humanizeKey(column)}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => html`<tr>${columns.map((column) => html`<td>${renderScalar(row[column])}</td>`)}</tr>`)}
      </tbody>
    </table>
  </div>`;
}

export function renderValue(value: unknown, depth = 0): TemplateResult | string {
  if (Array.isArray(value)) {
    if (value.length === 0) return html`<span class="muted">none</span>`;
    const items = value.slice(0, MAX_ITEMS);
    const more = value.length > MAX_ITEMS ? html`<p class="small muted">${value.length - MAX_ITEMS} more not shown.</p>` : nothing;
    if (items.every(isFlat) && items.length > 1) return html`${renderTable(items)}${more}`;
    return html`<ul class="plain">
        ${items.map((item) => html`<li>${renderValue(item, depth + 1)}</li>`)}
      </ul>
      ${more}`;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return html`<span class="muted">none</span>`;
    if (depth >= MAX_DEPTH) return html`<span class="mono text">${JSON.stringify(value)}</span>`;
    return html`<dl>
      ${entries.map(([key, inner]) => html`<dt>${humanizeKey(key)}</dt><dd>${renderValue(inner, depth + 1)}</dd>`)}
    </dl>`;
  }
  return renderScalar(value);
}
