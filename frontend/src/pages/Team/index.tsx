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
import { WORKSPACE_ROLE_LABELS } from '../../api/types';
import {
  INVITABLE_ROLES, ROLE_PERMISSION_GROUPS,
  type Member, type Invite, type InvitableRole, type RoleDefinition,
} from '../../api/endpoints';
import type { Permission } from '../../rbac/permissions';
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
  const { labels, role: currentRole } = useCurrentSession();
  const {
    members, roles, pendingInvites, isLoading, isError,
    setStatus, setRole, removeMember, createRole, updateRole, removeRole, invite, cancelInvite,
  } = useTeamData();
  const canManage = can('team.manage');
  const canManageRoles = can('roles.manage');

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<InvitableRole>('analyst');
  const [isInviting, setIsInviting] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [suspending, setSuspending] = useState<Member | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [cancelling, setCancelling] = useState<Invite | null>(null);
  const [roleEditing, setRoleEditing] = useState<Member | null>(null);
  const [roleCreating, setRoleCreating] = useState(false);
  const [roleFilter, setRoleFilter] = useState('');
  const [access, setAccess] = useState<'' | 'active' | 'suspended'>('');
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' });
  const toggleSort = (key: string) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  // The role names an agency uses for its own people.
  const roleLabel = (key: string) =>
    key === 'agent' ? labels.agent
      : key === 'account_owner' ? labels.account
        : roles.find((r) => r.key === key)?.name ?? WORKSPACE_ROLE_LABELS[key] ?? key;

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

  const changeRole = async (m: Member, nextRole: string) => {
    setIsBusy(true);
    try {
      await setRole(m.userId, nextRole);
      setRoleEditing(null);
      toast(`${m.name} is now ${roleLabel(nextRole)}.`);
    } catch (err) {
      toast(err instanceof HttpError && err.status === 409
        ? 'This member has a creator or agent profile. Change that profile from its own page.'
        : err instanceof Error ? err.message : 'Could not change the role.');
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
      isFiltered: roleFilter !== '',
      filter: (
        <Select label="Role" hideLabel value={roleFilter} onChange={setRoleFilter}>
          <option value="">All roles</option>
          {roles.map((r) => <option key={r.key} value={r.key}>{roleLabel(r.key)}</option>)}
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
    ...(canManage || canManageRoles ? [{
      key: 'actions', header: 'Actions', hideHeader: true, align: 'right' as const,
      render: (m: Member) => m.isSelf ? null : (
        <div className="cell-actions">
          {canManageRoles && <button className="btn ghost small" onClick={() => setRoleEditing(m)}>Edit role</button>}
          {m.status === 'active'
            ? canManage && <button className="btn ghost small" onClick={() => setSuspending(m)}>Suspend</button>
            : canManage && <button className="btn ghost small" disabled={isBusy} onClick={() => changeStatus(m, 'active')}>Reactivate</button>}
          {/* Only a plain seat can be removed; a profile keeps its login. */}
          {canManage && !m.agentId && !m.accountId && <button className="btn ghost small" onClick={() => setRemoving(m)}>Remove</button>}
        </div>
      ),
    }] : []),
  ];

  const query = search.trim().toLowerCase();
  const matchingMembers = members
    .filter((m) => !query || `${m.name} ${m.email}`.toLowerCase().includes(query))
    .filter((m) => !roleFilter || m.role === roleFilter)
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
        title="Role management"
        actions={canManage || canManageRoles ? (
          <div className="page-actions">
            {canManageRoles && <button className="btn ghost" onClick={() => setRoleCreating(true)}>Add new role</button>}
            {canManage && <button className="btn" onClick={() => setInviteOpen(true)}>Invite admin or analyst</button>}
          </div>
        ) : null}
      />

      {members.length > 0 && (
        <FilterBar>
          <input type="search" className="search-input" aria-label="Search members" placeholder="Search name or email"
            value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="btn ghost" onClick={() => { setSearch(''); setRoleFilter(''); setAccess(''); }}>Clear filters</button>
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

      <RolePermissionsTable
        roles={roles}
        canEdit={canManageRoles}
        onSave={updateRole}
        onRemove={removeRole}
      />

      <RoleFormModal
        open={roleCreating}
        onClose={() => setRoleCreating(false)}
        onSubmit={async (name, permissions) => {
          await createRole(name, permissions);
          setRoleCreating(false);
          toast(`${name} role created.`);
        }}
      />

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

      <RoleAssignmentModal
        key={roleEditing?.userId ?? 'role-assignment'}
        member={roleEditing}
        roles={roles}
        currentRoleLabel={roleEditing ? roleLabel(roleEditing.role) : ''}
        canTransferOwnership={currentRole === 'workspace_owner'}
        isBusy={isBusy}
        onClose={() => setRoleEditing(null)}
        onSubmit={(nextRole) => roleEditing ? changeRole(roleEditing, nextRole) : Promise.resolve()}
        roleLabel={roleLabel}
      />
    </div>
  );
}

const PERMISSION_COLUMNS = ROLE_PERMISSION_GROUPS.flatMap((group) =>
  group.permissions.map((permission) => ({ ...permission, group: group.label })),
);

function RolePermissionsTable({ roles, canEdit, onSave, onRemove }: {
  roles: RoleDefinition[];
  canEdit: boolean;
  onSave: (key: string, input: { permissions: Permission[] }) => Promise<void>;
  onRemove: (key: string) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, Permission[]>>({});
  const [draftNames, setDraftNames] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const toggle = (role: RoleDefinition, permission: Permission) => {
    const current = drafts[role.key] ?? role.permissions;
    const next = current.includes(permission)
      ? current.filter((value) => value !== permission)
      : [...current, permission];
    setDrafts((previous) => ({ ...previous, [role.key]: next }));
  };

  const save = async (role: RoleDefinition) => {
    setSaving(role.key);
    try {
      await onSave(role.key, {
        ...(draftNames[role.key] !== undefined ? { name: draftNames[role.key] } : {}),
        permissions: drafts[role.key] ?? role.permissions,
      });
      setDrafts((previous) => {
        const next = { ...previous };
        delete next[role.key];
        return next;
      });
      setDraftNames((previous) => {
        const next = { ...previous };
        delete next[role.key];
        return next;
      });
      toast(`${role.name} permissions saved.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save permissions.');
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="role-permissions card">
      <div className="sechead">Role permissions</div>
      <p className="sub">Choose what each role can do. Owner permissions are fixed and ownership can be transferred from the member list.</p>
      <div className="role-matrix-scroll">
        <table className="role-matrix">
          <thead>
            <tr>
              <th scope="col">Role</th>
              {PERMISSION_COLUMNS.map((permission) => (
                <th scope="col" key={permission.key} title={permission.label}>{permission.label}</th>
              ))}
              {canEdit && <th scope="col">Save</th>}
            </tr>
          </thead>
          <tbody>
            {roles.map((role) => {
              const permissions = drafts[role.key] ?? role.permissions;
              const changed = drafts[role.key] !== undefined || draftNames[role.key] !== undefined;
              const fixed = role.key === 'workspace_owner';
              return (
                <tr key={role.key}>
                  <th scope="row">
                    {role.isSystem
                      ? <span className="role-matrix-name">{role.name}</span>
                      : <input className="role-matrix-name-input" aria-label={`${role.name} role name`}
                          value={draftNames[role.key] ?? role.name}
                          onChange={(event) => setDraftNames((previous) => ({ ...previous, [role.key]: event.target.value }))} />}
                    <span className="sub">{role.memberCount} member{role.memberCount === 1 ? '' : 's'}</span>
                    {!role.isSystem && (
                      <button className="btn ghost small" disabled={role.memberCount > 0}
                        title={role.memberCount > 0 ? 'Reassign members before deleting this role.' : undefined}
                        onClick={() => void onRemove(role.key)}>
                        Delete
                      </button>
                    )}
                  </th>
                  {PERMISSION_COLUMNS.map((permission) => (
                    <td key={permission.key}>
                      <input
                        type="checkbox"
                        aria-label={`${role.name}: ${permission.label}`}
                        checked={permissions.includes(permission.key)}
                        disabled={!canEdit || fixed}
                        onChange={() => toggle(role, permission.key)}
                      />
                    </td>
                  ))}
                  {canEdit && (
                    <td>
                      <button className="btn small" disabled={!changed || fixed || saving === role.key} onClick={() => void save(role)}>
                        {saving === role.key ? 'Saving…' : 'Save'}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RoleFormModal({ open, onClose, onSubmit }: {
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string, permissions: Permission[]) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [saving, setSaving] = useState(false);

  const close = () => {
    setName('');
    setPermissions([]);
    onClose();
  };
  const toggle = (permission: Permission) => setPermissions((current) =>
    current.includes(permission) ? current.filter((value) => value !== permission) : [...current, permission]);
  const submit = async () => {
    if (!name.trim()) { toast('Role name is required.'); return; }
    setSaving(true);
    try {
      await onSubmit(name.trim(), permissions);
      setName('');
      setPermissions([]);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create the role.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={close} title="Add new role" subtitle="Create a role with only the access it needs.">
      <div className="field">
        <label htmlFor="new-role-name">Role name</label>
        <input id="new-role-name" type="text" value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="role-form-permissions">
        {ROLE_PERMISSION_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="sechead">{group.label}</div>
            {group.permissions.map((permission) => (
              <label className="check-row" key={permission.key}>
                <input type="checkbox" checked={permissions.includes(permission.key)} onChange={() => toggle(permission.key)} />
                <span>{permission.label}</span>
              </label>
            ))}
          </div>
        ))}
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={close}>Cancel</button>
        <button className="btn" disabled={saving} onClick={() => void submit()}>{saving ? 'Creating…' : 'Create role'}</button>
      </div>
    </Modal>
  );
}

function RoleAssignmentModal({ member, roles, currentRoleLabel, canTransferOwnership, isBusy, onClose, onSubmit, roleLabel }: {
  member: Member | null;
  roles: RoleDefinition[];
  currentRoleLabel: string;
  canTransferOwnership: boolean;
  isBusy: boolean;
  onClose: () => void;
  onSubmit: (role: string) => Promise<void>;
  roleLabel: (key: string) => string;
}) {
  const [selected, setSelected] = useState('');

  if (!member) return null;
  const hasProfile = Boolean(member.agentId || member.accountId);
  const selectable = (role: RoleDefinition) =>
    !hasProfile || role.key === member.role;

  return (
    <Modal open onClose={onClose} title={`Edit ${member.name}'s role`} subtitle={hasProfile
      ? `This member has a ${currentRoleLabel.toLowerCase()} profile. Change that profile from its own page.`
      : 'Role changes take effect immediately.'}>
      <div className="field">
        <label htmlFor="member-role">Role</label>
        <select id="member-role" value={selected || member.role} onChange={(event) => setSelected(event.target.value)}>
          {roles.map((role) => (
            <option key={role.key} value={role.key} disabled={!selectable(role) || (role.key === 'workspace_owner' && !canTransferOwnership)}>
              {roleLabel(role.key)}
            </option>
          ))}
        </select>
      </div>
      {selected === 'workspace_owner' && <p className="sub">This transfers the single workspace owner role to this member.</p>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={isBusy || (selected || member.role) === member.role} onClick={() => void onSubmit(selected || member.role)}>
          {isBusy ? 'Saving…' : 'Save role'}
        </button>
      </div>
    </Modal>
  );
}
