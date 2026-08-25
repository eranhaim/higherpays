import { useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { useCan } from '../../hooks/usePermission';
import { toast } from '../../components/Toast';
import { PageHeader } from '../../components/ui';
import { useTeamData } from './useTeamData';

const initials = (n: string) =>
  n.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();

export default function TeamPage() {
  const can = useCan();
  const members = useAppStore(s => s.members);
  const { chatters, isLoading, isError, setCommission } = useTeamData();
  const commission = useAppStore(s => s.commission);

  const people = [
    ...members.map(m => ({ name: m.name, email: m.email, role: m.role, extra: '' })),
    ...chatters.map(c => ({
      name: c.name, email: c.email, role: 'chatter' as const,
      extra: `${c.shift} \u00b7 ${c.assigned.join(', ') || 'unassigned'}`,
    })),
  ];

  const canViewComm = can('commissions.view');
  const canManageComm = can('commissions.manage');
  const [commEdits, setCommEdits] = useState<Record<string, number>>({});

  const getCommPct = (ch: typeof chatters[0]) =>
    commEdits[ch.id] ?? ch.commissionPct ?? commission.chatterPct;

  const saveCommission = async () => {
    const dirty = Object.entries(commEdits);
    if (dirty.length === 0) return;
    try {
      await Promise.all(dirty.map(([id, pct]) => setCommission(id, pct)));
      setCommEdits({});
      toast('Chatter commission saved.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save commission.');
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="People"
        title="Team"
        subtitle="Everyone with a seat in this workspace."
      />

      <div className="card">
        <div className="tablewrap" style={{ border: 'none' }}>
          <table>
            <thead>
              <tr><th>Person</th><th>Role</th><th>Details</th></tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={3} style={{ padding: 36, textAlign: 'center', color: 'var(--muted)' }}>Loading team…</td></tr>
              ) : isError ? (
                <tr><td colSpan={3} style={{ padding: 36, textAlign: 'center', color: 'var(--neg)' }}>Couldn't load team.</td></tr>
              ) : people.length === 0 ? (
                <tr><td colSpan={3} style={{ padding: 36, textAlign: 'center', color: 'var(--muted)' }}>No team members yet.</td></tr>
              ) : people.map((p, i) => (
                <tr key={i}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div className="avatar" style={{ width: 30, height: 30, fontSize: '13.2px' }}>
                        {initials(p.name)}
                      </div>
                      <div>
                        <div className="cname">{p.name}</div>
                        <div className="cemail">{p.email}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={`rolebadge ${p.role === 'owner' ? 'owner' : ''}`}>
                      {p.role[0].toUpperCase() + p.role.slice(1)}
                    </span>
                  </td>
                  <td className="cemail">{p.extra}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {canViewComm && chatters.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="card">
            <div className="sechead" style={{ marginTop: 0 }}>
              Chatter commission{' '}
              <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: '13.2px' }}>
                &mdash; % of distributable, set per chatter
              </span>
            </div>
            <div className="tablewrap" style={{ border: 'none' }}>
              <table>
                <thead>
                  <tr><th>Chatter</th><th>Commission of distributable</th></tr>
                </thead>
                <tbody>
                  {chatters.map(ch => (
                    <tr key={ch.id}>
                      <td className="cname">{ch.name}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <input
                            type="number"
                            value={getCommPct(ch)}
                            min={0}
                            max={100}
                            disabled={!canManageComm}
                            onChange={e => setCommEdits(prev => ({
                              ...prev, [ch.id]: +e.target.value,
                            }))}
                            style={{ width: 80 }}
                          />
                          <span style={{ color: 'var(--muted)' }}>%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {canManageComm && (
              <div style={{ textAlign: 'right', marginTop: 10 }}>
                <button className="btn" onClick={saveCommission}>Save chatter commission</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
