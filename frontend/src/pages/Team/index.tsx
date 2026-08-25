import { useState } from 'react';
import { useCan } from '../../hooks/usePermission';
import { initials } from '../../lib/format';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import { PageHeader, DateCell, DataTable, type Column } from '../../components/ui';
import type { Member, Invite } from '../../api/endpoints';
import { useTeamData } from './useTeamData';

function clampPct(v: number): number {
  return Math.min(100, Math.max(0, v));
}

export default function TeamPage() {
  const can = useCan();
  const {
    chatters, members, pendingInvites, roles, isLoading, isError,
    setCommission, setRole, removeMember, invite,
  } = useTeamData();
  const canManage = can('team.manage');
  const canViewCommission = can('commissions.view');
  const canEditCommission = can('commissions.manage');

  const [commissionEdits, setCommissionEdits] = useState<Record<string, number>>({});
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('chatter');
  const [isInviting, setIsInviting] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);

  const saveCommission = async () => {
    const dirty = Object.entries(commissionEdits);
    if (dirty.length === 0) return;
    try {
      await Promise.all(dirty.map(([id, pct]) => setCommission(id, clampPct(pct))));
      setCommissionEdits({});
      toast('Chatter commission saved.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the commission.');
    }
  };

  const changeRole = async (m: Member, role: string) => {
    try {
      await setRole(m.membershipId, role);
      toast(`${m.name} is now ${role}. They will need to sign in again.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change the role.');
    }
  };

  const confirmRemove = async (m: Member) => {
    try {
      await removeMember(m.membershipId);
      setRemoving(null);
      toast(`${m.name} no longer has access.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not remove the member.');
    }
  };

  const closeInvite = () => { setInviteOpen(false); setInviteEmail(''); setInviteRole('chatter'); };

  const submitInvite = async () => {
    const email = inviteEmail.trim();
    if (!email) { toast('Email is required.'); return; }
    setIsInviting(true);
    try {
      await invite({ email, role: inviteRole });
      closeInvite();
      toast(`Invite sent to ${email}.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not send the invite.');
    } finally {
      setIsInviting(false);
    }
  };

  const roleNames = roles.map((r) => r.name);

  const memberColumns: Column<Member>[] = [
    {
      key: 'person', header: 'Member',
      render: (m) => (
        <div className="person">
          <div className="avatar">{initials(m.name)}</div>
          <div>
            <div className="cname">{m.name}{m.isSelf ? <span className="sub inline"> (you)</span> : null}</div>
            <div className="cemail">{m.email}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'role', header: 'Role',
      render: (m) => canManage && !m.isSelf ? (
        <select value={m.role} onChange={(e) => changeRole(m, e.target.value)}>
          {roleNames.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      ) : <span className="rolebadge">{m.role}</span>,
    },
    { key: 'joined', header: 'Joined', render: (m) => <DateCell ts={m.joinedAt} /> },
    {
      key: 'actions', header: '', align: 'right',
      render: (m) => canManage && !m.isSelf ? (
        <button className="btn danger small" onClick={() => setRemoving(m)}>Remove</button>
      ) : null,
    },
  ];

  const inviteColumns: Column<Invite>[] = [
    { key: 'email', header: 'Email', render: (i) => <span className="cemail">{i.email}</span> },
    { key: 'role', header: 'Role', render: (i) => <span className="rolebadge">{i.role}</span> },
    { key: 'expires', header: 'Expires', render: (i) => <DateCell ts={i.expiresAt} /> },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="People"
        title="Team"
        subtitle="Everyone with a seat in this workspace, and who is still to join."
        actions={canManage ? <button className="btn" onClick={() => setInviteOpen(true)}>Invite member</button> : null}
      />

      <DataTable
        columns={memberColumns}
        rows={members}
        rowKey={(m) => m.membershipId}
        isLoading={isLoading}
        emptyTitle={isError ? "Couldn't load the team." : 'No members yet.'}
        emptyHint={isError ? 'Try again in a moment.' : undefined}
      />

      {canViewCommission && chatters.length > 0 && (
        <div className="card section">
          <div className="sechead">Chatter commission <span className="sechead-note">share of distributable, per chatter</span></div>
          <div className="tablewrap flush">
            <table>
              <thead>
                <tr><th>Chatter</th><th>Shift</th><th>Commission</th></tr>
              </thead>
              <tbody>
                {chatters.map((c) => (
                  <tr key={c.membershipId}>
                    <td className="cname">{c.name}</td>
                    <td>{c.shift ?? '—'}</td>
                    <td>
                      <div className="pct-input">
                        <input
                          type="number" min={0} max={100}
                          value={commissionEdits[c.membershipId] ?? c.commissionPct ?? 0}
                          disabled={!canEditCommission}
                          onChange={(e) => setCommissionEdits((prev) => ({
                            ...prev, [c.membershipId]: parseFloat(e.target.value) || 0,
                          }))}
                        />
                        <span className="sub">%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canEditCommission && (
            <div className="actions-right">
              <button className="btn" onClick={saveCommission} disabled={Object.keys(commissionEdits).length === 0}>
                Save commission
              </button>
            </div>
          )}
        </div>
      )}

      {pendingInvites.length > 0 && (
        <div className="section">
          <div className="sechead">Pending invites</div>
          <DataTable columns={inviteColumns} rows={pendingInvites} rowKey={(i) => i.id} />
        </div>
      )}

      <Modal open={inviteOpen} onClose={closeInvite}>
        <h3>Invite a team member</h3>
        <p className="sub">They receive an email with a link to set their password.</p>
        <div className="field">
          <label htmlFor="invite-email">Email</label>
          <input id="invite-email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label htmlFor="invite-role">Role</label>
          <select id="invite-role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
            {roleNames.filter((r) => r !== 'owner').map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={closeInvite}>Cancel</button>
          <button className="btn" onClick={submitInvite} disabled={isInviting}>{isInviting ? 'Sending…' : 'Send invite'}</button>
        </div>
      </Modal>

      <Modal open={removing !== null} onClose={() => setRemoving(null)}>
        {removing && (
          <>
            <h3>Remove {removing.name}?</h3>
            <p className="sub">
              Their access ends immediately and they are signed out everywhere. Their past links and sales stay in the ledger.
            </p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setRemoving(null)}>Keep</button>
              <button className="btn danger" onClick={() => confirmRemove(removing)}>Remove access</button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
