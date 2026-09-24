import { Fragment, useMemo, useState } from 'react';
import { useCan } from '../../hooks/usePermission';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { HttpError } from '../../api/http';
import { initials } from '../../lib/format';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import { PageHeader, DateCell, DataTable, FilterBar, Pill, Select, ViewPicker, type Column, type SortState } from '../../components/ui';
import { useViewLayout, orderBy } from '../../hooks/useViewLayout';
import { sortRows, type SortValues } from '../../lib/sortRows';
import {
  ROLE_PERMISSION_GROUPS, toggleRolePermission,
  type Member, type Invite, type RoleDefinition,
} from '../../api/endpoints';
import type { Permission } from '../../rbac/permissions';
import { useTeamData } from './useTeamData';

const SORT_VALUES: SortValues<Member> = {
  name: (m) => m.name,
  role: (m) => m.role,
  status: (m) => m.status,
  joined: (m) => m.joinedAt,
};

type TeamView = 'active' | 'agents' | 'creators' | 'plain' | 'former' | 'invites';

/** A token past its expiry no longer resolves, so the invite is dead. */
function isExpired(i: Invite): boolean {
  const ts = Date.parse(i.expiresAt);
  return Number.isFinite(ts) && ts < Date.now();
}

export default function TeamPage({ embedded = false }: { embedded?: boolean }) {
  const can = useCan();
  const { labels, role: currentRole, user } = useCurrentSession();
  const {
    members, roles, pendingInvites, isLoading, isError,
    setStatus, setRole: assignRole, transferOwner, removeMember,
    createMember, createRole, updateRole, removeRole, cancelInvite,
  } = useTeamData();
  const canManage = can('team.manage');
  const canManageRoles = currentRole === 'workspace_owner' || Boolean(user?.isPlatformAdmin);

  const [memberOpen, setMemberOpen] = useState(false);
  const [memberEmail, setMemberEmail] = useState('');
  const [memberFullName, setMemberFullName] = useState('');
  const [memberPassword, setMemberPassword] = useState('');
  const [memberRole, setMemberRole] = useState('analyst');
  const [isCreatingMember, setIsCreatingMember] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [suspending, setSuspending] = useState<Member | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [cancelling, setCancelling] = useState<Invite | null>(null);
  const [role, setRole] = useState('');
  const [editingRole, setEditingRole] = useState<RoleDefinition | 'new' | null>(null);
  const [roleName, setRoleName] = useState('');
  const [rolePermissions, setRolePermissions] = useState<Permission[]>([]);
  const [deletingRole, setDeletingRole] = useState<RoleDefinition | null>(null);
  const [access, setAccess] = useState<'' | 'active' | 'suspended'>('');
  const [view, setView] = useState<TeamView>('active');
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' });
  const toggleSort = (key: string) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  // The role names an agency uses for its own people.
  const roleLabel = (key: string) => {
    if (key === 'agent') return labels.agent;
    if (key === 'account_owner') return `${labels.account} owner`;
    return roles.find((item) => item.key === key)?.name ?? key;
  };
  const canAssignRole = (item: RoleDefinition) =>
    item.permissions.every((permission) => can(permission));

  const openRoleEditor = (target: RoleDefinition | 'new') => {
    setEditingRole(target);
    setRoleName(target === 'new' ? '' : target.name);
    setRolePermissions(target === 'new'
      ? ['data.view_all']
      : target.permissions.filter((permission) => permission !== 'roles.manage'));
  };

  const togglePermission = (permission: Permission) => {
    if (permission === 'data.view_all') return;
    setRolePermissions((current) => toggleRolePermission(current, permission));
  };

  const saveRole = async () => {
    setIsBusy(true);
    try {
      if (editingRole === 'new') await createRole(roleName.trim(), rolePermissions);
      else if (editingRole) await updateRole(editingRole.key, { name: roleName.trim(), permissions: rolePermissions });
      setEditingRole(null);
      toast('Role saved.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the role.');
    } finally {
      setIsBusy(false);
    }
  };

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

  const closeMember = () => {
    setMemberOpen(false);
    setMemberEmail('');
    setMemberFullName('');
    setMemberPassword('');
    setMemberRole('analyst');
  };

  const submitMember = async () => {
    const email = memberEmail.trim();
    if (!email) { toast('Email is required.'); return; }
    if (memberPassword.length < 8) { toast('Password must be at least 8 characters.'); return; }
    setIsCreatingMember(true);
    try {
      await createMember({
        email,
        password: memberPassword,
        fullName: memberFullName.trim() || undefined,
        role: memberRole,
      });
      closeMember();
      toast(`Created ${email}.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the member.');
    } finally {
      setIsCreatingMember(false);
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
          <span className="rolebadge">{['agent', 'account_owner'].includes(m.role) ? roleLabel(m.role) : m.roleName}</span>
          {m.accountName ? <span className="sub inline"> · {m.accountName}</span> : null}
        </>
      ),
      isFiltered: role !== '',
      filter: (
        <Select label="Role" hideLabel value={role} onChange={setRole}>
          <option value="">All roles</option>
          {roles.map((item) => <option key={item.key} value={item.key}>{roleLabel(item.key)}</option>)}
        </Select>
      ),
    },
    {
      key: 'status', header: 'Access', sortKey: 'status',
      render: (m) => m.accountStatus === 'archived'
        ? <Pill tone="muted">Archived</Pill>
        : m.status === 'active'
          ? <Pill tone="ok">Active</Pill>
          : <Pill tone="muted">{m.status === 'removed' ? 'Removed' : 'Suspended'}</Pill>,
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
          {canManageRoles && m.role !== 'workspace_owner' && m.status !== 'removed' && m.accountStatus !== 'archived' && (
            <select
              aria-label={`Role for ${m.name}`}
              value={m.role}
              onChange={async (event) => {
                try {
                  await assignRole(m.userId, event.target.value);
                  toast(`${m.name}'s role changed.`);
                } catch (err) {
                  toast(err instanceof Error ? err.message : 'Could not change role.');
                }
              }}
            >
              {roles
                .filter((item) => item.key !== 'workspace_owner')
                .filter((item) => m.agentId ? item.key === 'agent' : m.accountId ? item.key === 'account_owner' : !['agent', 'account_owner'].includes(item.key))
                .filter((item) => item.key === m.role || canAssignRole(item))
                .map((item) => <option key={item.key} value={item.key}>{roleLabel(item.key)}</option>)}
            </select>
          )}
          {canManageRoles && currentRole === 'workspace_owner' && m.status === 'active' && !m.agentId && !m.accountId && !m.isSelf && (
            <button className="btn ghost small" onClick={async () => {
              try {
                await transferOwner(m.userId);
                toast(`Ownership transferred to ${m.name}.`);
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Could not transfer ownership.');
              }
            }}>Make owner</button>
          )}
          {m.accountStatus !== 'archived' && (m.status === 'active'
            ? <button className="btn ghost small" onClick={() => setSuspending(m)}>Suspend</button>
            : <button className="btn ghost small" disabled={isBusy} onClick={() => changeStatus(m, 'active')}>Reactivate</button>)}
          {/* Only a plain seat can be removed; a profile keeps its login. */}
          {!m.agentId && !m.accountId && m.status !== 'removed' && <button className="btn ghost small" onClick={() => setRemoving(m)}>Remove</button>}
        </div>
      ),
    }] : []),
  ];

  const query = search.trim().toLowerCase();
  const isFormer = (m: Member) => m.status !== 'active' || m.accountStatus === 'archived';
  const matchingMembers = members
    .filter((m) => {
      if (view === 'former') return isFormer(m);
      if (isFormer(m)) return false;
      if (view === 'agents') return Boolean(m.agentId);
      if (view === 'creators') return Boolean(m.accountId);
      if (view === 'plain') return !m.agentId && !m.accountId;
      return true;
    })
    .filter((m) => !query || `${m.name} ${m.email}`.toLowerCase().includes(query))
    .filter((m) => !role || m.role === role)
    .filter((m) => !access || m.status === access);
  // The server returns the whole team at once, so the order is decided here.
  const visibleMembers = useMemo(() => sortRows(matchingMembers, sort, SORT_VALUES), [matchingMembers, sort]);

  const inviteColumns: Column<Invite>[] = [
    { key: 'email', header: 'Email', render: (i) => <span className="cemail">{i.email}</span> },
    { key: 'role', header: 'Role', render: (i) => <span className="rolebadge">{roleLabel(i.role)}</span> },
    { key: 'expires', header: 'Expires', render: (i) => isExpired(i) ? <Pill tone="muted">Expired</Pill> : <DateCell ts={i.expiresAt} /> },
    ...(canManage ? [{
      key: 'cancel', header: 'Cancel invite', hideHeader: true, align: 'right' as const,
      render: (i: Invite) => <button className="btn ghost small" onClick={() => setCancelling(i)}>{isExpired(i) ? 'Clear' : 'Cancel'}</button>,
    }] : []),
  ];
  const views: Array<{ id: TeamView; label: string; count: number }> = [
    { id: 'active', label: 'Active', count: members.filter((m) => !isFormer(m)).length },
    { id: 'agents', label: labels.agents, count: members.filter((m) => !isFormer(m) && m.agentId).length },
    { id: 'creators', label: labels.accounts, count: members.filter((m) => !isFormer(m) && m.accountId).length },
    { id: 'plain', label: 'Admin, analyst, and custom roles', count: members.filter((m) => !isFormer(m) && !m.agentId && !m.accountId).length },
    { id: 'former', label: 'Former', count: members.filter(isFormer).length },
    { id: 'invites', label: 'Pending invites', count: pendingInvites.length },
  ];

  return (
    <div className="team-page">
      {!embedded && (
        <PageHeader
          title="People & access"
          subtitle="One place to add people, set their role, control access, and manage invitations."
          actions={canManageRoles ? <button className="btn" onClick={() => setMemberOpen(true)}>Add user</button> : null}
        />
      )}
      {embedded && canManageRoles && <div className="page-inline-actions"><button className="btn" onClick={() => setMemberOpen(true)}>Add user</button></div>}

      <div className="tabbar" role="tablist" aria-label="Team views">
        {views.map((item, index) => (
          <button
            key={item.id}
            id={`team-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={view === item.id}
            aria-controls={`team-panel-${item.id}`}
            tabIndex={view === item.id ? 0 : -1}
            className={`btn ghost tgl${view === item.id ? ' active' : ''}`}
            onClick={() => setView(item.id)}
            onKeyDown={(event) => {
              const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
              if (step === 0) return;
              event.preventDefault();
              const next = views[(index + step + views.length) % views.length];
              setView(next.id);
              document.getElementById(`team-tab-${next.id}`)?.focus();
            }}
          >
            {item.label} <span className="sub inline">{item.count}</span>
          </button>
        ))}
      </div>

      {canManageRoles && (
        <div className="section">
          <div className="sechead">
            Roles
            <button className="btn small" onClick={() => openRoleEditor('new')}>Create role</button>
          </div>
          <div className="card">
            {roles.map((item) => (
              <div className="settings-row" key={item.key}>
                <div>
                  <div className="cname">{roleLabel(item.key)}</div>
                  <div className="sub">{item.memberCount} members · {item.permissions.length} permissions</div>
                </div>
                <div className="cell-actions">
                  {!item.permissionsFixed && <button className="btn ghost small" onClick={() => openRoleEditor(item)}>Edit</button>}
                  {!item.isSystem && <button className="btn ghost small" onClick={() => setDeletingRole(item)}>Delete</button>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {view !== 'invites' && members.length > 0 && (
        <FilterBar>
          <input type="search" className="search-input" aria-label="Search members" placeholder="Search name or email"
            value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="btn ghost" onClick={() => { setSearch(''); setRole(''); setAccess(''); }}>Clear filters</button>
          <span className="sub">{visibleMembers.length} of {members.length}</span>
          <ViewPicker label="Edit columns" view={columnsView} />
        </FilterBar>
      )}

      <div id={`team-panel-${view}`} role="tabpanel" aria-labelledby={`team-tab-${view}`}>
        {view === 'invites' ? (
          <DataTable columns={inviteColumns} rows={pendingInvites} rowKey={(i) => i.id}
            emptyTitle="No pending invites." emptyHint="Invite a team member from the button above." />
        ) : (
          <DataTable
            columns={shownMemberColumns}
            rows={visibleMembers}
            sort={sort}
            onSort={toggleSort}
            rowKey={(m) => m.userId}
            isLoading={isLoading}
            emptyTitle={isError ? "Couldn't load the team." : query ? 'No members match that search.' : 'No members in this view.'}
            emptyHint={isError ? 'Try again in a moment.' : query ? 'Clear the search to see them all.' : undefined}
          />
        )}
      </div>

      <Modal open={memberOpen} onClose={closeMember} title="Create team member" subtitle="The account is ready to use immediately. No invitation email is sent.">
        <div className="field">
          <label htmlFor="member-email">Email</label>
          <input id="member-email" type="email" autoComplete="username" value={memberEmail} onChange={(e) => setMemberEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="member-name">Full name</label>
          <input id="member-name" type="text" autoComplete="name" value={memberFullName} onChange={(e) => setMemberFullName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="member-password">Password</label>
          <input id="member-password" type="password" autoComplete="new-password" value={memberPassword} onChange={(e) => setMemberPassword(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="member-role">Role</label>
          <select id="member-role" value={memberRole} onChange={(e) => setMemberRole(e.target.value)}>
            {roles.filter((item) => !['workspace_owner', 'agent', 'account_owner'].includes(item.key))
              .filter(canAssignRole)
              .map((item) => <option key={item.key} value={item.key}>{roleLabel(item.key)}</option>)}
          </select>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={closeMember}>Cancel</button>
          <button className="btn" onClick={submitMember} disabled={isCreatingMember}>{isCreatingMember ? 'Creating…' : 'Create member'}</button>
        </div>
      </Modal>

      <Modal open={editingRole !== null} onClose={() => setEditingRole(null)}
        title={editingRole === 'new' ? 'Create role' : `Edit ${roleName}`}>
        <div className="field">
          <label htmlFor="role-name">Name</label>
          <input id="role-name" value={roleName} disabled={editingRole !== 'new' && editingRole?.isSystem}
            onChange={(event) => setRoleName(event.target.value)} />
        </div>
        <div className="tablewrap">
          <table>
            <thead>
              <tr><th scope="col">Permission</th><th scope="col">Enabled</th></tr>
            </thead>
            <tbody>
              {ROLE_PERMISSION_GROUPS.map((group) => (
                <Fragment key={group.label}>
                  <tr><th scope="rowgroup" colSpan={2} className="field-label">{group.label}</th></tr>
                  {group.permissions.map((permission) => (
                    <tr key={permission.key}>
                      <th scope="row">{permission.label}</th>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`${permission.label} for ${roleName}`}
                          checked={rolePermissions.includes(permission.key)}
                          disabled={permission.key === 'data.view_all'}
                          onChange={() => togglePermission(permission.key)}
                        />
                      </td>
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <p className="sub">Workspace data access is required for custom roles. Role changes are restricted to the agency owner and platform admins.</p>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setEditingRole(null)}>Cancel</button>
          <button className="btn" disabled={isBusy || !roleName.trim()} onClick={saveRole}>Save role</button>
        </div>
      </Modal>

      <Modal open={deletingRole !== null} onClose={() => setDeletingRole(null)}
        title={deletingRole ? `Delete ${deletingRole.name}?` : ''} subtitle="A role with members or pending invites cannot be deleted.">
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setDeletingRole(null)}>Cancel</button>
          <button className="btn danger" disabled={isBusy} onClick={async () => {
            if (!deletingRole) return;
            setIsBusy(true);
            try {
              await removeRole(deletingRole.key);
              setDeletingRole(null);
              toast('Role deleted.');
            } catch (err) {
              toast(err instanceof Error ? err.message : 'Could not delete the role.');
            } finally {
              setIsBusy(false);
            }
          }}>Delete role</button>
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
