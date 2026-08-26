import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import {
  paymentsApi, categoriesApi, customersApi, accountsApi, agentsApi,
  type Payment, type ListPaymentsQuery, type CompletePaymentInput, type Category, type Customer, type Account, type Agent,
} from '../../api/endpoints';

export interface UsePaymentsDataResult {
  payments: Payment[];
  categories: Category[];
  customers: Customer[];
  accounts: Account[];
  agents: Agent[];
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
  complete: (id: string, input: CompletePaymentInput) => Promise<Payment>;
  /** Records a refund already issued in the provider dashboard. */
  recordRefund: (id: string) => Promise<void>;
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
  const categories = useQuery({
    queryKey: ['categories', activeWorkspaceId],
    queryFn: () => categoriesApi.list(),
    enabled,
    staleTime: 5 * 60_000,
  });
  const customers = useQuery({
    queryKey: ['customers', activeWorkspaceId, 'picker'],
    queryFn: () => customersApi.list({ limit: 200 }),
    enabled,
  });
  const accounts = useQuery({
    queryKey: ['accounts', activeWorkspaceId],
    queryFn: () => accountsApi.list(),
    enabled: enabled && canScope,
  });
  const agents = useQuery({
    queryKey: ['agents', activeWorkspaceId],
    queryFn: () => agentsApi.list(),
    enabled: enabled && canScope,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['payments', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['links', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['customers', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['payouts-breakdown', activeWorkspaceId] });
  };

  const complete = useMutation({
    mutationFn: ({ id, input }: { id: string; input: CompletePaymentInput }) => paymentsApi.complete(id, input),
    onSuccess: invalidate,
  });
  const refund = useMutation({
    mutationFn: (id: string) => paymentsApi.refund(id),
    onSuccess: invalidate,
  });

  return {
    payments: payments.data?.pages.flatMap((p) => p.items) ?? [],
    categories: categories.data ?? [],
    customers: customers.data ?? [],
    accounts: accounts.data ?? [],
    agents: agents.data ?? [],
    isLoading: payments.isLoading,
    isError: payments.isError,
    hasMore: payments.hasNextPage,
    isLoadingMore: payments.isFetchingNextPage,
    loadMore: () => { void payments.fetchNextPage(); },
    complete: (id, input) => complete.mutateAsync({ id, input }),
    recordRefund: async (id) => { await refund.mutateAsync(id); },
  };
}
