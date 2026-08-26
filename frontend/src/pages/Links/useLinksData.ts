import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import {
  linksApi, accountsApi, customersApi, workspacesApi,
  type ListLinksQuery, type PaymentLink, type Account, type Customer, type LinkLimits, type LinkType,
} from '../../api/endpoints';

export interface CreateLinkFormInput {
  accountId: string;
  customerId?: string;
  type: LinkType;
  amount: number;
  description?: string;
}

export interface ReconcileSummary {
  checked: number;
  updated: number;
}

export interface UseLinksDataResult {
  links: PaymentLink[];
  accounts: Account[];
  customers: Customer[];
  linkLimits: LinkLimits | null;
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
  createLink: (input: CreateLinkFormInput) => Promise<PaymentLink>;
  cancelLink: (id: string) => Promise<void>;
  reconcile: () => Promise<ReconcileSummary>;
}

export function useLinksData(filters: ListLinksQuery = {}): UseLinksDataResult {
  const { activeWorkspaceId, currency } = useCurrentSession();
  const queryClient = useQueryClient();
  const enabled = Boolean(activeWorkspaceId);

  // Filters are part of the key: changing one starts a fresh paginated result
  // from the server rather than re-filtering whatever happens to be loaded.
  const links = useInfiniteQuery({
    queryKey: ['links', activeWorkspaceId, filters],
    queryFn: ({ pageParam }) => linksApi.list(pageParam, filters),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });
  const accounts = useQuery({ queryKey: ['accounts', activeWorkspaceId], queryFn: () => accountsApi.list(), enabled });
  const customers = useQuery({
    queryKey: ['customers', activeWorkspaceId, 'picker'],
    queryFn: () => customersApi.list({ limit: 200 }),
    enabled,
  });
  const linkLimits = useQuery({
    queryKey: ['link-limits', activeWorkspaceId],
    queryFn: () => workspacesApi.getLinkLimits(),
    enabled,
    staleTime: 5 * 60_000,
  });

  const invalidateLinks = () => queryClient.invalidateQueries({ queryKey: ['links', activeWorkspaceId] });

  const create = useMutation({
    mutationFn: (input: CreateLinkFormInput) => linksApi.create({ ...input, currency }),
    onSuccess: invalidateLinks,
  });
  const cancel = useMutation({ mutationFn: (id: string) => linksApi.cancel(id), onSuccess: invalidateLinks });
  const reconcile = useMutation({
    // Grace 0: a manual click should check every unresolved link, including
    // one paid seconds ago. The backend's default grace suits unattended callers.
    mutationFn: () => linksApi.reconcile(0),
    onSuccess: () => {
      invalidateLinks();
      queryClient.invalidateQueries({ queryKey: ['payments', activeWorkspaceId] });
    },
  });

  return {
    links: links.data?.pages.flatMap((p) => p.items) ?? [],
    accounts: accounts.data ?? [],
    customers: customers.data ?? [],
    linkLimits: linkLimits.data ?? null,
    isLoading: links.isLoading,
    isError: links.isError,
    hasMore: links.hasNextPage,
    isLoadingMore: links.isFetchingNextPage,
    loadMore: () => { void links.fetchNextPage(); },
    createLink: (input) => create.mutateAsync(input),
    cancelLink: async (id) => { await cancel.mutateAsync(id); },
    reconcile: async () => {
      const result = await reconcile.mutateAsync();
      return { checked: result.checked, updated: result.updated.length };
    },
  };
}
