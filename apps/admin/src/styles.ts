// GTM-agents: the dashboard's theme tokens and shared component styles. Colors are CSS variables
// on the document root, with a dark set chosen by the system or by the theme switch; components
// read them through their shadow roots. Page styles are adopted as a constructed stylesheet, so
// the strict content security policy needs no inline style.
import { css } from "lit";

export const pageStyles = css`
  :root {
    color-scheme: light;
    --bg: #f6f7f9;
    --surface: #ffffff;
    --surface-2: #eef0f3;
    --text: #1b1f24;
    --muted: #5b6470;
    --border: #d5d9df;
    --accent: #2457c5;
    --accent-text: #ffffff;
    --ok: #1e7a3c;
    --ok-bg: #e5f4ea;
    --warn: #8a5a00;
    --warn-bg: #fdf1d8;
    --bad: #b3261e;
    --bad-bg: #fce8e6;
    --focus: #2457c5;
    --chart-1: #2457c5;
    --chart-2: #8a5a00;
    --radius: 8px;
    --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --bg: #111418;
      --surface: #1a1f25;
      --surface-2: #232a32;
      --text: #e6e9ed;
      --muted: #9aa4b0;
      --border: #333c46;
      --accent: #7aa2f7;
      --accent-text: #0c1220;
      --ok: #6fcf8a;
      --ok-bg: #16301f;
      --warn: #f0c060;
      --warn-bg: #33280f;
      --bad: #f28b82;
      --bad-bg: #3a1a18;
      --focus: #7aa2f7;
      --chart-1: #7aa2f7;
      --chart-2: #f0c060;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #111418;
    --surface: #1a1f25;
    --surface-2: #232a32;
    --text: #e6e9ed;
    --muted: #9aa4b0;
    --border: #333c46;
    --accent: #7aa2f7;
    --accent-text: #0c1220;
    --ok: #6fcf8a;
    --ok-bg: #16301f;
    --warn: #f0c060;
    --warn-bg: #33280f;
    --bad: #f28b82;
    --bad-bg: #3a1a18;
    --focus: #7aa2f7;
    --chart-1: #7aa2f7;
    --chart-2: #f0c060;
  }
  html,
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: 15px;
    line-height: 1.45;
  }
`;

export const sharedStyles = css`
  :host {
    display: block;
  }
  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }
  h1 {
    font-size: 1.4rem;
    margin: 0 0 1rem;
  }
  h1:focus {
    outline: none;
  }
  h2 {
    font-size: 1.05rem;
    margin: 0 0 0.6rem;
  }
  h3 {
    font-size: 0.95rem;
    margin: 0 0 0.4rem;
  }
  p {
    margin: 0 0 0.6rem;
  }
  a {
    color: var(--accent);
  }
  .grid {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem;
    min-width: 0;
  }
.spaced {
    margin-top: 1rem;
  }
  .stack > * + * {
    margin-top: 1rem;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }
  .spread {
    justify-content: space-between;
  }
  .muted {
    color: var(--muted);
  }
  .small {
    font-size: 0.85rem;
  }
  .big {
    font-size: 1.6rem;
    font-weight: 600;
  }
  .mono {
    font-family: var(--mono);
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }
  .text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .pill {
    display: inline-block;
    padding: 0.05rem 0.5rem;
    border-radius: 999px;
    background: var(--surface-2);
    font-size: 0.8rem;
  }
  .pill.ok,
  .banner.ok {
    background: var(--ok-bg);
    color: var(--ok);
  }
  .pill.warn,
  .banner.warn {
    background: var(--warn-bg);
    color: var(--warn);
  }
  .pill.bad,
  .banner.bad {
    background: var(--bad-bg);
    color: var(--bad);
  }
  .banner {
    padding: 0.6rem 0.9rem;
    border-radius: var(--radius);
    background: var(--surface-2);
    margin-bottom: 1rem;
  }
  button,
  .button {
    font: inherit;
    font-size: 0.9rem;
    padding: 0.35rem 0.8rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    text-decoration: none;
  }
  button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-text);
  }
  button.danger {
    border-color: var(--bad);
    color: var(--bad);
  }
  button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  button:focus-visible,
  a:focus-visible,
  input:focus-visible,
  select:focus-visible,
  textarea:focus-visible,
  summary:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  input,
  select,
  textarea {
    font: inherit;
    font-size: 0.9rem;
    padding: 0.35rem 0.5rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    max-width: 100%;
  }
  textarea {
    width: 100%;
    min-height: 5rem;
  }
  label {
    display: inline-flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.85rem;
    color: var(--muted);
  }
  label.inline {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
    color: var(--text);
  }
  pre.draft-body {
    background: var(--surface-2);
    padding: 0.75rem;
    border-radius: var(--radius);
    font-family: var(--font);
    font-size: 0.9rem;
    margin: 0.5rem 0;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
  }
  th,
  td {
    text-align: left;
    padding: 0.4rem 0.5rem;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
    overflow-wrap: anywhere;
  }
  th {
    color: var(--muted);
    font-weight: 600;
  }
  .table-wrap {
    overflow-x: auto;
  }
  .error {
    color: var(--bad);
  }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  dl {
    margin: 0;
    display: grid;
    grid-template-columns: minmax(7rem, max-content) 1fr;
    gap: 0.25rem 0.75rem;
  }
  dt {
    color: var(--muted);
    font-size: 0.85rem;
  }
  dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  ul.plain {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  ul.plain > li + li {
    margin-top: 0.5rem;
  }
  svg.chart {
    display: block;
  }
  svg.bars {
    max-width: 32rem;
  }
  svg.spark {
    max-width: 16rem;
  }
  svg.chart text {
    font-size: 12px;
    fill: var(--text);
  }
  svg.chart text.label {
    fill: var(--muted);
  }
  svg.chart .bar {
    fill: var(--chart-1);
  }
  svg.chart .line {
    fill: none;
    stroke: var(--chart-1);
    stroke-width: 2;
  }
`;
