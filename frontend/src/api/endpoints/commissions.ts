import { api } from '../http';
import { workspacePath } from '../workspacePath';

/**
 * Workspace commission configuration.
 *
 * The wire format uses snake_case; we normalize on read so the rest of the
 * frontend never has to.
 */
export interface CommissionConfig {
  creatorSplitPct: number;
  agencySplitPct: number;
  chatterPct: number;
  effectiveFrom: string | null;
}

export interface PlatformFeeBreakdown {
  pspRatePct: number;
  marginRatePct: number;
  blendedRatePct: number;
}

interface RawCommissionResponse {
  commission: {
    creator_split_pct: number | string;
    agency_split_pct: number | string;
    chatter_pct: number | string;
    effective_from: string | null;
  };
  platformFee: {
    psp_rate_pct: number | string;
    margin_rate_pct: number | string;
    blended_rate_pct: number | string;
  } | null;
}

function toNumber(v: unknown, fallback = 0): number {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : fallback;
}

export const commissionsApi = {
  async get(): Promise<{ commission: CommissionConfig; platformFee: PlatformFeeBreakdown | null }> {
    const raw = await api.get<RawCommissionResponse>(workspacePath('/commissions'));
    return {
      commission: {
        creatorSplitPct: toNumber(raw.commission.creator_split_pct, 70),
        agencySplitPct: toNumber(raw.commission.agency_split_pct, 30),
        chatterPct: toNumber(raw.commission.chatter_pct, 0),
        effectiveFrom: raw.commission.effective_from,
      },
      platformFee: raw.platformFee
        ? {
            pspRatePct: toNumber(raw.platformFee.psp_rate_pct),
            marginRatePct: toNumber(raw.platformFee.margin_rate_pct),
            blendedRatePct: toNumber(raw.platformFee.blended_rate_pct),
          }
        : null,
    };
  },

  async set(input: { creatorSplitPct: number; chatterPct: number }) {
    const raw = await api.put<RawCommissionResponse>(workspacePath('/commissions'), input);
    return {
      commission: {
        creatorSplitPct: toNumber(raw.commission.creator_split_pct, 70),
        agencySplitPct: toNumber(raw.commission.agency_split_pct, 30),
        chatterPct: toNumber(raw.commission.chatter_pct, 0),
        effectiveFrom: raw.commission.effective_from,
      },
    };
  },
};
