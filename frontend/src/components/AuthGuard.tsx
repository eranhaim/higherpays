import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { authApi } from '../api/endpoints';
import { useAuthStore, useIsAuthenticated } from '../store/auth';
import { useSessionStore } from '../store/session';

/**
 * Route guard. Sends unauthenticated visitors to `/login`. The original
 * location is preserved in router state so login can bounce them back.
 */
export function AuthGuard() {
  const isAuthenticated = useIsAuthenticated();
  const location = useLocation();
  const setUser = useAuthStore((s) => s.setUser);
  const setWorkspaces = useAuthStore((s) => s.setWorkspaces);
  const activeWorkspaceId = useSessionStore((s) => s.activeWorkspaceId);
  const setActiveWorkspaceId = useSessionStore((s) => s.setActiveWorkspaceId);
  const session = useQuery({
    queryKey: ['auth-me'],
    queryFn: () => authApi.me(),
    enabled: isAuthenticated,
    retry: false,
  });

  useEffect(() => {
    if (!session.data) return;
    setUser(session.data.user);
    setWorkspaces(session.data.workspaces);
    if (!session.data.workspaces.some((w) => w.id === activeWorkspaceId)) {
      setActiveWorkspaceId(session.data.workspaces[0]?.id ?? null);
    }
  }, [session.data, activeWorkspaceId, setUser, setWorkspaces, setActiveWorkspaceId]);

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  if (session.isPending) return null;
  return <Outlet />;
}
