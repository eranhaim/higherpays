import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { payoutsApi, type Transaction } from '../../api/endpoints';

export interface UsePaymentsDataResult {
  transactions: Transaction[];
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
  /** Records a refund that was already issued in the provider dashboard. */
  recordRefund: (transactionId: string) => Promise<void>;
}

export function usePaymentsData(): UsePaymentsDataResult {
  const { activeWorkspaceId } = useCurrentSession();
  const queryClient = useQueryClient();

  const query = useInfiniteQuery({
    queryKey: ['transactions', activeWorkspaceId],
    queryFn: ({ pageParam }) => payoutsApi.listTransactions(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
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
    transactions: query.data?.pages.flatMap((p) => p.items) ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    hasMore: query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: () => { void query.fetchNextPage(); },
    recordRefund: async (transactionId) => {
      await refund.mutateAsync(transactionId);
    },
  };
}
