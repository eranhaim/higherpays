import { describe, it, expect } from 'vitest';
import { feeBreakdown, type RateCard } from './feeBreakdown';

const rc: RateCard = {
  currency: 'EUR',
  blended: 13,
  pspRate: 7,
  settlementRate: 1,
  marginRate: 5,
  fixed: 0.5,
  checkoutFee: 2,
};

/**
 * The same percentages with the flat amounts a shekel rate card would carry.
 * A flat fee cannot be shared between currencies: ILS 7 is roughly EUR 2.
 */
const ils: RateCard = { ...rc, currency: 'ILS', fixed: 2, checkoutFee: 7 };

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

  it('carries the rate card currency through, so no caller has to guess it', () => {
    expect(feeBreakdown(100, rc).currency).toBe('EUR');
    expect(feeBreakdown(100, ils).currency).toBe('ILS');
  });

  it('charges each currency its own flat amounts, not a converted one', () => {
    const b = feeBreakdown(400, ils);
    // Customer pays the price plus that currency's checkout fee.
    expect(b.customerTotal).toBe(407);
    expect(b.mdrFee).toBeCloseTo(28.49, 4);
    expect(b.fixed).toBe(2);
    expect(b.settlementBase).toBeCloseTo(376.51, 4);
    expect(b.settlementFee).toBeCloseTo(3.7651, 4);
    expect(b.marginFee).toBeCloseTo(20, 4);
    expect(b.total).toBeCloseTo(54.2551, 4);
    expect(b.net).toBeCloseTo(345.7449, 4);
    // The euro card's flat fees would have made it cheaper by the difference
    // in those two amounts alone, which is the whole reason they are per
    // currency.
    expect(b.total).toBeGreaterThan(feeBreakdown(400, rc).total);
  });

  it('treats a non-number amount as zero without dividing by it', () => {
    const b = feeBreakdown(Number.NaN, { ...rc, checkoutFee: 0 });
    expect(b.amount).toBe(0);
    expect(b.effectivePct).toBe(0);
    expect(b.total).toBe(0.5);
  });
});
