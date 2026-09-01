import { useMemo, useState } from 'react';
import { useCan } from '../../hooks/usePermission';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { HttpError } from '../../api/http';
import { initials } from '../../lib/format';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import { PageHeader, DateCell, DataTable, FilterBar, Pill, Select, ViewPicker, type Column, type SortState } from '../../components/ui';
import { useViewLayout, orderBy } from '../../hooks/useViewLayout';
import { sortRows, type SortValues } from '../../lib/sortRows';
import { WORKSPACE_ROLES, WORKSPACE_ROLE_LABELS, type WorkspaceRole } from '../../api/types';
import { INVITABLE_ROLES, type Member, type Invite, type InvitableRole } from '../../api/endpoints';
import { useTeamData } from './useTeamData';

const SORT_VALUES: SortValues<Member> = {
  name: (m) => m.name,
  role: (m) => m.role,
  status: (m) => m.status,
  joined: (m) => m.joinedAt,
};

/** A token past its expiry no longer resolves, so the invite is dead. */
function isExpired(i: Invite): boolean {
  const ts = Date.parse(i.expiresAt);
  return Number.isFinite(ts) && ts < Date.now();
}

export default function TeamPage() {
  const can = useCan();
  const { labels } = useCurrentSession();
  const { members, pendingInvites, isLoading, isError, setStatus, removeMember, invite, cancelInvite } = useTeamData();
  const canManage = can('team.manage');

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<InvitableRole>('analyst');
  const [isInviting, setIsInviting] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [suspending, setSuspending] = useState<Member | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [cancelling, setCancelling] = useState<Invite | null>(null);
  const [role, setRole] = useState<'' | WorkspaceRole>('');
  const [access, setAccess] = useState<'' | 'active' | 'suspended'>('');
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' });
  const toggleSort = (key: string) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  // The role names an agency uses for its own people.
  const roleLabel = (role: WorkspaceRole) =>
    role === 'agent' ? labels.agent : role === 'account_owner' ? `${labels.account} owner` : WORKSPACE_ROLE_LABELS[role];

  const changeStatus = async (m: Member, status: 'active' | 'suspended') => {
    setIsBusy(true);
    try {
      await setStatus(m.userId, status);
      setSuspending(null);
      toast(status === 'active' ? `${m.name} can sign in again.` : `${m.name} suspended.`);
    } catch (err) {
      toast(err instanceof HttpError && err.status === 409 ? 'That is the last admin. Add another first.' : err instanceof Error ? err.message : 'Could not change access.');
    } finally {
      setIsBusy(false);
    }
  };

  const confirmRemove = async (m: Member) => {
    setIsBusy(true);
    try {
      await removeMember(m.userId);
      setRemoving(null);
      toast(`${m.name} no longer has access.`);
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        toast(`${m.name} has a ${roleLabel(m.role).toLowerCase()} record. Suspend them instead so the history stays.`);
      } else {
        toast(err instanceof Error ? err.message : 'Could not remove the member.');
      }
    } finally {
      setIsBusy(false);
    }
  };

  const closeInvite = () => { setInviteOpen(false); setInviteEmail(''); setInviteRole('analyst'); };

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

  const confirmCancelInvite = async (i: Invite) => {
    setIsBusy(true);
    try {
      await cancelInvite(i.id);
      setCancelling(null);
      toast(isExpired(i) ? 'Expired invite cleared.' : `Invite to ${i.email} cancelled.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not cancel the invite.');
    } finally {
      setIsBusy(false);
    }
  };

  const memberColumns: Column<Member>[] = [
    {
      key: 'person', header: 'Member', sortKey: 'name',
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
      key: 'role', header: 'Role', sortKey: 'role',
      render: (m) => (
        <>
          <span className="rolebadge">{roleLabel(m.role)}</span>
          {m.accountName ? <span className="sub inline"> · {m.accountName}</span> : null}
        </>
      ),
      isFiltered: role !== '',
      filter: (
        <Select label="Role" hideLabel value={role} onChange={(v) => setRole(v as '' | WorkspaceRole)}>
          <option value="">All roles</option>
          {WORKSPACE_ROLES.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
        </Select>
      ),
    },
    {
      key: 'status', header: 'Access', sortKey: 'status',
      render: (m) => m.status === 'active' ? <Pill tone="ok">Active</Pill> : <Pill tone="muted">Suspended</Pill>,
      isFiltered: access !== '',
      filter: (
        <Select label="Access" hideLabel value={access} onChange={(v) => setAccess(v as '' | 'active' | 'suspended')}>
          <option value="">All access</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </Select>
      ),
    },
    { key: 'joined', header: 'Joined', sortKey: 'joined', render: (m) => <DateCell ts={m.joinedAt} /> },
  ];

  const columnsView = useViewLayout('team.columns', memberColumns.map((c) => ({ key: c.key, label: c.header })));
  const shownMemberColumns: Column<Member>[] = [
    ...orderBy(memberColumns, columnsView.visibleKeys),
    // The actions cell is a control, not data: it is never hidden or moved.
    ...(canManage ? [{
      key: 'actions', header: 'Actions', hideHeader: true, align: 'right' as const,
      render: (m: Member) => m.isSelf ? null : (
        <div className="cell-actions">
          {m.status === 'active'
            ? <button className="btn ghost small" onClick={() => setSuspending(m)}>Suspend</button>
            : <button className="btn ghost small" disabled={isBusy} onClick={() => changeStatus(m, 'active')}>Reactivate</button>}
          {/* Only a plain seat can be removed; a profile keeps its login. */}
          {!m.agentId && !m.accountId && <button className="btn ghost small" onClick={() => setRemoving(m)}>Remove</button>}
        </div>
      ),
    }] : []),
  ];

  const query = search.trim().toLowerCase();
  const matchingMembers = members
    .filter((m) => !query || `${m.name} ${m.email}`.toLowerCase().includes(query))
    .filter((m) => !role || m.role === role)
    .filter((m) => !access || m.status === access);
  // The server returns the whole team at once, so the order is decided here.
  const visibleMembers = useMemo(() => sortRows(matchingMembers, sort, SORT_VALUES), [matchingMembers, sort]);

  const inviteColumns: Column<Invite>[] = [
    { key: 'email', header: 'Email', render: (i) => <span className="cemail">{i.email}</span> },
    { key: 'role', header: 'Role', render: (i) => <span className="rolebadge">{WORKSPACE_ROLE_LABELS[i.role]}</span> },
    { key: 'expires', header: 'Expires', render: (i) => isExpired(i) ? <Pill tone="muted">Expired</Pill> : <DateCell ts={i.expiresAt} /> },
    ...(canManage ? [{
      key: 'cancel', header: 'Cancel invite', hideHeader: true, align: 'right' as const,
      render: (i: Invite) => <button className="btn ghost small" onClick={() => setCancelling(i)}>{isExpired(i) ? 'Clear' : 'Cancel'}</button>,
    }] : []),
  ];

  return (
    <div>
      <PageHeader
        title="Team"
        actions={canManage ? <button className="btn" onClick={() => setInviteOpen(true)}>Invite admin or analyst</button> : null}
      />

      {members.length > 0 && (
        <FilterBar>
          <input type="search" className="search-input" aria-label="Search members" placeholder="Search name or email"
            value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="btn ghost" onClick={() => { setSearch(''); setRole(''); setAccess(''); }}>Clear filters</button>
          <span className="sub">{visibleMembers.length} of {members.length}</span>
          <ViewPicker label="Edit columns" view={columnsView} />
        </FilterBar>
      )}

      <DataTable
        columns={shownMemberColumns}
        rows={visibleMembers}
        sort={sort}
        onSort={toggleSort}
        rowKey={(m) => m.userId}
        isLoading={isLoading}
        emptyTitle={isError ? "Couldn't load the team." : query ? 'No members match that search.' : 'No members yet.'}
        emptyHint={isError ? 'Try again in a moment.' : query ? 'Clear the search to see them all.' : undefined}
      />

      {pendingInvites.length > 0 && (
        <div className="section">
          <div className="sechead">Pending invites</div>
          <DataTable columns={inviteColumns} rows={pendingInvites} rowKey={(i) => i.id} />
        </div>
      )}

      <Modal open={inviteOpen} onClose={closeInvite} title="Invite a team member" subtitle="They receive an email with a link to set their password.">
        <div className="field">
          <label htmlFor="invite-email">Email</label>
          <input id="invite-email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="invite-role">Role</label>
          <select id="invite-role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as InvitableRole)}>
            {INVITABLE_ROLES.map((r) => <option key={r} value={r}>{WORKSPACE_ROLE_LABELS[r]}</option>)}
          </select>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={closeInvite}>Cancel</button>
          <button className="btn" onClick={submitInvite} disabled={isInviting}>{isInviting ? 'Sending…' : 'Send invite'}</button>
        </div>
      </Modal>

      <Modal open={suspending !== null} onClose={() => setSuspending(null)} title={suspending ? `Suspend ${suspending.name}?` : ''}
        subtitle="They are signed out everywhere and cannot sign in until reactivated. Their records and history stay.">
        {suspending && (
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setSuspending(null)}>Keep</button>
            <button className="btn danger" disabled={isBusy} onClick={() => changeStatus(suspending, 'suspended')}>{isBusy ? 'Suspending…' : 'Suspend'}</button>
          </div>
        )}
      </Modal>

      <Modal open={removing !== null} onClose={() => setRemoving(null)} title={removing ? `Remove ${removing.name}?` : ''}
        subtitle="Their access ends immediately and they are signed out everywhere.">
        {removing && (
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setRemoving(null)}>Keep</button>
            <button className="btn danger" disabled={isBusy} onClick={() => confirmRemove(removing)}>Remove access</button>
          </div>
        )}
      </Modal>

      <Modal open={cancelling !== null} onClose={() => setCancelling(null)}
        title={cancelling ? (isExpired(cancelling) ? 'Clear this invite?' : `Cancel the invite to ${cancelling.email}?`) : ''}
        subtitle={cancelling && isExpired(cancelling) ? 'It has already expired, so this just removes it from the list.' : 'The link stops working immediately. You can always send a new one.'}>
        {cancelling && (
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setCancelling(null)}>Keep it</button>
            <button className="btn danger" disabled={isBusy} onClick={() => confirmCancelInvite(cancelling)}>
              {isBusy ? 'Cancelling…' : isExpired(cancelling) ? 'Clear invite' : 'Cancel invite'}
            </button>
          </div>
        )}
      </Modal>
    </div>
  );
}
