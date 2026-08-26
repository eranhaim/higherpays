import { describe, it, expect } from 'vitest';
import { feeBreakdown, type RateCard } from './feeBreakdown';

const rc: RateCard = { blended: 13, fixed: 0.5 };

describe('feeBreakdown', () => {
  it('applies the blended rate plus the fixed fee', () => {
    const b = feeBreakdown(200, rc);
    expect(b.blendedFee).toBeCloseTo(26, 4);
    expect(b.fixed).toBe(0.5);
    expect(b.total).toBeCloseTo(26.5, 4);
    expect(b.net).toBeCloseTo(173.5, 4);
  });

  it('reports the effective rate, which the fixed fee pushes up on small tickets', () => {
    expect(feeBreakdown(5, rc).effectivePct).toBeCloseTo(23, 4);
    expect(feeBreakdown(100, rc).effectivePct).toBeCloseTo(13.5, 4);
  });

  it('treats a non-number amount as zero without dividing by it', () => {
    const b = feeBreakdown(Number.NaN, rc);
    expect(b.amount).toBe(0);
    expect(b.effectivePct).toBe(0);
    expect(b.total).toBe(0.5);
  });
});
