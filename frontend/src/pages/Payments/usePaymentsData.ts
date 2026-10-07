import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import {
  paymentsApi, accountsApi, agentsApi,
  type Payment, type ListPaymentsQuery, type Account, type Agent, type PaymentFilterOptions,
  type ReassignInput, type PaymentsSummary,
} from '../../api/endpoints';

/** What the export dialog collects. Range strings are yyyy-mm-dd, '' for open. */
export interface ExportInput {
  from: string;
  to: string;
  columns: string[];
  limit?: number;
}

export interface UsePaymentsDataResult {
  payments: Payment[];
  summary: PaymentsSummary | null;
  accounts: Account[];
  agents: Agent[];
  filterOptions: PaymentFilterOptions | null;
  isLoading: boolean;
  isError: boolean;
  isSummaryLoading: boolean;
  isSummaryError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
  /** Records a reversal already issued in the provider dashboard. */
  recordReversal: (id: string, kind: 'refund' | 'chargeback') => Promise<void>;
  /** Moves one payment to another creator or agent. */
  reassign: (id: string, input: ReassignInput) => Promise<void>;
  archivePayment: (id: string) => Promise<void>;
  exportCsv: (input: ExportInput) => Promise<void>;
}

export function usePaymentsData(filters: ListPaymentsQuery, canScope: boolean): UsePaymentsDataResult {
  const { activeWorkspaceId } = useCurrentSession();
  const queryClient = useQueryClient();
  const enabled = Boolean(activeWorkspaceId);

  // Filters are part of the key: changing one starts a fresh paginated result
  // from the server rather than re-filtering whatever happens to be loaded.
  const payments = useInfiniteQuery({
    queryKey: ['payments', activeWorkspaceId, filters],
    queryFn: ({ pageParam }) => paymentsApi.list(pageParam, filters),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });
  const summary = useQuery({
    queryKey: ['payments-summary', activeWorkspaceId, filters],
    queryFn: () => paymentsApi.summary(filters),
    enabled,
  });
  const filterOptions = useQuery({
    queryKey: ['payment-filter-options', activeWorkspaceId],
    queryFn: () => paymentsApi.filters(),
    enabled,
    staleTime: 5 * 60_000,
  });
  const accounts = useQuery({
    queryKey: ['accounts', activeWorkspaceId],
    queryFn: () => accountsApi.list(),
    enabled: enabled && canScope,
  });
  const agents = useQuery({
    queryKey: ['agents', activeWorkspaceId, 'include-archived'],
    queryFn: () => agentsApi.list({ showArchived: true }),
    enabled: enabled && canScope,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['payments', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['payments-summary', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['payment-filter-options', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['links', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['links-summary', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['customers', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['payouts-breakdown', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['analytics', activeWorkspaceId] });
  };

  const reassign = useMutation({
    mutationFn: ({ id, input }: { id: string; input: ReassignInput }) => paymentsApi.reassign(id, input),
    onSuccess: invalidate,
  });
  const reverse = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind: 'refund' | 'chargeback' }) =>
      kind === 'refund' ? paymentsApi.refund(id) : paymentsApi.chargeback(id),
    onSuccess: invalidate,
  });
  const archive = useMutation({
    mutationFn: (id: string) => paymentsApi.archive(id),
    onSuccess: invalidate,
  });

  return {
    payments: payments.data?.pages.flatMap((p) => p.items) ?? [],
    summary: summary.data ?? null,
    accounts: accounts.data ?? [],
    agents: agents.data ?? [],
    filterOptions: filterOptions.data ?? null,
    isLoading: payments.isLoading,
    isError: payments.isError,
    isSummaryLoading: summary.isPending,
    isSummaryError: summary.isError,
    hasMore: payments.hasNextPage,
    isLoadingMore: payments.isFetchingNextPage,
    loadMore: () => { void payments.fetchNextPage(); },
    recordReversal: async (id, kind) => { await reverse.mutateAsync({ id, kind }); },
    reassign: async (id, input) => { await reassign.mutateAsync({ id, input }); },
    archivePayment: (id) => archive.mutateAsync(id).then(() => undefined),
    exportCsv: (input) => paymentsApi.exportCsv(
      { ...filters, from: input.from || undefined, to: input.to || undefined },
      { columns: input.columns, limit: input.limit },
    ),
  };
}
