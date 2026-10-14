/**
 * The workspace's rate card: blended fee %, fixed fee per transaction, refund
 * and chargeback fees, rolling reserve. Sourced from `/platform-fee`.
 *
 * The percentages are the agency's and apply to every currency, but the flat
 * amounts do not translate, so the card is fetched per currency and carries
 * the currency it is for. Anything priced off it must display that currency
 * rather than assume the agency's base one.
 */

import { useQuery } from '@tanstack/react-query';
import { workspacesApi, type PlatformFee } from '../api/endpoints';
import type { RateCard } from '../business/feeBreakdown';
import { useCurrentSession } from './useCurrentSession';

// Unknown until the request lands — not "zero fee".
const emptyRateCard = (currency: string): RateCard => ({
  currency,
  blended: 0,
  pspRate: 0,
  settlementRate: 0,
  marginRate: 0,
  fixed: 0,
  checkoutFee: 0,
});

// The reversal fees and the reserve reach only callers who see the whole
// workspace. For an agent the fee preview still works: it needs the blended
// rate and the fixed fee, which everyone who can read a link receives. The
// withheld ones stay undefined so the UI can say "not shown" rather than "0".
function toRateCard(f: PlatformFee): RateCard {
  return {
    currency: f.currency,
    blended: f.blendedRatePct,
    pspRate: f.pspRatePct,
    settlementRate: f.settlementPct,
    marginRate: f.marginRatePct,
    fixed: f.pspFixedFee,
    checkoutFee: f.checkoutFee,
    refundFee: f.refundFee,
    chargebackFee: f.chargebackFee,
    declineFee: f.declineFee,
    reservePct: f.reservePct,
    reserveReleaseDays: f.reserveReleaseDays,
  };
}

interface UseRateCardResult {
  rateCard: RateCard;
  isLoading: boolean;
  isError: boolean;
  providerRefundAvailable: boolean;
}

/** @param currency which currency's flat amounts to fetch. Defaults to the base one. */
export function useRateCard(currency?: string): UseRateCardResult {
  const { activeWorkspaceId, currency: baseCurrency } = useCurrentSession();
  const wanted = currency ?? baseCurrency;

  const query = useQuery({
    queryKey: ['platform-fee', activeWorkspaceId, wanted],
    queryFn: () => workspacesApi.getPlatformFee(wanted),
    enabled: Boolean(activeWorkspaceId),
    staleTime: 5 * 60_000,
  });

  return {
    rateCard: query.data ? toRateCard(query.data) : emptyRateCard(wanted),
    isLoading: query.isLoading,
    isError: query.isError,
    providerRefundAvailable: query.data?.providerRefundAvailable ?? false,
  };
}
