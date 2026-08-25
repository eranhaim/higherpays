import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useIsAuthenticated } from '../store/auth';

/**
 * Route guard. Sends unauthenticated visitors to `/login`. The original
 * location is preserved via router state so the login page can bounce
 * the user back afterwards.
 */
export function AuthGuard() {
  const isAuthed = useIsAuthenticated();
  const location = useLocation();

  if (!isAuthed) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <Outlet />;
}
