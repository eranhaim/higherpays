import { describe, it, expect } from 'vitest';
import { feeBreakdown, type RateCard } from './feeBreakdown';

const rc: RateCard = {
  blended: 13,
  psp: 8,
  margin: 5,
  fixed: 0.5,
  refundFee: 15,
  chargebackFee: 60,
  declineFee: 0,
  reservePct: 0,
  reserveReleaseDays: 0,
};

describe('feeBreakdown', () => {
  it('splits a EUR 100 sale into blended + fixed', () => {
    const b = feeBreakdown(100, rc);
    expect(b.amount).toBe(100);
    expect(b.blendedFee).toBe(13);
    expect(b.fixed).toBe(0.5);
    expect(b.total).toBeCloseTo(13.5, 4);
    expect(b.net).toBeCloseTo(86.5, 4);
  });

  it('reports the effective percentage of the total charge', () => {
    const b = feeBreakdown(100, rc);
    expect(b.effectivePct).toBeCloseTo(13.5, 4);
  });

  it('returns 0 fees on a 0 sale without dividing by zero', () => {
    const b = feeBreakdown(0, rc);
    expect(b.total).toBe(0.5);
    expect(b.effectivePct).toBe(0);
    expect(b.net).toBeCloseTo(-0.5, 4);
  });

  it('exposes psp/margin components when the rate card has a split', () => {
    const b = feeBreakdown(200, rc);
    expect(b.pspFee).toBeCloseTo(16, 4);
    expect(b.marginFee).toBeCloseTo(10, 4);
  });

  it('leaves psp/margin as null when the rate card has none', () => {
    const flat: RateCard = { ...rc, psp: null, margin: null };
    const b = feeBreakdown(100, flat);
    expect(b.pspFee).toBeNull();
    expect(b.marginFee).toBeNull();
  });

  it('coerces non-numeric input to 0 rather than propagating NaN', () => {
    const b = feeBreakdown(Number.NaN, rc);
    expect(b.amount).toBe(0);
    expect(b.total).toBe(0.5);
  });
});
