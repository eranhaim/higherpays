/** Rates that apply to one workspace. Percentages are 0..100. */
export interface RateCard {
  /** What the agency is charged: PSP cost plus HigherPays margin, as one number. */
  blended: number;
  /** Fixed fee per transaction. */
  fixed: number;
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
  blendedPct: number;
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
  const blendedFee = a * rc.blended / 100;
  const fixed = rc.fixed;
  const total = blendedFee + fixed;
  return {
    amount: a,
    blendedPct: rc.blended,
    blendedFee,
    fixed,
    total,
    effectivePct: a > 0 ? total / a * 100 : 0,
    net: a - total,
  };
}
