/**
 * Gates a routed page on the permission that opens it, from the same table the
 * sidebar filters with. Without this a hidden page is still reachable by typing
 * its URL: the API refuses the data, but the page renders its chrome and fires
 * requests that can only 403.
 */

import { Outlet, useLocation } from 'react-router-dom';
import { useCan, usePermissionsPending } from '../hooks/usePermission';
import { ROUTE_PERMISSION } from '../rbac/nav';
import { EmptyState } from './ui';

export default function PermissionGuard() {
  const { pathname } = useLocation();
  const can = useCan();
  const pending = usePermissionsPending();

  const needed = ROUTE_PERMISSION[pathname];
  // A path outside the table carries no permission of its own.
  if (!needed) return <Outlet />;

  // Render nothing rather than the page while we still don't know.
  if (pending) return null;

  if (!can(needed)) {
    return (
      <div className="card">
        <EmptyState
          title="You don't have access to this page."
          hint="Ask a workspace owner or admin if you need it."
        />
      </div>
    );
  }
  return <Outlet />;
}
