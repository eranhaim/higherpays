import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import {
  customersApi, accountsApi,
  type Customer, type Account, type CreateCustomerInput,
} from '../../api/endpoints';

/** The most the customers endpoint returns in one call. */
const PAGE_SIZE = 200;

export interface UseCustomersDataResult {
  customers: Customer[];
  accounts: Account[];
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
  createCustomer: (input: CreateCustomerInput) => Promise<void>;
  exportCsv: () => Promise<void>;
}

export function useCustomersData(): UseCustomersDataResult {
  const { activeWorkspaceId } = useCurrentSession();
  const queryClient = useQueryClient();
  const enabled = Boolean(activeWorkspaceId);

  const customers = useInfiniteQuery({
    queryKey: ['customers', activeWorkspaceId],
    queryFn: ({ pageParam }) => customersApi.list({ limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    // A short page means the end of the list; the endpoint returns no total.
    getNextPageParam: (last, pages) =>
      last.length < PAGE_SIZE ? undefined : pages.length * PAGE_SIZE,
    enabled,
  });
  const accounts = useQuery({
    queryKey: ['accounts', activeWorkspaceId],
    queryFn: () => accountsApi.list(),
    enabled,
  });

  const create = useMutation({
    mutationFn: (input: CreateCustomerInput) => customersApi.create(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['customers', activeWorkspaceId] }),
  });

  return {
    customers: customers.data?.pages.flat() ?? [],
    accounts: accounts.data ?? [],
    isLoading: customers.isLoading,
    isError: customers.isError,
    hasMore: customers.hasNextPage,
    isLoadingMore: customers.isFetchingNextPage,
    loadMore: () => { void customers.fetchNextPage(); },
    createCustomer: async (input) => {
      await create.mutateAsync(input);
    },
    exportCsv: () => customersApi.exportCsv(),
  };
}
