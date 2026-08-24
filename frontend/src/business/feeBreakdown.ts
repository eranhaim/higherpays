/** Rates that apply to one workspace. Percentages are 0..100. */
export interface RateCard {
  blended: number;
  /** PSP share of the blended rate. Only visible to platform operators. */
  psp: number | null;
  /** HigherPays share of the blended rate. Only visible to platform operators. */
  margin: number | null;
  /** Fixed fee per transaction. */
  fixed: number;
  refundFee: number;
  chargebackFee: number;
  declineFee: number;
  reservePct: number;
  reserveReleaseDays: number;
}

export interface FeeBreakdown {
  amount: number;
  blendedPct: number;
  blendedFee: number;
  fixed: number;
  total: number;
  pspPct: number | null;
  marginPct: number | null;
  pspFee: number | null;
  marginFee: number | null;
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
    pspPct: rc.psp,
    marginPct: rc.margin,
    pspFee: rc.psp != null ? a * rc.psp / 100 : null,
    marginFee: rc.margin != null ? a * rc.margin / 100 : null,
    effectivePct: a > 0 ? total / a * 100 : 0,
    net: a - total,
  };
}
