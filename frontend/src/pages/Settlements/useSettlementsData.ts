import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { settlementsApi, type ImportResult, type ReserveSchedule, type Settlement } from '../../api/endpoints';

export interface UseSettlementsDataResult {
  settlements: Settlement[];
  reserve: ReserveSchedule | null;
  isLoading: boolean;
  isError: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
  importReport: (file: File) => Promise<ImportResult>;
}

/** The browser reads the file; the API takes it inline as base64. */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
}

export function useSettlementsData(): UseSettlementsDataResult {
  const { activeWorkspaceId } = useCurrentSession();
  const queryClient = useQueryClient();
  const enabled = Boolean(activeWorkspaceId);

  const settlements = useInfiniteQuery({
    queryKey: ['settlements', activeWorkspaceId],
    queryFn: ({ pageParam }) => settlementsApi.list(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
  });
  const reserve = useQuery({ queryKey: ['settlements-reserve', activeWorkspaceId], queryFn: () => settlementsApi.reserve(), enabled });

  const importReport = useMutation({
    mutationFn: async (file: File) => settlementsApi.import(file.name, await readAsBase64(file)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settlements', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['settlements-reserve', activeWorkspaceId] });
      // The reserve on Payouts becomes exact once a report is in.
      queryClient.invalidateQueries({ queryKey: ['payouts-breakdown', activeWorkspaceId] });
    },
  });

  return {
    settlements: settlements.data?.pages.flatMap((p) => p.items) ?? [],
    reserve: reserve.data ?? null,
    isLoading: settlements.isLoading,
    isError: settlements.isError,
    hasMore: settlements.hasNextPage,
    isLoadingMore: settlements.isFetchingNextPage,
    loadMore: () => { void settlements.fetchNextPage(); },
    importReport: (file) => importReport.mutateAsync(file),
  };
}
