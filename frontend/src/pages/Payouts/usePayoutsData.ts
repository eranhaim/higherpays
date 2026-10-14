import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { useReportingCurrency } from '../../hooks/useReportingCurrency';
import { useTimezone } from '../../hooks/useTimezone';
import {
  payoutsApi, meApi,
  type PayoutBreakdown, type PayoutRecord, type RunPayoutInput, type Earnings, type PayoutHistoryFilters,
} from '../../api/endpoints';
import type { DateRange } from '../../components/ui';
import { parseDateTZ } from '../../business/timezone';

/**
 * The picker yields whole days in the user's timezone; the ledger compares
 * timestamps, so the upper bound has to cover all of the closing day. An open
 * bound is "from the beginning" or "until now".
 */
function useIsoRange(selected: DateRange) {
  const tz = useTimezone();
  // Fixed at mount so an open bound does not drift between renders.
  const [now] = useState(() => Date.now());
  return useMemo(() => {
    const from = parseDateTZ(selected.from, false, tz);
    const to = parseDateTZ(selected.to, true, tz);
    return { from: new Date(from ?? 0).toISOString(), to: new Date(to ?? now).toISOString() };
  }, [selected.from, selected.to, now, tz]);
}

export interface UsePayoutsDataResult {
  data: PayoutBreakdown | null;
  history: PayoutRecord[];
  isLoading: boolean;
  isError: boolean;
  isHistoryLoading: boolean;
  isHistoryError: boolean;
  /**
   * Settles unpaid balances for one payee, or every payee of that type when
   * `targetId` is omitted, in the currency the page is reporting.
   */
  pay: (input: Pick<RunPayoutInput, 'payeeType' | 'targetId'>) => Promise<{ ran: number; total: number; currency: string }>;
  isPaying: boolean;
}

export function usePayoutsData(selected: DateRange, historyFilters: PayoutHistoryFilters): UsePayoutsDataResult {
  const { activeWorkspaceId } = useCurrentSession();
  const { currency } = useReportingCurrency();
  const queryClient = useQueryClient();
  const range = useIsoRange(selected);

  // What is owed, what has been paid, and what is run are all in the page's
  // one currency: two currencies owed to the same creator are two debts.
  const breakdown = useQuery({
    queryKey: ['payouts-breakdown', activeWorkspaceId, range.from, range.to, currency],
    queryFn: () => payoutsApi.getBreakdown(range.from, range.to, currency),
    enabled: Boolean(activeWorkspaceId),
  });
  const history = useQuery({
    queryKey: ['payouts-history', activeWorkspaceId, historyFilters, currency],
    queryFn: () => payoutsApi.list({ ...historyFilters, currency }),
    enabled: Boolean(activeWorkspaceId),
  });

  const run = useMutation({
    mutationFn: (input: Pick<RunPayoutInput, 'payeeType' | 'targetId'>) =>
      payoutsApi.run({ ...input, from: range.from, to: range.to, currency }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payouts-breakdown', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['payouts-history', activeWorkspaceId] });
    },
  });

  return {
    data: breakdown.data ?? null,
    history: history.data ?? [],
    isLoading: breakdown.isLoading,
    isError: breakdown.isError,
    isHistoryLoading: history.isLoading,
    isHistoryError: history.isError,
    pay: async (input) => {
      const result = await run.mutateAsync(input);
      return { ran: result.ran, total: result.total, currency: result.currency };
    },
    isPaying: run.isPending,
  };
}

/** The signed-in agent's or owner's own figures, in one currency. */
export function useEarnings(selected: DateRange) {
  const { activeWorkspaceId } = useCurrentSession();
  const { currency } = useReportingCurrency();
  const range = useIsoRange(selected);
  const query = useQuery<Earnings>({
    queryKey: ['earnings', activeWorkspaceId, range.from, range.to, currency],
    queryFn: () => meApi.earnings(range.from, range.to, currency),
    enabled: Boolean(activeWorkspaceId),
  });
  return { earnings: query.data ?? null, isLoading: query.isLoading, isError: query.isError };
}
