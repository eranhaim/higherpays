/**
 * App shell: sidebar grouped by intent (money in / money out / people /
 * insight / admin) and the routed page. Nav items are filtered by the
 * caller's real permissions, so a agent only sees what they can act on.
 */

import { useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../store/auth';
import { useSessionStore } from '../store/session';
import { useCurrentSession } from '../hooks/useCurrentSession';
import { useCan } from '../hooks/usePermission';
import { authApi } from '../api/endpoints';
import { NAV, type NavGroup } from '../rbac/nav';
import NotificationBell from './NotificationBell';

function NavSection({ group }: { group: NavGroup }) {
  const can = useCan();
  const visible = group.items.filter((i) => can(i.perm));
  if (visible.length === 0) return null;

  return (
    <div>
      <div className="nav-lbl">{group.label}</div>
      {visible.map((item) => (
        <NavLink
          key={item.path}
          to={item.path}
          className={({ isActive }) => `navitem${isActive ? ' active' : ''}`}
        >
          {item.label}
        </NavLink>
      ))}
    </div>
  );
}

export default function Layout() {
  const { user, workspaces, activeWorkspaceId } = useCurrentSession();
  const setActiveWorkspaceId = useSessionStore((s) => s.setActiveWorkspaceId);
  const clearAuth = useAuthStore((s) => s.clear);
  const clearSession = useSessionStore((s) => s.clear);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);

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
    <div className="app">
      <aside className="side">
        <div className="brand">
          <div className="mark" aria-hidden="true">H</div>
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
          {NAV.map((g) => <NavSection key={g.label} group={g} />)}
        </nav>

        <div className="side-foot">
          {user && (
            <div className="user-block">
              <div className="user-name">{user.fullName}</div>
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
    </div>
  );
}
