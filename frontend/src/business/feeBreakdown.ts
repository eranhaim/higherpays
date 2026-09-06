/** Rates that apply to one workspace. Percentages are 0..100. */
export interface RateCard {
  /** Nominal variable rate: MDR + settlement + HigherPays margin. */
  blended: number;
  /** MDR applied to the content price plus the customer-paid checkout fee. */
  pspRate: number;
  /** Applied after MDR and the fixed transaction fee. */
  settlementRate: number;
  /** HigherPays' percentage, applied to the content price only. */
  marginRate: number;
  /** Fixed fee per transaction. */
  fixed: number;
  /** Added to the content price and paid by the customer. */
  checkoutFee: number;
  // Agency treasury settings. Undefined — not zero — when the caller is scoped
  // to their own rows and the server withheld them; a 0 here would read as a
  // real "no chargeback fee" rather than "not shown to you".
  refundFee?: number;
  chargebackFee?: number;
  declineFee?: number;
  reservePct?: number;
  reserveReleaseDays?: number;
}

export interface FeeBreakdown {
  amount: number;
  customerTotal: number;
  blendedPct: number;
  mdrFee: number;
  settlementBase: number;
  settlementFee: number;
  marginFee: number;
  blendedFee: number;
  fixed: number;
  total: number;
  /** Total fees as a percentage of the amount. */
  effectivePct: number;
  net: number;
}

/** What a single payment of `amount` costs in fees under `rc`. */
export function feeBreakdown(amount: number, rc: RateCard): FeeBreakdown {
  const a = Number.isFinite(amount) ? amount : 0;
  const customerTotal = a + rc.checkoutFee;
  const mdrFee = customerTotal * rc.pspRate / 100;
  const fixed = rc.fixed;
  const settlementBase = Math.max(customerTotal - mdrFee - fixed, 0);
  const settlementFee = settlementBase * rc.settlementRate / 100;
  const marginFee = a * rc.marginRate / 100;
  const blendedFee = mdrFee + settlementFee + marginFee;
  const total = blendedFee + fixed;
  return {
    amount: a,
    customerTotal,
    blendedPct: rc.blended,
    mdrFee,
    settlementBase,
    settlementFee,
    marginFee,
    blendedFee,
    fixed,
    total,
    effectivePct: a > 0 ? total / a * 100 : 0,
    net: a - total,
  };
}
