import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { invitesApi } from '../../api/endpoints';
import { WORKSPACE_ROLE_LABELS } from '../../api/types';
import { HttpError } from '../../api/http';

/**
 * Where the emailed invite link lands. Shows who invited you to what, takes a
 * password for a new login (an existing login just confirms), and hands over
 * to sign-in. Public: the token is the only credential.
 */
export default function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const preview = useQuery({
    queryKey: ['invite-preview', token],
    queryFn: () => invitesApi.preview(token),
    enabled: token !== '',
    retry: false,
  });

  const accept = useMutation({
    mutationFn: () => invitesApi.accept(token, { password: password || undefined, fullName: fullName.trim() || undefined }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password && password.length < 8) { setFormError('Password must be at least 8 characters.'); return; }
    setFormError(null);
    accept.mutate();
  };

  let body;
  if (!token || preview.isError) {
    body = (
      <>
        <h2>This invite is no longer valid</h2>
        <p className="sub">It may have expired or already been used. Ask the person who invited you to send a new one.</p>
        <Link className="btn ghost full-width" to="/login">Go to sign in</Link>
      </>
    );
  } else if (preview.isLoading || !preview.data) {
    body = <p className="sub">Checking your invite…</p>;
  } else if (accept.isSuccess) {
    body = (
      <>
        <h2>You're in</h2>
        <p className="sub">
          {accept.data.existingUser
            ? `${preview.data.workspace} has been added to your existing login.`
            : `Your login for ${preview.data.workspace} is ready.`}
        </p>
        <Link className="btn full-width" to="/login">Sign in</Link>
      </>
    );
  } else {
    const invite = preview.data;
    body = (
      <>
        <h2>Join {invite.workspace}</h2>
        <p className="sub">You were invited as <strong>{WORKSPACE_ROLE_LABELS[invite.role]}</strong>, signing in as {invite.email}.</p>
        <form onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="invite-name">Your name</label>
            <input id="invite-name" type="text" autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="invite-password">Password</label>
            <input id="invite-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <p className="sub">At least 8 characters. If this email already has a HigherPays login, leave it blank and keep your current password.</p>
          </div>
          {(formError || accept.error) && (
            <div className="warnbar" role="alert">{formError ?? acceptErrorMessage(accept.error)}</div>
          )}
          <button className="btn full-width" type="submit" disabled={accept.isPending}>{accept.isPending ? 'Setting up…' : 'Accept invite'}</button>
        </form>
      </>
    );
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <img className="brand-logo" src="/logo-mark.png" alt="" />
          <span className="brand-sep" aria-hidden="true" />
          <span className="auth-wordmark">HigherPays</span>
        </div>
        <div className="card">{body}</div>
      </div>
    </div>
  );
}

function acceptErrorMessage(err: unknown): string {
  if (err instanceof HttpError) {
    if (err.status === 409) return 'You are already a member of this workspace. Just sign in.';
    if (err.status === 400) return 'A new login needs a password of at least 8 characters.';
    if (err.status === 404) return 'This invite has expired or was already used.';
  }
  return 'Something went wrong. Please try again.';
}
