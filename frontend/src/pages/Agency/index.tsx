import { useMemo, useState } from 'react';
import { useCan } from '../../hooks/usePermission';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { useUnsavedChanges } from '../../hooks/useUnsavedChanges';
import { useViewLayout, orderBy } from '../../hooks/useViewLayout';
import { HttpError } from '../../api/http';
import { initials } from '../../lib/format';
import { sortRows, type SortValues } from '../../lib/sortRows';
import { toast } from '../../lib/toast';
import Modal from '../../components/Modal';
import {
  DataTable, FilterBar, Money, PageHeader, Pill, Select, ViewPicker,
  type Column, type SortState,
} from '../../components/ui';
import type { Invite, Member } from '../../api/endpoints';
import { useAgencyData } from './useAgencyData';
import { CreateCreatorModal, EditCreatorModal } from './CreatorEditor';
import { AgentEditorModal } from './AgentEditor';
import { MemberEditorModal } from './MemberEditor';

/** What someone is in the agency. The profile decides it, not the role name. */
type MemberType = 'owner' | 'admin' | 'creator' | 'agent' | 'member';

/** Seat access and creator lifecycle are separate axes; the list reads both. */
type RowState = 'active' | 'paused' | 'suspended' | 'archived' | 'removed' | 'invited';

type Row =
  | { kind: 'member'; key: string; member: Member }
  | { kind: 'invite'; key: string; invite: Invite };

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

function memberType(member: Member): MemberType {
  if (member.role === 'workspace_owner') return 'owner';
  if (member.accountId) return 'creator';
  if (member.agentId) return 'agent';
  if (member.role === 'workspace_admin') return 'admin';
  return 'member';
}

function memberState(member: Member): RowState {
  if (member.accountStatus === 'archived') return 'archived';
  if (member.status === 'removed') return 'removed';
  if (member.status === 'suspended') return 'suspended';
  if (member.accountStatus === 'paused') return 'paused';
  return 'active';
}

/** A token past its expiry no longer resolves, so the invite is dead. */
function isExpired(invite: Invite): boolean {
  const ts = Date.parse(invite.expiresAt);
  return Number.isFinite(ts) && ts < Date.now();
}

const TYPE_ORDER: Record<MemberType, number> = { owner: 0, admin: 1, member: 2, creator: 3, agent: 4 };

const SORT_VALUES: SortValues<Member> = {
  name: (member) => member.name,
  type: (member) => TYPE_ORDER[memberType(member)],
  state: (member) => memberState(member),
  sales: (member) => member.totalCustomerPaid ?? null,
};

