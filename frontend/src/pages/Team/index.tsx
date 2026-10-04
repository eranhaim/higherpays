import { useMemo, useState } from 'react';
import { useCan } from '../../hooks/usePermission';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { initials } from '../../lib/format';
import { toast } from '../../lib/toast';
import Modal from '../../components/Modal';
import { Money } from '../../components/ui/Money';
import { DataTable, FilterBar, PageHeader, Pill, Select, type Column } from '../../components/ui';
import { ROLE_PERMISSION_GROUPS, toggleRolePermission } from '../../api/endpoints';
import { ROLE_PERMISSIONS, type Permission } from '../../rbac/permissions';
import type { Member } from '../../api/endpoints';
import { useTeamData } from './useTeamData';

type RangeKey = 'all' | '30d' | 'month' | 'quarter';

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function rangeFor(key: RangeKey) {
  const today = new Date();
  if (key === 'all') return {};
  if (key === '30d') {
    const from = new Date(today);
    from.setDate(from.getDate() - 29);
    return { from: isoDate(from), to: isoDate(today) };
  }
  if (key === 'month') {
    return { from: isoDate(new Date(today.getFullYear(), today.getMonth(), 1)), to: isoDate(today) };
  }
  const quarterMonth = Math.floor(today.getMonth() / 3) * 3;
  return { from: isoDate(new Date(today.getFullYear(), quarterMonth, 1)), to: isoDate(today) };
}

function membershipName(member: Member, labels: { account: string; agent: string }) {
  if (member.role === 'workspace_owner') return 'Owner';
  if (member.role === 'workspace_admin') return 'Admin';
  if (member.role === 'agent') return labels.agent;
  if (member.role === 'account_owner') return `${labels.account} owner`;
  return 'Member';
}

