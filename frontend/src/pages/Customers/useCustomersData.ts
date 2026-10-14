import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { useReportingCurrency } from '../../hooks/useReportingCurrency';
import { customersApi, type CustomerListItem, type CustomerDetail, type CreateCustomerInput, type UpdateCustomerInput, type ListCustomersQuery } from '../../api/endpoints';

/** The most the customers endpoint returns in one call. */
const PAGE_SIZE = 200;

export interface UseCustomersDataResult {
  customers: CustomerListItem[];
  /** The currency the spend column is in. */
  currency: string;
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
  createCustomer: (input: CreateCustomerInput) => Promise<void>;
  updateCustomer: (id: string, input: UpdateCustomerInput) => Promise<void>;
  /** Wipes name and contact details; payments stay, anonymised. */
  eraseCustomer: (id: string) => Promise<void>;
  exportCsv: () => Promise<void>;
}

export function useCustomersData(query: Omit<ListCustomersQuery, 'limit' | 'offset' | 'currency'>): UseCustomersDataResult {
  const { activeWorkspaceId } = useCurrentSession();
  const { currency } = useReportingCurrency();
  const queryClient = useQueryClient();
  const enabled = Boolean(activeWorkspaceId);

  const customers = useInfiniteQuery({
    queryKey: ['customers', activeWorkspaceId, currency, query],
    queryFn: ({ pageParam }) => customersApi.list({ ...query, currency, limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    // A short page means the end of the list; the endpoint returns no total.
    getNextPageParam: (last, pages) => (last.length < PAGE_SIZE ? undefined : pages.length * PAGE_SIZE),
    enabled,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['customers', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['customer', activeWorkspaceId] });
  };
  const create = useMutation({ mutationFn: (input: CreateCustomerInput) => customersApi.create(input), onSuccess: invalidate });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateCustomerInput }) => customersApi.update(id, input),
    onSuccess: invalidate,
  });
  const erase = useMutation({ mutationFn: (id: string) => customersApi.erase(id), onSuccess: invalidate });

  return {
    customers: customers.data?.pages.flat() ?? [],
    currency,
    isLoading: customers.isLoading,
    isError: customers.isError,
    hasMore: customers.hasNextPage,
    isLoadingMore: customers.isFetchingNextPage,
    loadMore: () => { void customers.fetchNextPage(); },
    createCustomer: async (input) => { await create.mutateAsync(input); },
    updateCustomer: async (id, input) => { await update.mutateAsync({ id, input }); },
    eraseCustomer: async (id) => { await erase.mutateAsync(id); },
    exportCsv: () => customersApi.exportCsv(currency),
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
