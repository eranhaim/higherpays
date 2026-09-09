/**
 * App shell: sidebar grouped by intent (operate / manage / administer) and
 * the routed page. Nav items are filtered by the caller's real permissions,
 * so an agent only sees what they can act on.
 */

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../store/auth';
import { useSessionStore } from '../store/session';
import { useCurrentSession } from '../hooks/useCurrentSession';
import { useCan } from '../hooks/usePermission';
import { authApi, platformApi } from '../api/endpoints';
import { NAV, navLabel, type NavGroup } from '../rbac/nav';
import { hasUnsavedChanges, clearUnsavedChanges } from '../lib/unsavedChanges';
import Modal from './Modal';
import NavIcon from './NavIcon';
import NotificationBell from './NotificationBell';

interface NavSectionProps {
  group: NavGroup;
  onNavigate: (e: MouseEvent, path: string) => void;
}

function NavSection({ group, onNavigate }: NavSectionProps) {
  const can = useCan();
  const { labels } = useCurrentSession();
  const visible = group.items.filter((i) => can(i.perm));
  const seesWholeWorkspace = can('data.view_all');
  if (visible.length === 0) return null;

  return (
    <div>
      <div className="nav-lbl">{group.label}</div>
      {visible.map((item) => (
        <NavLink
          key={item.path}
          to={item.path}
          className={({ isActive }) => `navitem${isActive ? ' active' : ''}`}
          onClick={(e) => onNavigate(e, item.path)}
        >
          <NavIcon name={item.icon} />
          {navLabel(item, labels, seesWholeWorkspace)}
        </NavLink>
      ))}
    </div>
  );
}

