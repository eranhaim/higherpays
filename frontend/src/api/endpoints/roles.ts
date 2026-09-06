import { api } from '../http';
import { workspacePath } from '../workspacePath';
import type { Permission } from '../../rbac/permissions';

export interface RoleDefinition {
  key: string;
  name: string;
  permissions: Permission[];
  isSystem: boolean;
  memberCount: number;
}

export const ROLE_PERMISSION_GROUPS: Array<{ label: string; permissions: Array<{ key: Permission; label: string }> }> = [
  {
    label: 'Workspace',
    permissions: [
      { key: 'data.view_all', label: 'View all creators and activity' },
      { key: 'settings.view', label: 'View workspace settings' },
      { key: 'settings.edit', label: 'Edit workspace settings' },
      { key: 'fees.view', label: 'View fees' },
      { key: 'roles.manage', label: 'Manage roles and permissions' },
    ],
  },
  {
    label: 'Payments',
    permissions: [
      { key: 'payments.view', label: 'View payments' },
      { key: 'payments.complete', label: 'Complete payment details' },
      { key: 'payments.export', label: 'Export payments' },
    ],
  },
  {
    label: 'Payment links',
    permissions: [
      { key: 'links.view', label: 'View payment links' },
      { key: 'links.create', label: 'Create payment links' },
    ],
  },
  {
    label: 'People',
    permissions: [
      { key: 'accounts.view', label: 'View creators' },
      { key: 'accounts.manage', label: 'Manage creators' },
      { key: 'agents.view', label: 'View agents' },
      { key: 'agents.manage', label: 'Manage agents' },
      { key: 'customers.view', label: 'View customers' },
      { key: 'customers.manage', label: 'Manage customers' },
      { key: 'customers.export', label: 'Export customers' },
      { key: 'team.view', label: 'View team members' },
      { key: 'team.manage', label: 'Manage team access' },
    ],
  },
  {
    label: 'Reports and payouts',
    permissions: [
      { key: 'analytics.view', label: 'View analytics and payouts' },
      { key: 'revenue.view', label: 'View revenue' },
      { key: 'revenue.manage', label: 'Manage revenue rates' },
    ],
  },
];

export const rolesApi = {
  async list(): Promise<{ roles: RoleDefinition[]; permissions: Permission[] }> {
    return api.get<{ roles: RoleDefinition[]; permissions: Permission[] }>(workspacePath('/roles'));
  },

  create: (input: { name: string; permissions: Permission[] }) =>
    api.post<RoleDefinition>(workspacePath('/roles'), input),

  update: (key: string, input: { name?: string; permissions?: Permission[] }) =>
    api.patch<RoleDefinition>(workspacePath(`/roles/${encodeURIComponent(key)}`), input),

  remove: (key: string) =>
    api.del<void>(workspacePath(`/roles/${encodeURIComponent(key)}`)),
};
