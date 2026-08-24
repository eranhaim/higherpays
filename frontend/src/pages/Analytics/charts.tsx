/**
 * Small chart primitives for the Analytics page. Pure CSS from `global.css`;
 * the only inline styles are data-driven sizes and opacities.
 */

import { useState, type ReactNode } from 'react';
import { formatMoney } from '../../lib/format';

export interface BarPoint {
  label: string;
  value: number;
}

interface BarChartProps {
  points: BarPoint[];
  currency: string;
}

export function BarChart({ points, currency }: BarChartProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(...points.map((p) => p.value), 1);
  const labelEvery = Math.max(1, Math.ceil(points.length / 10));
  const tip = hovered === null ? null : points[hovered];

  return (
    <div className="chartwrap">
      <div className="bars labelled">
        {points.map((p, i) => (
          <div
            key={p.label}
            className={i === hovered ? 'bar hi' : 'bar'}
            style={{ height: `${(p.value / max) * 100}%` }}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          >
            {i % labelEvery === 0 ? <span>{p.label}</span> : null}
          </div>
        ))}
      </div>
      <div
        className={tip ? 'chart-tip on' : 'chart-tip'}
        style={{ left: hovered === null ? 0 : `${((hovered + 0.5) / points.length) * 100}%` }}
      >
        {tip ? `${tip.label} · ${formatMoney(tip.value, currency)}` : ''}
      </div>
    </div>
  );
}

interface MetricRowProps {
  label: string;
  value: ReactNode;
  /** 0–100, width of the bar. */
  sharePct: number;
  /** Colour class for the bar fill; defaults to ink. */
  tone?: 'tone-muted' | 'tone-pos' | 'tone-info' | 'tone-accent';
}

export function MetricRow({ label, value, sharePct, tone }: MetricRowProps) {
  const width = Math.min(100, Math.max(0, sharePct));
  return (
    <div className="metric-row">
      <span className="ml">{label}</span>
      <span className="mt"><span className={tone} style={{ width: `${width}%` }} /></span>
      <span className="mv wide">{value}</span>
    </div>
  );
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

interface HeatmapProps {
  /** 7 rows (Sunday first) × 24 hours. */
  grid: number[][];
  currency: string;
}

export function Heatmap({ grid, currency }: HeatmapProps) {
  const max = Math.max(...grid.flat(), 1);
  return (
    <div className="heat">
      <div />
      {HOURS.map((h) => <div key={h} className="hh">{h % 3 === 0 ? h : ''}</div>)}
      {grid.map((row, day) => [
        <div key={`l${day}`} className="hl">{DAY_LABELS[day]}</div>,
        ...row.map((v, h) => (
          <div
            key={`${day}-${h}`}
            className={v > 0 ? 'hc on' : 'hc'}
            style={v > 0 ? { opacity: 0.15 + 0.85 * (v / max) } : undefined}
            title={`${DAY_LABELS[day]} ${h}:00 · ${formatMoney(v, currency)}`}
          />
        )),
      ])}
    </div>
  );
}
