import { useState } from 'react';
import { useCan } from '../../hooks/usePermission';
import { initials } from '../../lib/format';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import { PageHeader, DateCell, DataTable, FilterBar, type Column } from '../../components/ui';
import type { Member, Invite } from '../../api/endpoints';
import { useTeamData } from './useTeamData';

function clampPct(v: number): number {
  return Math.min(100, Math.max(0, v));
}

/** NaN for anything that isn't a usable percentage, so callers can flag it. */
function parsePct(text: string): number {
  const n = parseFloat(text);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : Number.NaN;
}

export default function TeamPage() {
  const can = useCan();
  const {
    agents, members, pendingInvites, roles, isLoading, isError,
    setCommission, setRole, removeMember, invite,
  } = useTeamData();
  const canManage = can('team.manage');
  const canViewCommission = can('commissions.view');
  const canEditCommission = can('commissions.manage');

  // Raw text, not numbers: parsing on every keystroke turns a cleared field
  // into 0 and makes the box impossible to retype.
  const [commissionEdits, setCommissionEdits] = useState<Record<string, string>>({});
  const [isSavingCommission, setIsSavingCommission] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('agent');
  const [isInviting, setIsInviting] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [roleChange, setRoleChange] = useState<{ member: Member; role: string } | null>(null);
  const [isChangingRole, setIsChangingRole] = useState(false);
  const [search, setSearch] = useState('');

  const saveCommission = async () => {
    const dirty = Object.entries(commissionEdits);
    if (dirty.length === 0) return;
    setIsSavingCommission(true);
    // allSettled, not all: one rejected update must not strand the rows that
    // did save, or the table keeps offering to re-save them.
    const results = await Promise.allSettled(
      dirty.map(([id, text]) => setCommission(id, clampPct(parsePct(text)))),
    );
    setIsSavingCommission(false);

    const failed = dirty.filter((_, i) => results[i].status === 'rejected').map(([id]) => id);
    setCommissionEdits(Object.fromEntries(failed.map((id) => [id, commissionEdits[id]])));
    toast(failed.length === 0
      ? 'Agent commission saved.'
      : `Saved ${dirty.length - failed.length} of ${dirty.length}. Try the rest again.`);
  };

  const confirmRoleChange = async ({ member, role }: { member: Member; role: string }) => {
    setIsChangingRole(true);
    try {
      await setRole(member.membershipId, role);
      setRoleChange(null);
      toast(`${member.name} is now ${role}. They will need to sign in again.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change the role.');
    } finally {
      setIsChangingRole(false);
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

  const closeInvite = () => { setInviteOpen(false); setInviteEmail(''); setInviteRole('agent'); };

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

  // Ownership is not something you hand over from a dropdown, so `owner` is
  // never offered here — the same rule the invite form already follows.
  const assignableRoles = roles.map((r) => r.name).filter((r) => r !== 'owner');

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
      render: (m) => canManage && !m.isSelf && m.role !== 'owner' ? (
        <select
          aria-label={`Role for ${m.name}`}
          value={m.role}
          onChange={(e) => setRoleChange({ member: m, role: e.target.value })}
        >
          {assignableRoles.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      ) : <span className="rolebadge">{m.role}</span>,
    },
    { key: 'joined', header: 'Joined', render: (m) => <DateCell ts={m.joinedAt} /> },
    {
      key: 'actions', header: 'Actions', hideHeader: true, align: 'right',
      render: (m) => canManage && !m.isSelf ? (
        <button className="btn danger small" onClick={() => setRemoving(m)}>Remove</button>
      ) : null,
    },
  ];

  const query = search.trim().toLowerCase();
  const visibleMembers = query
    ? members.filter((m) => `${m.name} ${m.email}`.toLowerCase().includes(query))
    : members;

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

      {members.length > 0 && (
        <FilterBar>
          <input
            type="search" className="search-input" aria-label="Search members"
            placeholder="Search name or email" value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="sub">{visibleMembers.length} of {members.length}</span>
        </FilterBar>
      )}

      <DataTable
        columns={memberColumns}
        rows={visibleMembers}
        rowKey={(m) => m.membershipId}
        isLoading={isLoading}
        emptyTitle={
          isError ? "Couldn't load the team."
            : query ? 'No members match that search.'
              : 'No members yet.'
        }
        emptyHint={isError ? 'Try again in a moment.' : query ? 'Clear the search to see them all.' : undefined}
      />

      {canViewCommission && agents.length > 0 && (
        <div className="card section">
          <div className="sechead">Agent commission <span className="sechead-note">share of distributable, per agent</span></div>
          <div className="tablewrap flush">
            <table>
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Shift</th>
                  <th scope="col">Commission</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((c) => {
                  const text = commissionEdits[c.membershipId] ?? String(c.commissionPct ?? 0);
                  return (
                    <tr key={c.membershipId}>
                      <td className="cname">{c.name}</td>
                      <td>{c.shift ?? '—'}</td>
                      <td>
                        <div className="pct-input">
                          <input
                            type="number" min={0} max={100} value={text}
                            aria-label={`${c.name} commission, percent`}
                            aria-invalid={Number.isNaN(parsePct(text))}
                            disabled={!canEditCommission}
                            onChange={(e) => setCommissionEdits((prev) => ({
                              ...prev, [c.membershipId]: e.target.value,
                            }))}
                          />
                          <span className="sub">%</span>
                          {Number.isNaN(parsePct(text)) && <span className="sub text-neg">0–100 only</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {canEditCommission && (
            <div className="actions-right">
              <button
                className="btn"
                onClick={saveCommission}
                disabled={
                  isSavingCommission
                  || Object.keys(commissionEdits).length === 0
                  || Object.values(commissionEdits).some((t) => Number.isNaN(parsePct(t)))
                }
              >
                {isSavingCommission ? 'Saving…' : 'Save commission'}
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

      <Modal
        open={inviteOpen}
        onClose={closeInvite}
        title="Invite a team member"
        subtitle="They receive an email with a link to set their password."
      >
        <div className="field">
          <label htmlFor="invite-email">Email</label>
          <input id="invite-email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="invite-role">Role</label>
          <select id="invite-role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
            {assignableRoles.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={closeInvite}>Cancel</button>
          <button className="btn" onClick={submitInvite} disabled={isInviting}>{isInviting ? 'Sending…' : 'Send invite'}</button>
        </div>
      </Modal>

      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={removing ? `Remove ${removing.name}?` : ''}
        subtitle="Their access ends immediately and they are signed out everywhere. Their past links and sales stay in the ledger."
      >
        {removing && (
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setRemoving(null)}>Keep</button>
            <button className="btn danger" onClick={() => confirmRemove(removing)}>Remove access</button>
          </div>
        )}
      </Modal>

      <Modal
        open={roleChange !== null}
        onClose={() => setRoleChange(null)}
        title={roleChange ? `Make ${roleChange.member.name} ${roleChange.role}?` : ''}
        subtitle="Their permissions change immediately and they are signed out everywhere, so they have to sign in again."
      >
        {roleChange && (
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setRoleChange(null)}>Cancel</button>
            <button className="btn" disabled={isChangingRole} onClick={() => confirmRoleChange(roleChange)}>
              {isChangingRole ? 'Changing…' : `Change to ${roleChange.role}`}
            </button>
          </div>
        )}
      </Modal>
    </div>
  );
}
