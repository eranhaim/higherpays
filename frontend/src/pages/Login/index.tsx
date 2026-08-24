import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { authApi } from '../../api/endpoints';
import { HttpError } from '../../api/http';
import { isTwoFactorRequired, type LoginSuccess } from '../../api/types';
import { useAuthStore, useIsAuthenticated } from '../../store/auth';
import { useSessionStore } from '../../store/session';

/**
 * Sign-in screen. Two stages: email + password, then a 6-digit code when the
 * account has two-factor authentication enabled.
 */

type Stage = 'credentials' | 'totp';

interface LocationState { from?: { pathname: string } }

export default function LoginPage() {
  const isAuthenticated = useIsAuthenticated();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as LocationState | null)?.from?.pathname ?? '/payments';

  const [stage, setStage] = useState<Stage>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');

  const setSession = useAuthStore((s) => s.setSession);
  const setActiveWorkspaceId = useSessionStore((s) => s.setActiveWorkspaceId);

  const login = useMutation({
    mutationFn: (input: { email: string; password: string; totp?: string }) =>
      authApi.login(input.email, input.password, input.totp),
    onSuccess: (response) => {
      if (isTwoFactorRequired(response)) {
        setStage('totp');
        return;
      }
      finishLogin(response);
    },
  });

  function finishLogin(response: LoginSuccess) {
    setSession(response);
    const firstWorkspace = response.workspaces[0];
    if (firstWorkspace) setActiveWorkspaceId(firstWorkspace.id);
    navigate(from, { replace: true });
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    login.mutate({
      email: email.trim(),
      password,
      ...(stage === 'totp' ? { totp: totp.trim() } : {}),
    });
  }

  if (isAuthenticated) return <Navigate to={from} replace />;

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="mark" aria-hidden="true">H</div>
          <div>
            <h1>HigherPays</h1>
            <p className="sub">Sign in to your workspace</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          {stage === 'credentials' ? (
            <>
              <div className="field">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="field">
                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </>
          ) : (
            <div className="field">
              <label htmlFor="totp">Authentication code</label>
              <input
                id="totp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                pattern="[0-9]{6}"
                maxLength={6}
                value={totp}
                onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))}
                autoFocus
              />
              <p className="sub">Enter the 6-digit code from your authenticator app.</p>
            </div>
          )}

          {login.error && (
            <div className="warnbar" role="alert">{loginErrorMessage(login.error)}</div>
          )}

          <button className="btn full-width" type="submit" disabled={login.isPending}>
            {login.isPending ? 'Signing in…' : stage === 'credentials' ? 'Sign in' : 'Verify'}
          </button>

          {stage === 'totp' && (
            <button
              type="button"
              className="btn ghost full-width"
              onClick={() => { setStage('credentials'); setTotp(''); }}
            >
              Back
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

function loginErrorMessage(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 401) return 'Invalid email or password.';
    if (err.status === 400) return 'Please check the fields and try again.';
    if (err.status >= 500) return 'The server is unavailable. Try again in a moment.';
    return err.message;
  }
  if (err instanceof TypeError) return 'Cannot reach the server.';
  return 'Something went wrong. Please try again.';
}
