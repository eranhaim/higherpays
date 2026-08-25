import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authApi, type Session } from '../../api/endpoints';
import { useAuthStore } from '../../store/auth';
import { toast } from '../../lib/toast';
import { DateCell, ErrorCard, LoadingCard } from '../../components/ui';

function describe(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  if (/mobile|iphone|android/i.test(userAgent)) return 'Mobile browser';
  if (/chrome/i.test(userAgent)) return 'Chrome';
  if (/firefox/i.test(userAgent)) return 'Firefox';
  if (/safari/i.test(userAgent)) return 'Safari';
  if (/edg/i.test(userAgent)) return 'Edge';
  return 'Browser';
}

/** Where the account is signed in, with a way to end any of it. */
export function SessionsCard() {
  const queryClient = useQueryClient();
  const refreshToken = useAuthStore((s) => s.refreshToken);

  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => authApi.listSessions() });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['sessions'] });

  const revoke = useMutation({
    mutationFn: (id: string) => authApi.revokeSession(id),
    onSuccess: invalidate,
  });
  const revokeOthers = useMutation({
    mutationFn: () => authApi.revokeOtherSessions(refreshToken ?? ''),
    onSuccess: (r) => { invalidate(); toast(r.revoked === 0 ? 'No other sessions.' : `Signed out ${r.revoked} other session${r.revoked === 1 ? '' : 's'}.`); },
    onError: (err) => toast(err instanceof Error ? err.message : 'Could not sign out other sessions.'),
  });

  if (sessions.isLoading) return <LoadingCard />;
  if (sessions.isError || !sessions.data) return <ErrorCard message="Couldn't load your sessions." />;

  const endSession = async (s: Session) => {
    try {
      await revoke.mutateAsync(s.id);
      toast('Session ended.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not end the session.');
    }
  };

  return (
    <div className="card">
      <div className="sechead row">
        <span>Where you're signed in</span>
        {sessions.data.length > 1 && (
          <button className="btn ghost small" onClick={() => revokeOthers.mutate()} disabled={revokeOthers.isPending}>
            Sign out everywhere else
          </button>
        )}
      </div>
      <p className="sub">Each entry is a device that can renew its sign-in. Ending one signs that device out within 15 minutes.</p>
      <div className="tablewrap flush">
        <table>
          <thead>
            <tr>
              <th scope="col">Device</th>
              <th scope="col">Address</th>
              <th scope="col">Last active</th>
              <th scope="col">Expires</th>
              <th scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {sessions.data.map((s) => (
              <tr key={s.id}>
                <td className="cname">
                  {describe(s.userAgent)}
                  {s.isCurrent ? <span className="sub inline"> (this device)</span> : null}
                </td>
                <td className="mono">{s.ip ?? '—'}</td>
                <td><DateCell ts={s.lastRefreshedAt} /></td>
                <td><DateCell ts={s.expiresAt} /></td>
                <td className="cell-actions">
                  <button
                    className="btn ghost small"
                    aria-label={s.isCurrent
                      ? 'Sign out this device'
                      : `End session on ${describe(s.userAgent)}`}
                    onClick={() => endSession(s)}
                    disabled={revoke.isPending}
                  >
                    {s.isCurrent ? 'Sign out' : 'End'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
