/**
 * Small chart primitives for the Analytics page. Pure CSS from `global.css`;
 * the only inline styles are data-driven sizes and opacities.
 */

import { useState, type ReactNode } from 'react';
import { formatMoney } from '../../lib/format';

export interface BarPoint {
  /** Unique across the series. Labels repeat once a range spans two years. */
  id: string;
  label: string;
  value: number;
}

interface BarChartProps {
  points: BarPoint[];
  currency: string;
}

/**
 * Horizontal centre of the hovered bar, held far enough from either edge that
 * the tooltip — which is centred on this point — stays inside the chart.
 */
function tipLeftPct(hovered: number | null, count: number): number {
  if (hovered === null || count === 0) return 0;
  const centre = ((hovered + 0.5) / count) * 100;
  return Math.min(88, Math.max(12, centre));
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
            key={p.id}
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
        // Kept clear of both edges so the tip cannot spill out of the card.
        style={{ left: `${tipLeftPct(hovered, points.length)}%` }}
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
        ...row.map((v, h) => {
          const reading = `${DAY_LABELS[day]} ${h}:00 · ${formatMoney(v, currency)}`;
          return (
            <div
              key={`${day}-${h}`}
              className={v > 0 ? 'hc on' : 'hc'}
              // Floored at 0.4: below that a filled cell is indistinguishable
              // from an empty one on the paper background.
              style={v > 0 ? { opacity: 0.4 + 0.6 * (v / max) } : undefined}
              // role=img carries the value to a screen reader without putting
              // 168 cells in the tab order; title covers pointer users.
              role="img"
              aria-label={reading}
              title={reading}
            />
          );
        }),
      ])}
    </div>
  );
}
