import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { invalidateLedgerQueries } from '../../lib/queryClient';
import { archiveApi, type ArchiveType, type ArchivedItem } from '../../api/endpoints';

export function useArchiveData(type: ArchiveType) {
  const { activeWorkspaceId } = useCurrentSession();
  const queryClient = useQueryClient();
  const enabled = Boolean(activeWorkspaceId);
  const archived = useQuery({
    queryKey: ['archive', activeWorkspaceId, type],
    queryFn: () => archiveApi.list(type),
    enabled,
  });
  const restore = useMutation({
    mutationFn: (id: string) => archiveApi.restore(type, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['archive', activeWorkspaceId, type] });
      queryClient.invalidateQueries({ queryKey: ['accounts', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['agents', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['team', activeWorkspaceId] });
      invalidateLedgerQueries(queryClient, activeWorkspaceId);
    },
  });
  return {
    items: archived.data?.items ?? [] as ArchivedItem[],
    isLoading: archived.isLoading,
    isError: archived.isError,
    restore: (id: string) => restore.mutateAsync(id),
    isRestoring: restore.isPending,
  };
}
