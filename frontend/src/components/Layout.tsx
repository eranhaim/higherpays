/**
 * App shell.
 *
 * A quiet sidebar organised by intent (money in / money out / people)
 * rather than by feature-area, so the person using it thinks in the same
 * verbs they use at work.
 *
 * Permission visibility comes from `useCan()` — so a signed-in chatter only
 * sees the tabs they can act on.
 */

import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../store/auth';
import { useSessionStore } from '../store/session';
import { useCurrentSession } from '../hooks/useCurrentSession';
import { useCan } from '../hooks/usePermission';
import { authApi } from '../api/endpoints';
import NotificationBell from './NotificationBell';
import type { Permission } from '../types';

interface NavItem { path: string; label: string; perm: Permission }
interface NavGroup { label: string; items: NavItem[] }

const NAV: NavGroup[] = [
  {
    label: 'Money in',
    items: [
      { path: '/payments', label: 'Payments',       perm: 'payments.view' },
      { path: '/links',    label: 'Payment links',  perm: 'links.view'    },
    ],
  },
  {
    label: 'Money out',
    items: [
      { path: '/payouts',  label: 'Payouts',        perm: 'commissions.view' },
    ],
  },
  {
    label: 'People',
    items: [
      { path: '/creators', label: 'Creators',       perm: 'creators.view' },
      { path: '/customers',label: 'Customers',      perm: 'customers.view' },
      { path: '/team',     label: 'Team',           perm: 'team.view' },
    ],
  },
];

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

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  manager: 'Manager',
  analyst: 'Analyst',
  chatter: 'Chatter',
  creator: 'Creator',
};

export default function Layout() {
  const { workspaces, activeWorkspace, activeWorkspaceId, role } = useCurrentSession();
  const user = useAuthStore((s) => s.user);
  const setActiveWorkspaceId = useSessionStore((s) => s.setActiveWorkspaceId);
  const clearAuth = useAuthStore((s) => s.clear);
  const clearSession = useSessionStore((s) => s.clear);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const logout = useMutation({
    mutationFn: async () => {
      const rt = useAuthStore.getState().refreshToken;
      if (rt) await authApi.logout(rt);
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
          <div>
            <h1>HigherPays</h1>
          </div>
          <span style={{ flex: 1 }} />
          <NotificationBell />
        </div>

        {workspaces.length > 1 && (
          <div className="ws-picker">
            <label htmlFor="ws-picker">Workspace</label>
            <select
              id="ws-picker"
              value={activeWorkspace?.id ?? activeWorkspaceId ?? ''}
              onChange={(e) => setActiveWorkspaceId(e.target.value)}
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
              <div className="user-name">
                {user.fullName}
                <span className="rolebadge" style={{ marginLeft: 8 }}>{ROLE_LABEL[role] ?? role}</span>
              </div>
              <div className="user-email">{user.email}</div>
            </div>
          )}

          <button
            className="btn ghost"
            style={{ width: '100%' }}
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            Sign out
          </button>
        </div>
      </aside>

      <main>
        <Outlet />
      </main>
    </div>
  );
}
