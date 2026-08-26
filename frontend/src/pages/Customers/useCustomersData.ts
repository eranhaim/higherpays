import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { customersApi, type Customer, type CustomerDetail, type CreateCustomerInput, type ListCustomersQuery } from '../../api/endpoints';

/** The most the customers endpoint returns in one call. */
const PAGE_SIZE = 200;

export interface UseCustomersDataResult {
  customers: Customer[];
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
  createCustomer: (input: CreateCustomerInput) => Promise<void>;
  exportCsv: () => Promise<void>;
}

export function useCustomersData(query: Omit<ListCustomersQuery, 'limit' | 'offset'>): UseCustomersDataResult {
  const { activeWorkspaceId } = useCurrentSession();
  const queryClient = useQueryClient();
  const enabled = Boolean(activeWorkspaceId);

  const customers = useInfiniteQuery({
    queryKey: ['customers', activeWorkspaceId, query],
    queryFn: ({ pageParam }) => customersApi.list({ ...query, limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    // A short page means the end of the list; the endpoint returns no total.
    getNextPageParam: (last, pages) => (last.length < PAGE_SIZE ? undefined : pages.length * PAGE_SIZE),
    enabled,
  });

  const create = useMutation({
    mutationFn: (input: CreateCustomerInput) => customersApi.create(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['customers', activeWorkspaceId] }),
  });

  return {
    customers: customers.data?.pages.flat() ?? [],
    isLoading: customers.isLoading,
    isError: customers.isError,
    hasMore: customers.hasNextPage,
    isLoadingMore: customers.isFetchingNextPage,
    loadMore: () => { void customers.fetchNextPage(); },
    createCustomer: async (input) => { await create.mutateAsync(input); },
    exportCsv: () => customersApi.exportCsv(),
  };
}

/** One customer with their payment history, for the detail view. */
export function useCustomerDetail(id: string | null) {
  const { activeWorkspaceId } = useCurrentSession();
  return useQuery<CustomerDetail>({
    queryKey: ['customer', activeWorkspaceId, id],
    queryFn: () => customersApi.get(id as string),
    enabled: Boolean(activeWorkspaceId && id),
  });
}
