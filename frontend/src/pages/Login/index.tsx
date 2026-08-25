import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { authApi } from '../../api/endpoints';
import { HttpError } from '../../api/http';
import { isTwoFactorRequired, type LoginSuccess } from '../../api/types';
import { useAuthStore, useIsAuthenticated } from '../../store/auth';
import { useSessionStore } from '../../store/session';

/**
 * Sign-in screen.
 *
 * States:
 *   - `credentials`: email + password
 *   - `totp`: 2FA required after the first submit — collect the 6-digit code
 */

type Stage = 'credentials' | 'totp';

interface LocationState { from?: { pathname: string } }

export default function LoginPage() {
  const isAuthed = useIsAuthenticated();
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
    if (stage === 'credentials') {
      login.mutate({ email: email.trim(), password });
    } else {
      login.mutate({ email: email.trim(), password, totp: totp.trim() });
    }
  }

  if (isAuthed) return <Navigate to={from} replace />;

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
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </>
          ) : (
            <>
              <p className="sub" style={{ marginTop: 0 }}>
                Enter the 6-digit code from your authenticator app.
              </p>
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
              </div>
            </>
          )}

          {login.error && <LoginError error={login.error} />}

          <button
            className="btn"
            type="submit"
            disabled={login.isPending}
            style={{ width: '100%', marginTop: 8 }}
          >
            {login.isPending ? 'Signing in\u2026' : stage === 'credentials' ? 'Sign in' : 'Verify'}
          </button>

          {stage === 'totp' && (
            <button
              type="button"
              className="btn ghost"
              style={{ width: '100%', marginTop: 8 }}
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

function LoginError({ error }: { error: unknown }) {
  const message = mapError(error);
  return (
    <div className="warnbar" role="alert" style={{ marginTop: 12 }}>
      {message}
    </div>
  );
}

function mapError(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 401) return 'Invalid email or password.';
    if (err.status === 400) return 'Please check the fields and try again.';
    if (err.status === 0 || err.status >= 500) return 'The server is unreachable. Is the backend running?';
    return err.message;
  }
  if (err instanceof TypeError) return 'Cannot reach the server. Is the backend running on the API URL?';
  return 'Something went wrong. Please try again.';
}
