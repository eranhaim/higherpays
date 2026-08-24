import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useIsAuthenticated } from '../store/auth';

/**
 * Route guard. Sends unauthenticated visitors to `/login`. The original
 * location is preserved in router state so login can bounce them back.
 */
export function AuthGuard() {
  const isAuthenticated = useIsAuthenticated();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <Outlet />;
}
