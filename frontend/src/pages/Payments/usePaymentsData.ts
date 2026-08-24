import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { payoutsApi, type Transaction } from '../../api/endpoints';

export interface UsePaymentsDataResult {
  transactions: Transaction[];
  isLoading: boolean;
  isError: boolean;
  /** Records a refund that was already issued in the provider dashboard. */
  recordRefund: (transactionId: string) => Promise<void>;
}

export function usePaymentsData(): UsePaymentsDataResult {
  const { activeWorkspaceId } = useCurrentSession();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['transactions', activeWorkspaceId],
    queryFn: () => payoutsApi.listTransactions(),
    enabled: Boolean(activeWorkspaceId),
  });

  const refund = useMutation({
    mutationFn: (transactionId: string) => payoutsApi.refund(transactionId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['payouts-breakdown', activeWorkspaceId] });
    },
  });

  return {
    transactions: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    recordRefund: async (transactionId) => {
      await refund.mutateAsync(transactionId);
    },
  };
}
