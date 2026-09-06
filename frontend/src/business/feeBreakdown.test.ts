import { describe, it, expect } from 'vitest';
import { feeBreakdown, type RateCard } from './feeBreakdown';

const rc: RateCard = {
  blended: 13,
  pspRate: 7,
  settlementRate: 1,
  marginRate: 5,
  fixed: 0.5,
  checkoutFee: 2,
};

describe('feeBreakdown', () => {
  it('applies MDR to the customer total and settlement after the fixed fee', () => {
    const b = feeBreakdown(100, rc);
    expect(b.customerTotal).toBe(102);
    expect(b.mdrFee).toBeCloseTo(7.14, 4);
    expect(b.fixed).toBe(0.5);
    expect(b.settlementBase).toBeCloseTo(94.36, 4);
    expect(b.settlementFee).toBeCloseTo(0.9436, 4);
    expect(b.marginFee).toBeCloseTo(5, 4);
    expect(b.total).toBeCloseTo(13.5836, 4);
    expect(b.net).toBeCloseTo(86.4164, 4);
  });

  it('reports the effective rate, which the fixed fee pushes up on small tickets', () => {
    expect(feeBreakdown(100, rc).effectivePct).toBeCloseTo(13.5836, 4);
  });

  it('treats a non-number amount as zero without dividing by it', () => {
    const b = feeBreakdown(Number.NaN, { ...rc, checkoutFee: 0 });
    expect(b.amount).toBe(0);
    expect(b.effectivePct).toBe(0);
    expect(b.total).toBe(0.5);
  });
});
