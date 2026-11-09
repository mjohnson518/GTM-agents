// GTM-agents: the dashboard's two charts, drawn as inline SVG with no chart library: a horizontal
// bar chart and a sparkline. Labels are text bindings and each chart carries a text summary for
// screen readers.
import { html, svg } from "lit";
import type { TemplateResult } from "lit";
import { formatNumber } from "../format.ts";

export interface Bar {
  label: string;
  value: number;
}

export function barChart(bars: readonly Bar[], title: string, format: (value: number) => string = (v) => formatNumber(v)): TemplateResult {
  if (bars.length === 0) return html`<p class="muted small">Nothing to chart yet.</p>`;
  const max = Math.max(1, ...bars.map((bar) => (Number.isFinite(bar.value) ? bar.value : 0)));
  const rowHeight = 22;
  const labelWidth = 120;
  const width = 360;
  const height = bars.length * rowHeight;
  const summary = `${title}: ${bars.map((bar) => `${bar.label} ${format(bar.value)}`).join(", ")}`;
  return html`<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label=${summary} class="chart bars">
    ${bars.map((bar, index) => {
      const y = index * rowHeight;
      const value = Number.isFinite(bar.value) ? Math.max(0, bar.value) : 0;
      const barWidth = Math.round(((width - labelWidth - 60) * value) / max);
      return svg`
        <text class="label" x="0" y=${y + 15}>${bar.label.length > 18 ? `${bar.label.slice(0, 17)}...` : bar.label}</text>
        <rect class="bar" x=${labelWidth} y=${y + 4} width=${barWidth} height="14" rx="2"></rect>
        <text class="value" x=${labelWidth + barWidth + 6} y=${y + 15}>${format(bar.value)}</text>`;
    })}
  </svg>`;
}

/** A line over the points; null points are gaps, never zero. */
export function sparkline(points: ReadonlyArray<number | null>, title: string): TemplateResult {
  const values = points.filter((point): point is number => point !== null && Number.isFinite(point));
  if (values.length < 2) return html`<p class="muted small">Not enough data for a trend.</p>`;
  const width = 240;
  const height = 48;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const segments: string[] = [];
  let current = "";
  points.forEach((point, index) => {
    if (point === null || !Number.isFinite(point)) {
      if (current) segments.push(current);
      current = "";
      return;
    }
    const x = (index * step).toFixed(1);
    const y = (height - 4 - ((point - min) / span) * (height - 8)).toFixed(1);
    current += `${current ? " L" : "M"}${x} ${y}`;
  });
  if (current) segments.push(current);
  const last = values[values.length - 1]!;
  const summary = `${title}: ${values.length} points from ${formatNumber(min, 2)} to ${formatNumber(max, 2)}, latest ${formatNumber(last, 2)}`;
  return html`<svg viewBox="0 0 ${width} ${height}" width="100%" height=${height} role="img" aria-label=${summary} class="chart spark">
    ${segments.map((d) => svg`<path class="line" d=${d}></path>`)}
  </svg>`;
}