export default function AgencyPage() {
  const can = useCan();
  const { labels, role: currentRole, user } = useCurrentSession();
  const canManageMembers = can('team.manage');
  const canManageCreators = can('accounts.manage');
  const canManageAgents = can('agents.manage');
  const canEditPay = can('revenue.manage');
  // Handing the agency over is the owner's alone, and making someone a
  // HigherPays operator belongs to an existing operator. Both are refused by
  // the server; hiding them only keeps the controls out of everyone's way.
  const canTransferOwner = currentRole === 'workspace_owner';
  const isPlatformAdmin = Boolean(user?.isPlatformAdmin);

  const [period, setPeriod] = useState<RangeKey>('all');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<'' | MemberType | 'invited'>('');
  const [stateFilter, setStateFilter] = useState<'' | RowState | 'all'>('');
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' });
  const toggleSort = (key: string) =>
    setSort((current) => (current.key === key
      ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' }));

  const salesRange = useMemo(() => rangeFor(period), [period]);
  const data = useAgencyData(salesRange, canManageCreators || canManageAgents);
  const {
    members, pendingInvites, accounts, agents, isLoading, isError,
  } = data;

  const [creating, setCreating] = useState<'member' | 'creator' | 'agent' | null>(null);
  const [editing, setEditing] = useState<Member | null>(null);
  const [confirming, setConfirming] = useState<{ member: Member; status: 'paused' | 'archived' } | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [cancelling, setCancelling] = useState<Invite | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  useUnsavedChanges('agency-editor', creating !== null || editing !== null);

  const editingType = editing ? memberType(editing) : null;
  const editingAccount = editing?.accountId ? accounts.find((item) => item.id === editing.accountId) : undefined;
  const editingAgent = editing?.agentId ? agents.find((item) => item.id === editing.agentId) : undefined;

  const typeLabel = (type: MemberType) => {
    if (type === 'owner') return 'Owner';
    if (type === 'admin') return 'Admin';
    if (type === 'creator') return labels.account;
    if (type === 'agent') return labels.agent;
    return 'Member';
  };
  const badgeTone = (type: MemberType) => {
    if (type === 'owner') return 'owner';
    if (type === 'creator') return 'creator';
    if (type === 'agent') return 'agent';
    if (type === 'admin') return '';
    return 'plain';
  };

  /** Applies the seat change alongside whatever else the editor saved. */
  const applyAccess = async (member: Member, next: 'active' | 'suspended') => {
    if (next === member.status || member.status === 'removed') return;
    await data.setMemberStatus(member.userId, next);
  };

  const applyCreatorStatus = async (member: Member, status: 'active' | 'paused' | 'archived') => {
    if (!member.accountId) return;
    setIsBusy(true);
    try {
      await data.updateAccount(member.accountId, { status });
      setConfirming(null);
      const name = member.accountName ?? member.name;
      toast(status === 'active' ? `${name} activated.`
        : status === 'paused' ? `${name} paused. No new links.`
          : `${name} archived.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : `Could not update the ${labels.account.toLowerCase()}.`);
    } finally {
      setIsBusy(false);
    }
  };

  const confirmRemove = async (member: Member) => {
    setIsBusy(true);
    try {
      await data.removeMember(member.userId);
      setRemoving(null);
      toast(`${member.name} no longer has access.`);
    } catch (err) {
      toast(err instanceof HttpError && err.status === 409
        ? `${member.name} has a profile here. Suspend them instead so the history stays.`
        : err instanceof Error ? err.message : 'Could not remove the member.');
    } finally {
      setIsBusy(false);
    }
  };

  const confirmCancelInvite = async (invite: Invite) => {
    setIsBusy(true);
    try {
      await data.cancelInvite(invite.id);
      setCancelling(null);
      toast(isExpired(invite) ? 'Expired invite cleared.' : `Invite to ${invite.email} cancelled.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not cancel the invite.');
    } finally {
      setIsBusy(false);
    }
  };

  const query = search.trim().toLowerCase();
  const inviteRows: Row[] = pendingInvites
    .filter(() => typeFilter === '' || typeFilter === 'invited')
    .filter(() => stateFilter === '' || stateFilter === 'all' || stateFilter === 'invited')
    .filter((invite) => !query || invite.email.toLowerCase().includes(query))
    .map((invite) => ({ kind: 'invite', key: `invite:${invite.id}`, invite }));

  const matchingMembers = members
    .filter((member) => typeFilter === '' ? true : typeFilter !== 'invited' && memberType(member) === typeFilter)
    .filter((member) => {
      const state = memberState(member);
      if (stateFilter === 'all') return true;
      if (stateFilter !== '') return state === stateFilter;
      // The plain roster hides anyone who has stopped working here, but a
      // search is a hunt for someone in particular — finding nothing there
      // reads as data loss.
      return query !== '' || state === 'active' || state === 'paused';
    })
    .filter((member) => !query
      || `${member.name} ${member.email} ${member.accountName ?? ''}`.toLowerCase().includes(query));

  // The server returns the whole workspace at once, so the order is decided
  // here. Invites lead: a pending one is work waiting on somebody.
  const rows: Row[] = [
    ...inviteRows,
    ...sortRows(matchingMembers, sort, SORT_VALUES)
      .map((member): Row => ({ kind: 'member', key: member.userId, member })),
  ];

  const memberColumn: Column<Row> = {
    key: 'member',
    header: 'Member',
    sortKey: 'name',
    isRowHeader: true,
    render: (row) => row.kind === 'invite' ? (
      <div className="person">
        <div className="avatar" aria-hidden="true">—</div>
        <div>
          <div className="cname">{row.invite.email}</div>
          <div className="cemail">Has not accepted yet</div>
        </div>
      </div>
    ) : (
      <div className="person">
        <div className="avatar" aria-hidden="true">{initials(row.member.name)}</div>
        <div>
          <div className="cname">
            {row.member.name}
            {row.member.isSelf ? <span className="sub inline"> (you)</span> : null}
          </div>
          <div className="cemail">{row.member.email}</div>
        </div>
      </div>
    ),
  };

  const dataColumns: Column<Row>[] = [
    {
      key: 'type',
      header: 'Type',
      sortKey: 'type',
      render: (row) => {
        if (row.kind === 'invite') {
          return (
            <>
              <span className="rolebadge plain">Invited</span>
              <span className="sub inline"> · {row.invite.role === 'workspace_admin' ? 'Admin' : 'Member'}</span>
            </>
          );
        }
        const type = memberType(row.member);
        const tone = badgeTone(type);
        return (
          <>
            <span className={tone ? `rolebadge ${tone}` : 'rolebadge'}>{typeLabel(type)}</span>
            {row.member.accountName ? <span className="sub inline"> · {row.member.accountName}</span> : null}
          </>
        );
      },
      isFiltered: typeFilter !== '',
      filter: (
        <Select label="Type" hideLabel value={typeFilter} onChange={(value) => setTypeFilter(value as '' | MemberType | 'invited')}>
          <option value="">All types</option>
          <option value="owner">Owner</option>
          <option value="admin">Admin</option>
          <option value="member">Member</option>
          <option value="creator">{labels.accounts}</option>
          <option value="agent">{labels.agents}</option>
          <option value="invited">Invited</option>
        </Select>
      ),
    },
    // What someone is paid only reaches a caller the server trusts with
    // revenue figures, so an absent field means an absent column.
    ...(can('revenue.view') ? [{
      key: 'terms',
      header: 'Terms',
      render: (row: Row) => {
        if (row.kind === 'invite') return <span className="sub">—</span>;
        const { member } = row;
        if (member.accountId && member.revenueSplitPct !== undefined) {
          return member.payModel === 'salary'
            ? <>Salary <Money amount={member.salaryAmount ?? 0} direction="out" /></>
            : <span className="mono">{member.revenueSplitPct}% / {100 - member.revenueSplitPct}%</span>;
        }
        if (member.agentId && member.commissionPct !== undefined) {
          return <span className="mono">{member.commissionPct}% commission</span>;
        }
        return <span className="sub">—</span>;
      },
    }] : []),
    ...(can('data.view_all') ? [{
      key: 'assignments',
      header: 'Assignments',
      render: (row: Row) => {
        if (row.kind === 'invite') return <span className="sub">—</span>;
        const { member } = row;
        if (member.assignedCount == null) return <span className="sub">—</span>;
        const unit = member.accountId ? labels.agents.toLowerCase() : labels.accounts.toLowerCase();
        return <span className="mono">{member.assignedCount} {unit}</span>;
      },
    }] : []),
    {
      key: 'state',
      header: 'Access',
      sortKey: 'state',
      render: (row) => {
        if (row.kind === 'invite') {
          return isExpired(row.invite)
            ? <Pill tone="muted">Invite expired</Pill>
            : <Pill tone="warn">Invited</Pill>;
        }
        const state = memberState(row.member);
        if (state === 'archived') return <Pill tone="muted">Archived</Pill>;
        if (state === 'removed') return <Pill tone="muted">Removed</Pill>;
        if (state === 'suspended') return <Pill tone="muted">Suspended</Pill>;
        if (state === 'paused') return <Pill tone="warn">Paused</Pill>;
        return <Pill tone="ok">Active</Pill>;
      },
      isFiltered: stateFilter !== '',
      filter: (
        <Select label="Access" hideLabel value={stateFilter} onChange={(value) => setStateFilter(value as '' | RowState | 'all')}>
          <option value="">Currently working</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="suspended">Suspended</option>
          <option value="archived">Archived</option>
          <option value="removed">Removed</option>
          <option value="all">Everyone</option>
        </Select>
      ),
    },
    // Customer volume is a whole-workspace figure; a scoped seat is not sent it.
    ...(can('data.view_all') ? [{
      key: 'sales',
      header: 'Sales',
      sortKey: 'sales',
      render: (row: Row) => {
        if (row.kind === 'invite' || row.member.totalCustomerPaid == null) return <span className="sub">—</span>;
        const amount = row.member.totalCustomerPaid;
        return <Money amount={amount} direction={amount < 0 ? 'out' : 'in'} />;
      },
    }] : []),
  ];

  const columnsView = useViewLayout('agency.columns', dataColumns.map((column) => ({ key: column.key, label: column.header })));
  const columns: Column<Row>[] = [
    // The row header names the row and carries the type edge, so it is never
    // hidden or moved. Same for the actions cell: it is a control, not data.
    memberColumn,
    ...orderBy(dataColumns, columnsView.visibleKeys),
    ...(canManageMembers || canManageCreators ? [{
      key: 'actions',
      header: 'Actions',
      hideHeader: true,
      align: 'right' as const,
      render: (row: Row) => {
        if (row.kind === 'invite') {
          return (
            <div className="cell-actions">
              <button className="btn ghost small" onClick={() => setCancelling(row.invite)}>
                {isExpired(row.invite) ? 'Clear' : 'Cancel invite'}
              </button>
            </div>
          );
        }
        const { member } = row;
        const type = memberType(member);
        // The owner's seat and your own are refused by the server, and a
        // platform admin's seat is fixed in every agency.
        if (member.isSelf || type === 'owner' || member.isPlatformAdmin) return null;
        const canEditThis = type === 'creator' ? canManageCreators
          : type === 'agent' ? canManageAgents
            : canManageMembers;
        return (
          <div className="cell-actions">
            {canEditThis && <button className="btn ghost small" onClick={() => setEditing(member)}>Edit</button>}
            {type === 'creator' && canManageCreators && member.accountStatus !== 'active' && (
              <button className="btn ghost small" disabled={isBusy} onClick={() => void applyCreatorStatus(member, 'active')}>Activate</button>
            )}
            {type === 'creator' && canManageCreators && member.accountStatus === 'active' && (
              <button className="btn ghost small" onClick={() => setConfirming({ member, status: 'paused' })}>Pause</button>
            )}
            {type === 'creator' && canManageCreators && member.accountStatus !== 'archived' && (
              <button className="btn ghost small" onClick={() => setConfirming({ member, status: 'archived' })}>Archive</button>
            )}
            {/* Only a plain seat can be removed; a profile keeps its login so
                the ledger still has someone to attribute its history to. */}
            {!member.accountId && !member.agentId && member.status !== 'removed' && canManageMembers && (
              <button className="btn ghost small" onClick={() => setRemoving(member)}>Remove</button>
            )}
          </div>
        );
      },
    }] : []),
  ];

  const addActions = (
    <>
      {canManageCreators && <button className="btn ghost" onClick={() => setCreating('creator')}>Add {labels.account.toLowerCase()}</button>}
      {canManageAgents && <button className="btn ghost" onClick={() => setCreating('agent')}>Add {labels.agent.toLowerCase()}</button>}
      {canManageMembers && <button className="btn" onClick={() => setCreating('member')}>Add member</button>}
    </>
  );

  return (
    <div className="members-page">
      <PageHeader title="Agency" actions={addActions} />

      <FilterBar>
        <input
          className="search-input" type="search" aria-label="Search members"
          placeholder="Search name, email or creator"
          value={search} onChange={(event) => setSearch(event.target.value)}
        />
        <Select label="Sales period" hideLabel value={period} onChange={(value) => setPeriod(value as RangeKey)}>
          <option value="all">All time</option>
          <option value="30d">Last 30 days</option>
          <option value="month">This month</option>
          <option value="quarter">This quarter</option>
        </Select>
        <button className="btn ghost" onClick={() => { setSearch(''); setTypeFilter(''); setStateFilter(''); }}>Clear filters</button>
        <span className="sub">{rows.length} of {members.length + pendingInvites.length}</span>
        <ViewPicker label="Edit columns" sections={[{ view: columnsView }]} />
      </FilterBar>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.key}
        rowClassName={(row) => row.kind === 'invite'
          ? 'memberrow memberrow-invited'
          : `memberrow memberrow-${memberType(row.member)}`}
        sort={sort}
        onSort={toggleSort}
        isLoading={isLoading}
        mobileSummary={(row, { expanded, toggle }) => (
          <div className="mobile-data-card-summary">
            <div className="mobile-data-card-title">
              {row.kind === 'invite' ? row.invite.email : row.member.name}
            </div>
            <div className="mobile-data-card-status">
              {row.kind === 'invite'
                ? <Pill tone={isExpired(row.invite) ? 'muted' : 'warn'}>{isExpired(row.invite) ? 'Expired' : 'Invited'}</Pill>
                : <Pill tone={memberState(row.member) === 'active' ? 'ok' : memberState(row.member) === 'paused' ? 'warn' : 'muted'}>
                  {memberState(row.member) === 'active' ? 'Active' : memberState(row.member) === 'paused' ? 'Paused' : 'Inactive'}
                </Pill>}
            </div>
            <div className="mobile-data-card-creator">
              {row.kind === 'invite' ? 'Pending invite' : typeLabel(memberType(row.member))}
            </div>
            <button
              type="button" className="mobile-card-toggle"
              aria-label={expanded ? 'Collapse this row' : 'Expand this row'}
              aria-expanded={expanded} onClick={toggle}
            >
              <span className={`mobile-card-chevron${expanded ? ' open' : ''}`} aria-hidden="true" />
            </button>
          </div>
        )}
        emptyTitle={isError ? "Couldn't load the agency."
          : query ? 'Nobody matches that search.'
            : 'No members yet.'}
        emptyHint={isError ? 'Try again in a moment.'
          : query ? 'Clear the search to see everyone.'
            : canManageMembers ? 'Add the first one from the header.' : undefined}
      />

      {creating === 'member' && (
        <MemberEditorModal
          canTransferOwner={false}
          canSetPlatformAdmin={false}
          onClose={() => setCreating(null)}
          onSubmit={async (input) => {
            await data.createMember({
              email: input.email,
              password: input.password as string,
              fullName: input.fullName,
              role: input.role ?? 'member',
              permissions: input.permissions,
            });
            setCreating(null);
            toast('Member added.');
          }}
          onTransferOwner={async () => {}}
          onSetPlatformAdmin={async () => {}}
        />
      )}

      {creating === 'creator' && (
        <CreateCreatorModal
          agents={agents}
          onClose={() => setCreating(null)}
          onSubmit={async (input, agentIds) => {
            const created = await data.createAccount(input, agentIds);
            setCreating(null);
            toast(created.invited
              ? `${labels.account} added. Invite sent to ${input.email}.`
              : `${labels.account} added.`);
          }}
        />
      )}

      {creating === 'agent' && (
        <AgentEditorModal
          accounts={accounts}
          canEditCommission={canEditPay}
          canEditAccess={false}
          onClose={() => setCreating(null)}
          onSubmit={async ({ values, accountIds }) => {
            await data.createAgent(values, accountIds);
            setCreating(null);
            toast(`${labels.agent} added.`);
          }}
        />
      )}

      {editing && editingType === 'creator' && (
        <EditCreatorModal
          member={editing}
          account={editingAccount}
          agents={agents}
          canEditPay={canEditPay}
          canEditAccess={canManageMembers}
          onClose={() => setEditing(null)}
          onSubmit={async ({ account, agentIds, access }) => {
            const target = editing;
            await data.updateAccount(target.accountId as string, account);
            await data.setAssignedAgents(target.accountId as string, agentIds);
            if (canManageMembers) await applyAccess(target, access);
            setEditing(null);
            toast(`${labels.account} updated.`);
          }}
        />
      )}

      {/* The editor seeds every field from the agent record, so it is mounted
          only once that record is in hand. */}
      {editing && editingType === 'agent' && !editingAgent && (
        <Modal open onClose={() => setEditing(null)} title={`Edit ${editing.name}`}>
          <p className="sub">
            {isLoading ? 'Loading…' : `Couldn't load this ${labels.agent.toLowerCase()}.`}
          </p>
        </Modal>
      )}

      {editing && editingType === 'agent' && editingAgent && (
        <AgentEditorModal
          member={editing}
          agent={editingAgent}
          accounts={accounts}
          canEditCommission={canEditPay}
          canEditAccess={canManageMembers}
          onClose={() => setEditing(null)}
          onSubmit={async ({ values, accountIds, access }) => {
            const target = editing;
            await data.updateAgent(target.agentId as string, {
              fullName: values.fullName,
              ...(canEditPay ? { commissionPct: values.commissionPct } : {}),
              country: values.country,
            });
            await data.setAssignedAccounts(
              target.agentId as string,
              editingAgent.accounts.map((account) => account.id),
              accountIds,
            );
            if (canManageMembers) await applyAccess(target, access);
            setEditing(null);
            toast('Saved.');
          }}
        />
      )}

      {editing && (editingType === 'admin' || editingType === 'member') && (
        <MemberEditorModal
          member={editing}
          canTransferOwner={canTransferOwner && editing.status === 'active'}
          canSetPlatformAdmin={isPlatformAdmin}
          onClose={() => setEditing(null)}
          onSubmit={async (input) => {
            const target = editing;
            await data.updateMember(target.userId, {
              fullName: input.fullName,
              email: input.email,
              ...(input.role ? { role: input.role } : {}),
              permissions: input.permissions,
              ...(input.password ? { password: input.password, passwordConfirm: input.passwordConfirm } : {}),
            });
            await applyAccess(target, input.access);
            setEditing(null);
            toast(input.password ? 'Member updated and signed out everywhere.' : 'Member updated.');
          }}
          onTransferOwner={async () => {
            const target = editing;
            await data.transferOwner(target.userId);
            setEditing(null);
            toast(`Ownership transferred to ${target.name}.`);
          }}
          onSetPlatformAdmin={async (enabled) => {
            const target = editing;
            await data.setPlatformAdmin(target.userId, enabled);
            setEditing(null);
            toast(enabled ? `${target.name} is a HigherPays operator.` : `${target.name} is no longer an operator.`);
          }}
        />
      )}

      <Modal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={confirming
          ? `${confirming.status === 'paused' ? 'Pause' : 'Archive'} ${confirming.member.accountName ?? confirming.member.name}?`
          : ''}
        subtitle={confirming?.status === 'paused'
          ? 'No new payment links can be created. Links already out there keep working, and money already taken is untouched.'
          : `The ${labels.account.toLowerCase()} leaves every picker and list. Its history, payments and balances stay, and it can be activated again later.`}
      >
        {confirming && (
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setConfirming(null)}>Keep as is</button>
            <button
              className={confirming.status === 'archived' ? 'btn danger' : 'btn'} disabled={isBusy}
              onClick={() => void applyCreatorStatus(confirming.member, confirming.status)}
            >
              {isBusy ? 'Saving…' : confirming.status === 'paused' ? 'Pause' : 'Archive'}
            </button>
          </div>
        )}
      </Modal>

      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={removing ? `Remove ${removing.name}?` : ''}
        subtitle="Their access ends immediately and they are signed out everywhere."
      >
        {removing && (
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setRemoving(null)}>Keep</button>
            <button className="btn danger" disabled={isBusy} onClick={() => void confirmRemove(removing)}>Remove access</button>
          </div>
        )}
      </Modal>

      <Modal
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title={cancelling
          ? isExpired(cancelling) ? 'Clear this invite?' : `Cancel the invite to ${cancelling.email}?`
          : ''}
        subtitle={cancelling && isExpired(cancelling)
          ? 'It has already expired, so this just removes it from the list.'
          : 'The link stops working immediately. You can always send a new one.'}
      >
        {cancelling && (
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setCancelling(null)}>Keep it</button>
            <button className="btn danger" disabled={isBusy} onClick={() => void confirmCancelInvite(cancelling)}>
              {isBusy ? 'Cancelling…' : isExpired(cancelling) ? 'Clear invite' : 'Cancel invite'}
            </button>
          </div>
        )}
      </Modal>
    </div>
  );
}