export default function TeamPage({ embedded = false }: { embedded?: boolean }) {
  const can = useCan();
  const { labels } = useCurrentSession();
  const [period, setPeriod] = useState<RangeKey>('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Member | 'new' | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'workspace_admin' | 'member'>('member');
  const [permissions, setPermissions] = useState<Permission[]>([...ROLE_PERMISSIONS.member]);
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [accessStatus, setAccessStatus] = useState<'active' | 'suspended'>('active');
  const [permissionSearch, setPermissionSearch] = useState('');
  const [saving, setSaving] = useState(false);

  const salesRange = useMemo(() => rangeFor(period), [period]);
  const { members, isLoading, isError, createMember, updateMember, setStatus: setMemberStatus } = useTeamData(salesRange);
  const canManage = can('team.manage');

  const openEditor = (member: Member | 'new') => {
    setEditing(member);
    setPermissionSearch('');
    setPassword('');
    setPasswordConfirm('');
    if (member === 'new') {
      setName('');
      setEmail('');
      setRole('member');
      setPermissions([...ROLE_PERMISSIONS.member]);
      setAccessStatus('active');
      return;
    }
    setName(member.name);
    setEmail(member.email);
    setRole(member.role === 'workspace_admin' ? 'workspace_admin' : 'member');
    setPermissions(member.permissions);
    setAccessStatus(member.status === 'suspended' ? 'suspended' : 'active');
  };

  const closeEditor = () => {
    if (!saving) setEditing(null);
  };

  const save = async () => {
    if (!email.trim() || !name.trim()) {
      toast('Name and email are required.');
      return;
    }
    if (password && password !== passwordConfirm) {
      toast('The password confirmation does not match.');
      return;
    }
    setSaving(true);
    try {
      if (editing === 'new') {
        if (!password) {
          toast('Set a password for the new member.');
          return;
        }
        await createMember({ email: email.trim(), fullName: name.trim(), password, role, permissions });
        toast('Member created.');
      } else if (editing) {
        await updateMember(editing.userId, {
          fullName: name.trim(),
          email: email.trim(),
          ...(editing.agentId || editing.accountId ? {} : { role }),
          permissions,
          ...(password ? { password, passwordConfirm } : {}),
        });
        if (accessStatus !== editing.status && editing.status !== 'removed') {
          await setMemberStatus(editing.userId, accessStatus);
        }
        toast(password ? 'Member updated and signed out everywhere.' : 'Member updated.');
      }
      setEditing(null);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not save this member.');
    } finally {
      setSaving(false);
    }
  };

  const filtered = members.filter((member) => {
    const term = search.trim().toLowerCase();
    return !term || `${member.name} ${member.email}`.toLowerCase().includes(term);
  });
  const permissionTerm = permissionSearch.trim().toLowerCase();
  const visibleGroups = ROLE_PERMISSION_GROUPS.map((group) => ({
    ...group,
    permissions: group.permissions.filter((permission) => !permissionTerm || permission.label.toLowerCase().includes(permissionTerm)),
  })).filter((group) => group.permissions.length);

  const columns: Column<Member>[] = [
    {
      key: 'member',
      header: 'Member',
      render: (member) => (
        <div className="person">
          <div className="avatar">{initials(member.name)}</div>
          <div>
            <div className="cname">{member.name}{member.isSelf ? <span className="sub inline"> (you)</span> : null}</div>
            <div className="cemail">{member.email}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Membership type',
      render: (member) => <span className="rolebadge">{membershipName(member, labels)}</span>,
    },
    {
      key: 'sales',
      header: 'Total sales (Customer paid)',
      align: 'right',
      render: (member) => member.totalCustomerPaid == null
        ? '—'
        : <span title="Customer payment volume, including checkout surcharge. Refunds and chargebacks reduce it."><Money amount={member.totalCustomerPaid} direction={member.totalCustomerPaid < 0 ? 'out' : 'in'} /></span>,
    },
    {
      key: 'access',
      header: 'Access',
      render: (member) => member.status === 'active'
        ? <Pill tone="ok">Active</Pill>
        : <Pill tone="muted">{member.status === 'removed' ? 'Removed' : 'Suspended'}</Pill>,
    },
    ...(canManage ? [{
      key: 'actions',
      header: 'Actions',
      hideHeader: true,
      align: 'right' as const,
      render: (member: Member) => member.isSelf || member.role === 'workspace_owner' ? null : (
        <button className="btn ghost small" onClick={() => openEditor(member)}>Edit member</button>
      ),
    }] : []),
  ];

  const editingMember = editing !== null && editing !== 'new' ? editing : null;
  const profileType = Boolean(editingMember?.agentId || editingMember?.accountId);
  const modalTitle = editing === 'new' ? 'Add member' : editing ? `Edit ${editing.name}` : '';

  return (
    <div className="team-page">
      {!embedded && <PageHeader
        title="People & access"
        subtitle="Manage each person’s access directly."
        actions={canManage ? <button className="btn" onClick={() => openEditor('new')}>Add member</button> : null}
      />}
      {embedded && canManage ? <div className="page-inline-actions"><button className="btn" onClick={() => openEditor('new')}>Add member</button></div> : null}

      <FilterBar>
        <input className="search-input" type="search" aria-label="Search members" placeholder="Search name or email" value={search} onChange={(event) => setSearch(event.target.value)} />
        <Select label="Sales period" value={period} onChange={(value) => setPeriod(value as RangeKey)}>
          <option value="all">All time</option>
          <option value="30d">Last 30 days</option>
          <option value="month">This month</option>
          <option value="quarter">This quarter</option>
        </Select>
        <span className="sub" title="Customer payment volume, including checkout surcharge. Refunds and chargebacks reduce it.">Customer payment volume, not member earnings.</span>
      </FilterBar>

      <DataTable
        columns={columns}
        rows={filtered}
        rowKey={(member) => member.userId}
        isLoading={isLoading}
        emptyTitle={isError ? "Couldn't load the team." : 'No members found.'}
        emptyHint={isError ? 'Try again in a moment.' : undefined}
      />

      <Modal open={editing !== null} onClose={closeEditor} title={modalTitle}
        subtitle={editing === 'new'
          ? 'Set the membership type and the access this person needs.'
          : 'Name and email are used for this person in every workspace they belong to.'}>
        <div className="field">
          <label htmlFor="member-name">Full name</label>
          <input id="member-name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} disabled={!canManage} />
        </div>
        <div className="field">
          <label htmlFor="member-email">Email</label>
          <input id="member-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={!canManage} />
          {editing !== 'new' ? <p className="sub">Changing this email affects every workspace.</p> : null}
        </div>
        <div className="field">
          <label htmlFor="member-type">Membership type</label>
          <select id="member-type" value={profileType && editingMember ? editingMember.role : role} disabled={profileType || editingMember?.role === 'workspace_owner'}
            onChange={(event) => {
              const next = event.target.value as 'workspace_admin' | 'member';
              setRole(next);
              setPermissions([...ROLE_PERMISSIONS[next]]);
            }}>
            {profileType && editingMember ? <option value={editingMember.role}>{membershipName(editingMember, labels)}</option> : null}
            <option value="member">Member</option>
            <option value="workspace_admin">Admin</option>
          </select>
          {profileType ? <p className="sub">This type is set by the person’s {editingMember?.agentId ? labels.agent : labels.account} profile.</p> : null}
        </div>
        <div className="field">
          <label htmlFor="permission-search">Permissions</label>
          <input id="permission-search" type="search" placeholder="Search permissions" value={permissionSearch} onChange={(event) => setPermissionSearch(event.target.value)} />
          <div className="check-list" aria-label="Direct permissions">
            {visibleGroups.map((group) => (
              <div key={group.label}>
                <div className="field-label">{group.label}</div>
                {group.permissions.map((permission) => (
                  <label className="check-row" key={permission.key}>
                    <input
                      type="checkbox"
                      checked={permissions.includes(permission.key)}
                      onChange={() => setPermissions((current) => toggleRolePermission(current, permission.key))}
                    />
                    <span>{permission.label}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
          {profileType ? <p className="sub">Select “View all workspace data” only when this {editingMember?.agentId ? labels.agent : labels.account} should see the full workspace.</p> : null}
        </div>
        {editing !== 'new' && editing?.role !== 'workspace_owner' ? (
          <div className="field">
            <label htmlFor="member-status">Sign-in access</label>
            <select id="member-status" value={accessStatus} onChange={(event) => setAccessStatus(event.target.value as 'active' | 'suspended')}>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </select>
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="member-password">{editing === 'new' ? 'Password' : 'Set a new password'}</label>
          <input id="member-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          <p className="sub">At least 12 characters, with upper case, lower case, and a number. Passwords cannot be viewed.</p>
        </div>
        <div className="field">
          <label htmlFor="member-password-confirm">Confirm password</label>
          <input id="member-password-confirm" type="password" autoComplete="new-password" value={passwordConfirm} onChange={(event) => setPasswordConfirm(event.target.value)} />
        </div>
        <div className="modal-actions">
          <button className="btn ghost" disabled={saving} onClick={closeEditor}>Cancel</button>
          <button className="btn" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>
        </div>
      </Modal>
    </div>
  );
}