export default function Layout() {
  const { user, roleName, workspaces, activeWorkspaceId } = useCurrentSession();
  const setActiveWorkspaceId = useSessionStore((s) => s.setActiveWorkspaceId);
  const clearAuth = useAuthStore((s) => s.clear);
  const originalSession = useAuthStore((s) => s.originalSession);
  const originalWorkspaceId = useAuthStore((s) => s.originalWorkspaceId);
  const impersonationExpiresAt = useAuthStore((s) => s.impersonationExpiresAt);
  const beginImpersonation = useAuthStore((s) => s.beginImpersonation);
  const endImpersonation = useAuthStore((s) => s.endImpersonation);
  const clearSession = useSessionStore((s) => s.clear);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [impersonationOpen, setImpersonationOpen] = useState(false);
  const [impersonationTarget, setImpersonationTarget] = useState('');

  const targets = useQuery({
    queryKey: ['impersonation-targets'],
    queryFn: () => platformApi.listImpersonationTargets(),
    enabled: impersonationOpen && Boolean(user?.isPlatformAdmin) && !originalSession,
  });

  const restorePlatformSession = () => {
    const workspaceId = originalWorkspaceId;
    endImpersonation();
    if (workspaceId) setActiveWorkspaceId(workspaceId);
    queryClient.clear();
    navigate('/platform', { replace: true });
  };

  const exitImpersonation = async () => {
    try {
      await platformApi.stopImpersonation();
    } finally {
      restorePlatformSession();
    }
  };

  useEffect(() => {
    if (!originalSession || !impersonationExpiresAt) return;
    const remaining = Date.parse(impersonationExpiresAt) - Date.now();
    if (remaining <= 0) {
      restorePlatformSession();
      return;
    }
    const timer = window.setTimeout(restorePlatformSession, remaining);
    return () => window.clearTimeout(timer);
  // restorePlatformSession reads current store values when the timer fires.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originalSession, impersonationExpiresAt]);

  const startImpersonation = useMutation({
    mutationFn: async () => {
      const target = targets.data?.find((item) => `${item.workspaceId}:${item.userId}` === impersonationTarget);
      if (!target) throw new Error('Select a user.');
      return platformApi.startImpersonation(target.workspaceId, target.userId);
    },
    onSuccess: (session) => {
      beginImpersonation({ ...session, originalWorkspaceId: activeWorkspaceId });
      setActiveWorkspaceId(session.workspace.id);
      queryClient.clear();
      setImpersonationOpen(false);
      navigate('/', { replace: true });
    },
  });

  // Leaving the page throws away whatever the current form is holding, so ask
  // first. Registered by useUnsavedChanges in the forms themselves.
  const guardNavigation = (e: MouseEvent, path: string) => {
    if (path === pathname || !hasUnsavedChanges()) return;
    e.preventDefault();
    setPendingPath(path);
  };

  const leaveWithoutSaving = () => {
    const path = pendingPath;
    setPendingPath(null);
    clearUnsavedChanges();
    if (path) navigate(path);
  };

  // A new page starts at the top. <main> is the scroll container on wide
  // screens; below 900px the layout is auto-height and the window scrolls.
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
    window.scrollTo(0, 0);
  }, [pathname]);

  const logout = useMutation({
    mutationFn: async () => {
      const refreshToken = useAuthStore.getState().refreshToken;
      if (refreshToken) await authApi.logout(refreshToken);
    },
    onSettled: () => {
      clearAuth();
      clearSession();
      queryClient.clear();
      navigate('/login', { replace: true });
    },
  });

  return (
    <div className={`app${originalSession ? ' is-impersonating' : ''}`}>
      {originalSession && (
        <div className="impersonation-banner">
          Viewing as {user?.fullName} · {roleName}
          <button className="btn small" onClick={exitImpersonation}>Exit impersonation</button>
        </div>
      )}
      <aside className="side">
        <div className="brand">
          <img className="brand-logo" src="/logo-mark.png" alt="" />
          <span className="brand-sep" aria-hidden="true" />
          <h1>HigherPays</h1>
          <span className="brand-spacer" />
          <NotificationBell />
        </div>

        {workspaces.length > 1 && (
          <div className="ws-picker">
            <label htmlFor="ws-picker">Workspace</label>
            <select
              id="ws-picker"
              value={activeWorkspaceId ?? ''}
              onChange={(e) => {
                setActiveWorkspaceId(e.target.value);
                // Every cached query is scoped to the old workspace.
                queryClient.clear();
              }}
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </div>
        )}

        <nav>
          {NAV.map((g) => <NavSection key={g.label} group={g} onNavigate={guardNavigation} />)}
          {user?.isPlatformAdmin && (
            <div>
              <div className="nav-lbl">HigherPays</div>
              <NavLink to="/platform" className={({ isActive }) => `navitem${isActive ? ' active' : ''}`}>
                <NavIcon name="settings" />
                Platform
              </NavLink>
              <button className="btn ghost full-width" onClick={() => setImpersonationOpen(true)}>Impersonate user</button>
            </div>
          )}
        </nav>

        <div className="side-foot">
          {user && (
            <div className="user-block">
              <div className="user-name">
                {user.fullName}
                {roleName && <span className="rolebadge">{roleName}</span>}
              </div>
              <div className="user-email">{user.email}</div>
            </div>
          )}
          <button
            className="btn ghost full-width"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            Sign out
          </button>
        </div>
      </aside>

      <main ref={mainRef}>
        <Outlet />
      </main>

      <Modal
        open={pendingPath !== null}
        onClose={() => setPendingPath(null)}
        title="Leave without saving?"
        subtitle="This page has changes you haven't saved. Leaving now discards them."
      >
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setPendingPath(null)}>Stay on this page</button>
          <button className="btn danger" onClick={leaveWithoutSaving}>Discard and leave</button>
        </div>
      </Modal>

      <Modal open={impersonationOpen} onClose={() => setImpersonationOpen(false)}
        title="Impersonate a workspace user"
        subtitle="You will act with this user's exact access for up to 15 minutes. Every action records both identities.">
        <div className="field">
          <label htmlFor="impersonation-target">User</label>
          <select id="impersonation-target" value={impersonationTarget}
            onChange={(event) => setImpersonationTarget(event.target.value)}>
            <option value="">Select a user</option>
            {(targets.data ?? []).map((target) => (
              <option key={`${target.workspaceId}:${target.userId}`} value={`${target.workspaceId}:${target.userId}`}>
                {target.workspaceName} · {target.fullName} · {target.roleName}
              </option>
            ))}
          </select>
        </div>
        {startImpersonation.isError && <p className="field-error">{startImpersonation.error.message}</p>}
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setImpersonationOpen(false)}>Cancel</button>
          <button className="btn" disabled={!impersonationTarget || startImpersonation.isPending}
            onClick={() => startImpersonation.mutate()}>
            {startImpersonation.isPending ? 'Starting…' : 'Start impersonation'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
