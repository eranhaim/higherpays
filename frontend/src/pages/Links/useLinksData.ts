import { useQuery, useInfiniteQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import {
  linksApi, accountsApi, workspacesApi,
  type ListLinksQuery, type PaymentLink, type PaymentLinkDetail, type LinksSummary, type Account, type LinkLimits, type LinkType, type ReassignInput,
} from '../../api/endpoints';

export interface CreateLinkFormInput {
  accountId: string;
  type: LinkType;
  amount: number;
  description?: string;
}

export interface UseLinksDataResult {
  links: PaymentLink[];
  summary: LinksSummary | null;
  accounts: Account[];
  linkLimits: LinkLimits | null;
  isLoading: boolean;
  isError: boolean;
  isSummaryLoading: boolean;
  isSummaryError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
  createLink: (input: CreateLinkFormInput) => Promise<PaymentLink>;
  cancelLink: (id: string) => Promise<void>;
  updateNote: (id: string, description: string) => Promise<void>;
  setArchived: (id: string, archived: boolean) => Promise<void>;
  /** Moves the link and every payment on it to another creator or agent. */
  reassignLink: (id: string, input: ReassignInput) => Promise<void>;
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
  const summary = useQuery({
    queryKey: ['links-summary', activeWorkspaceId, filters],
    queryFn: () => linksApi.summary(filters),
    enabled,
    placeholderData: keepPreviousData,
  });
  const linkLimits = useQuery({
    queryKey: ['link-limits', activeWorkspaceId],
    queryFn: () => workspacesApi.getLinkLimits(),
    enabled,
    staleTime: 5 * 60_000,
  });

  const invalidateLinks = () => {
    queryClient.invalidateQueries({ queryKey: ['links', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['links-summary', activeWorkspaceId] });
    queryClient.invalidateQueries({ queryKey: ['link', activeWorkspaceId] });
  };

  const create = useMutation({
    mutationFn: (input: CreateLinkFormInput) => linksApi.create({ ...input, currency }),
    onSuccess: invalidateLinks,
  });
  const cancel = useMutation({ mutationFn: (id: string) => linksApi.cancel(id), onSuccess: invalidateLinks });
  const note = useMutation({
    mutationFn: ({ id, description }: { id: string; description: string }) => linksApi.updateNote(id, description),
    onSuccess: invalidateLinks,
  });
  const archive = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      archived ? linksApi.archive(id) : linksApi.reactivate(id),
    onSuccess: invalidateLinks,
  });
  // Link reassignment changes only the attribution for future payments.
  const reassign = useMutation({
    mutationFn: ({ id, input }: { id: string; input: ReassignInput }) => linksApi.reassign(id, input),
    onSuccess: invalidateLinks,
  });
  return {
    links: links.data?.pages.flatMap((p) => p.items) ?? [],
    summary: summary.data ?? null,
    accounts: accounts.data ?? [],
    linkLimits: linkLimits.data ?? null,
    isLoading: links.isLoading,
    isError: links.isError,
    isSummaryLoading: summary.isPending,
    isSummaryError: summary.isError,
    hasMore: links.hasNextPage,
    isLoadingMore: links.isFetchingNextPage,
    loadMore: () => { void links.fetchNextPage(); },
    createLink: (input) => create.mutateAsync(input),
    cancelLink: async (id) => { await cancel.mutateAsync(id); },
    updateNote: async (id, description) => { await note.mutateAsync({ id, description }); },
    setArchived: async (id, archived) => { await archive.mutateAsync({ id, archived }); },
    reassignLink: async (id, input) => { await reassign.mutateAsync({ id, input }); },
  };
}

export function useLinkDetail(id: string | null) {
  const { activeWorkspaceId } = useCurrentSession();
  return useQuery<PaymentLinkDetail>({
    queryKey: ['link', activeWorkspaceId, id],
    queryFn: () => linksApi.get(id as string),
    enabled: Boolean(activeWorkspaceId && id),
  });
}
