import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProviders } from './components/AppProviders';
import { AuthGuard } from './components/AuthGuard';
import Layout from './components/Layout';
import ToastContainer from './components/Toast';
import LoginPage from './pages/Login';
import PaymentsPage from './pages/Payments';
import LinksPage from './pages/Links';
import PayoutsPage from './pages/Payouts';
import CustomersPage from './pages/Customers';
import TeamPage from './pages/Team';
import CreatorsPage from './pages/Creators';

export default function App() {
  return (
    <AppProviders>
      <BrowserRouter useTransitions={false}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<AuthGuard />}>
            <Route element={<Layout />}>
              <Route path="/payments" element={<PaymentsPage />} />
              <Route path="/links" element={<LinksPage />} />
              <Route path="/payouts" element={<PayoutsPage />} />
              <Route path="/customers" element={<CustomersPage />} />
              <Route path="/team" element={<TeamPage />} />
              <Route path="/creators" element={<CreatorsPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/payments" replace />} />
        </Routes>
      </BrowserRouter>
      <ToastContainer />
    </AppProviders>
  );
}
