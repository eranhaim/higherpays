import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { useTimezone } from '../../hooks/useTimezone';
import { payoutsApi, type PayoutBreakdown, type RunPayoutInput } from '../../api/endpoints';
import type { DateRange } from '../../components/ui';
import { startOfMonthTZ, startOfWeekTZ } from '../../business/timezone';
import { DAY_MS } from '../../lib/format';

export type PayoutPeriod = 'week' | 'month' | 'all';

export interface UsePayoutsDataResult {
  data: PayoutBreakdown | null;
  isLoading: boolean;
  isError: boolean;
  /** Settles unpaid balances for one payee, or every payee of that type when `targetId` is omitted. */
  pay: (input: Pick<RunPayoutInput, 'payeeType' | 'targetId'>) => Promise<{ ran: number; total: number }>;
  isPaying: boolean;
}

export function usePayoutsData(period: PayoutPeriod, custom?: DateRange): UsePayoutsDataResult {
  const { activeWorkspaceId } = useCurrentSession();
  const tz = useTimezone();
  const queryClient = useQueryClient();

  // Fixed at mount so the range does not drift between renders.
  const [now] = useState(() => Date.now());
  const range = useMemo(() => {
    if (custom && (custom.from || custom.to)) {
      // The picker yields whole days; the ledger compares timestamps, so the
      // upper bound has to cover all of the closing day.
      return {
        from: custom.from ? new Date(`${custom.from}T00:00:00`).toISOString() : new Date(0).toISOString(),
        to: custom.to ? new Date(`${custom.to}T23:59:59.999`).toISOString() : new Date(now).toISOString(),
      };
    }
    const from =
      period === 'week' ? startOfWeekTZ(now, tz) :
      period === 'month' ? startOfMonthTZ(now, tz) :
      now - 365 * DAY_MS;
    return { from: new Date(from).toISOString(), to: new Date(now).toISOString() };
  }, [period, now, tz, custom]);

  const query = useQuery({
    queryKey: ['payouts-breakdown', activeWorkspaceId, range.from, range.to],
    queryFn: () => payoutsApi.getBreakdown(range.from, range.to),
    enabled: Boolean(activeWorkspaceId),
  });

  const run = useMutation({
    mutationFn: (input: Pick<RunPayoutInput, 'payeeType' | 'targetId'>) =>
      payoutsApi.run({ ...input, from: range.from, to: range.to }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['payouts-breakdown', activeWorkspaceId] }),
  });

  return {
    data: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    pay: async (input) => {
      const result = await run.mutateAsync(input);
      return { ran: result.ran, total: result.total };
    },
    isPaying: run.isPending,
  };
}
