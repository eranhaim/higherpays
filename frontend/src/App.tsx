import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProviders } from './components/AppProviders';
import { AuthGuard } from './components/AuthGuard';
import PermissionGuard from './components/PermissionGuard';
import Layout from './components/Layout';
import { useCan, usePermissionsPending } from './hooks/usePermission';
import { NAV_ITEMS } from './rbac/nav';
import ToastContainer from './components/Toast';
import LoginPage from './pages/Login';
import AcceptInvitePage from './pages/AcceptInvite';
import PaymentsPage from './pages/Payments';
import LinksPage from './pages/Links';
import PayoutsPage from './pages/Payouts';
import SettlementsPage from './pages/Settlements';
import AccountsPage from './pages/Accounts';
import AgentsPage from './pages/Agents';
import CustomersPage from './pages/Customers';
import TeamPage from './pages/Team';
import AnalyticsPage from './pages/Analytics';
import SettingsPage from './pages/Settings';
import PlatformPage from './pages/Platform';

/**
 * Where "/" and any unknown path land: the first page the caller can open.
 */
function HomeRedirect() {
  const can = useCan();
  const pending = usePermissionsPending();
  if (pending) return null;
  const first = NAV_ITEMS.find((i) => can(i.perm));
  return <Navigate to={first ? first.path : '/payments'} replace />;
}

export default function App() {
  return (
    <AppProviders>
      <BrowserRouter useTransitions={false}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          {/* Public: the emailed invite link lands here before there is a login. */}
          <Route path="/accept-invite" element={<AcceptInvitePage />} />
          <Route element={<AuthGuard />}>
            {/* The operator console is a tier above workspaces, so it sits
                outside the workspace shell and gates on its own check. */}
            <Route path="/platform" element={<PlatformPage />} />
            <Route element={<Layout />}>
              <Route element={<PermissionGuard />}>
                <Route path="/payments" element={<PaymentsPage />} />
                <Route path="/links" element={<LinksPage />} />
                <Route path="/payouts" element={<PayoutsPage />} />
                <Route path="/settlements" element={<SettlementsPage />} />
                <Route path="/accounts" element={<AccountsPage />} />
                <Route path="/agents" element={<AgentsPage />} />
                <Route path="/customers" element={<CustomersPage />} />
                <Route path="/team" element={<TeamPage />} />
                <Route path="/analytics" element={<AnalyticsPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Route>
              <Route path="*" element={<HomeRedirect />} />
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
      <ToastContainer />
    </AppProviders>
  );
}
