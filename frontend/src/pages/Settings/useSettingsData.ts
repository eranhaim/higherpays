import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  authApi, notificationsApi, rolesApi, workspacesApi,
  type NotificationEvent,
} from '../../api/endpoints';
import type { Permission } from '../../rbac/permissions';
import { useAuthStore } from '../../store/auth';
import { useCurrentSession } from '../../hooks/useCurrentSession';

export function useGeneralSettings() {
  const { activeWorkspaceId } = useCurrentSession();
  const qc = useQueryClient();

  const linkLimits = useQuery({
    queryKey: ['link-limits', activeWorkspaceId],
    queryFn: () => workspacesApi.getLinkLimits(),
    enabled: Boolean(activeWorkspaceId),
  });

  const rename = useMutation({
    mutationFn: (name: string) => workspacesApi.rename(name),
    onSuccess: (renamed) => {
      const auth = useAuthStore.getState();
      auth.setWorkspaces(auth.workspaces.map((w) =>
        w.id === renamed.id ? { ...w, name: renamed.name } : w,
      ));
    },
  });

  const saveLinkLimits = useMutation({
    mutationFn: (input: { minLinkAmount: number | null; maxLinkAmount: number | null }) =>
      workspacesApi.setLinkLimits(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['link-limits', activeWorkspaceId] }),
  });

  return { linkLimits, rename, saveLinkLimits };
}

export function useTwoFactor() {
  const setTwoFactorEnabled = (enabled: boolean) => {
    const auth = useAuthStore.getState();
    if (auth.user) auth.setUser({ ...auth.user, twoFactorEnabled: enabled });
  };

  const enable = useMutation({
    mutationFn: (code: string) => authApi.enableTwoFactor(code),
    onSuccess: () => setTwoFactorEnabled(true),
  });

  const disable = useMutation({
    mutationFn: (code: string) => authApi.disableTwoFactor(code),
    onSuccess: () => setTwoFactorEnabled(false),
  });

  return { enable, disable };
}

export function useRoles() {
  const { activeWorkspaceId } = useCurrentSession();
  const qc = useQueryClient();

  const roles = useQuery({
    queryKey: ['roles', activeWorkspaceId],
    queryFn: () => rolesApi.list(),
    enabled: Boolean(activeWorkspaceId),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['roles', activeWorkspaceId] });
    qc.invalidateQueries({ queryKey: ['permissions', activeWorkspaceId] });
  };

  const setPermissions = useMutation({
    mutationFn: (input: { name: string; permissions: Permission[] }) =>
      rolesApi.setPermissions(input.name, input.permissions),
    onSuccess: invalidate,
  });

  const createRole = useMutation({
    mutationFn: (name: string) => rolesApi.create(name, []),
    onSuccess: invalidate,
  });

  const deleteRole = useMutation({
    mutationFn: (name: string) => rolesApi.remove(name),
    onSuccess: invalidate,
  });

  return { roles, setPermissions, createRole, deleteRole };
}

export function useNotificationSettings() {
  const { activeWorkspaceId } = useCurrentSession();
  const qc = useQueryClient();

  const preferences = useQuery({
    queryKey: ['notification-preferences', activeWorkspaceId],
    queryFn: () => notificationsApi.getPreferences(),
    enabled: Boolean(activeWorkspaceId),
  });

  const channels = useQuery({
    queryKey: ['notification-channels', activeWorkspaceId],
    queryFn: () => notificationsApi.listChannels(),
    enabled: Boolean(activeWorkspaceId),
  });

  const invalidateChannels = () =>
    qc.invalidateQueries({ queryKey: ['notification-channels', activeWorkspaceId] });

  const savePreferences = useMutation({
    mutationFn: (events: NotificationEvent[]) => notificationsApi.setPreferences(events),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['notification-preferences', activeWorkspaceId] }),
  });

  const createChannel = useMutation({
    mutationFn: (input: { target: string; label?: string; events: NotificationEvent[] }) =>
      notificationsApi.createChannel(input),
    onSuccess: invalidateChannels,
  });

  const setChannelEvents = useMutation({
    mutationFn: (input: { id: string; events: NotificationEvent[] }) =>
      notificationsApi.updateChannel(input.id, { events: input.events }),
    onSuccess: invalidateChannels,
  });

  const setChannelActive = useMutation({
    mutationFn: (input: { id: string; active: boolean }) =>
      notificationsApi.updateChannel(input.id, { active: input.active }),
    onSuccess: invalidateChannels,
  });

  const deleteChannel = useMutation({
    mutationFn: (id: string) => notificationsApi.deleteChannel(id),
    onSuccess: invalidateChannels,
  });

  const testChannel = useMutation({
    mutationFn: (id: string) => notificationsApi.testChannel(id),
    // A failed test writes lastError on the channel, so the table must refresh either way.
    onSettled: invalidateChannels,
  });

  return {
    preferences, channels,
    savePreferences, createChannel, setChannelActive, setChannelEvents, deleteChannel, testChannel,
  };
}
