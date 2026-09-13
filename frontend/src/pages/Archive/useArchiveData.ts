import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../../hooks/useCurrentSession';
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
      queryClient.invalidateQueries({ queryKey: ['payments', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['payments-summary', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['links', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['links-summary', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['accounts', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['agents', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['customers', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['payouts-breakdown', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['analytics', activeWorkspaceId] });
      queryClient.invalidateQueries({ queryKey: ['team', activeWorkspaceId] });
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
