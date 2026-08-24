/**
 * The workspace's rate card: blended fee %, fixed fee per transaction, refund
 * and chargeback fees, rolling reserve. Sourced from `/platform-fee`.
 */

import { useQuery } from '@tanstack/react-query';
import { workspacesApi, type PlatformFee } from '../api/endpoints';
import type { RateCard } from '../business/feeBreakdown';
import { useCurrentSession } from './useCurrentSession';

const EMPTY_RATE_CARD: RateCard = {
  blended: 0,
  psp: null,
  margin: null,
  fixed: 0,
  refundFee: 0,
  chargebackFee: 0,
  declineFee: 0,
  reservePct: 0,
  reserveReleaseDays: 0,
};

function toRateCard(f: PlatformFee): RateCard {
  return {
    blended: f.blendedRatePct,
    psp: f.pspRatePct ?? null,
    margin: f.marginRatePct ?? null,
    fixed: f.pspFixedFee,
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

export function useRateCard(): UseRateCardResult {
  const { activeWorkspaceId } = useCurrentSession();

  const query = useQuery({
    queryKey: ['platform-fee', activeWorkspaceId],
    queryFn: () => workspacesApi.getPlatformFee(),
    enabled: Boolean(activeWorkspaceId),
    staleTime: 5 * 60_000,
  });

  return {
    rateCard: query.data ? toRateCard(query.data) : EMPTY_RATE_CARD,
    isLoading: query.isLoading,
    isError: query.isError,
    providerRefundAvailable: query.data?.providerRefundAvailable ?? false,
  };
}
