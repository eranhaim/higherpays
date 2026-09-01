import { useQuery, useInfiniteQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import {
  linksApi, accountsApi, workspacesApi,
  type ListLinksQuery, type PaymentLink, type Account, type LinkLimits, type LinkType,
} from '../../api/endpoints';

export interface CreateLinkFormInput {
  accountId: string;
  type: LinkType;
  amount: number;
  description?: string;
}

export interface UseLinksDataResult {
  links: PaymentLink[];
  accounts: Account[];
  linkLimits: LinkLimits | null;
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
  createLink: (input: CreateLinkFormInput) => Promise<PaymentLink>;
  cancelLink: (id: string) => Promise<void>;
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
    // Keep the current rows on screen while a changed filter loads, so nudging
    // the amount spinner doesn't blank the table and the stat cards.
    placeholderData: keepPreviousData,
    enabled,
  });
  const accounts = useQuery({ queryKey: ['accounts', activeWorkspaceId], queryFn: () => accountsApi.list(), enabled });
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
  return {
    links: links.data?.pages.flatMap((p) => p.items) ?? [],
    accounts: accounts.data ?? [],
    linkLimits: linkLimits.data ?? null,
    isLoading: links.isLoading,
    isError: links.isError,
    hasMore: links.hasNextPage,
    isLoadingMore: links.isFetchingNextPage,
    loadMore: () => { void links.fetchNextPage(); },
    createLink: (input) => create.mutateAsync(input),
    cancelLink: async (id) => { await cancel.mutateAsync(id); },
  };
}
