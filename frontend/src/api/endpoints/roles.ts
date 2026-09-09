import { api } from '../http';
import { workspacePath } from '../workspacePath';
import type { Permission } from '../../rbac/permissions';

export interface RoleDefinition {
  key: string;
  name: string;
  permissions: Permission[];
  isSystem: boolean;
  permissionsFixed: boolean;
  memberCount: number;
}

export const PERMISSION_DEPENDENCIES: Partial<Record<Permission, Permission[]>> = {
  'payments.complete': ['payments.view'],
  'payments.export': ['payments.view'],
  'links.create': ['links.view'],
  'accounts.manage': ['accounts.view'],
  'agents.manage': ['agents.view'],
  'customers.manage': ['customers.view'],
  'customers.export': ['customers.view'],
  'revenue.manage': ['revenue.view'],
  'team.manage': ['team.view'],
  'roles.manage': ['team.view', 'team.manage'],
  'settings.edit': ['settings.view'],
};

export function toggleRolePermission(current: Permission[], permission: Permission): Permission[] {
  if (!current.includes(permission)) {
    const next = new Set(current);
    const add = (key: Permission) => {
      next.add(key);
      for (const dependency of PERMISSION_DEPENDENCIES[key] ?? []) add(dependency);
    };
    add(permission);
    return [...next];
  }
  const removed = new Set<Permission>([permission]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, dependencies] of Object.entries(PERMISSION_DEPENDENCIES) as Array<[Permission, Permission[]]>) {
      if (!removed.has(key) && dependencies.some((dependency) => removed.has(dependency))) {
        removed.add(key);
        changed = true;
      }
    }
  }
  return current.filter((key) => !removed.has(key));
}

export const ROLE_PERMISSION_GROUPS: Array<{
  label: string;
  permissions: Array<{ key: Permission; label: string }>;
}> = [
  {
    label: 'Workspace',
    permissions: [
      { key: 'data.view_all', label: 'View all workspace data' },
      { key: 'settings.view', label: 'View settings' },
      { key: 'settings.edit', label: 'Edit settings' },
      { key: 'fees.view', label: 'View fees' },
      { key: 'roles.manage', label: 'Manage roles' },
    ],
  },
  {
    label: 'Payments and links',
    permissions: [
      { key: 'payments.view', label: 'View payments' },
      { key: 'payments.complete', label: 'Complete payments' },
      { key: 'payments.export', label: 'Export payments' },
      { key: 'links.view', label: 'View links' },
      { key: 'links.create', label: 'Create links' },
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
      { key: 'team.view', label: 'View team' },
      { key: 'team.manage', label: 'Manage team' },
    ],
  },
  {
    label: 'Reporting',
    permissions: [
      { key: 'analytics.view', label: 'View analytics' },
      { key: 'revenue.view', label: 'View revenue' },
      { key: 'revenue.manage', label: 'Manage revenue' },
    ],
  },
];

export const rolesApi = {
  list: () => api.get<{ roles: RoleDefinition[]; permissions: Permission[] }>(workspacePath('/roles')),
  create: (input: { name: string; permissions: Permission[] }) =>
    api.post<RoleDefinition>(workspacePath('/roles'), input),
  update: (key: string, input: { name?: string; permissions?: Permission[] }) =>
    api.patch<RoleDefinition>(workspacePath(`/roles/${encodeURIComponent(key)}`), input),
  remove: (key: string) => api.del<void>(workspacePath(`/roles/${encodeURIComponent(key)}`)),
};
