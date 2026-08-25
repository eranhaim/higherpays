import { api } from '../http';
import { workspacePath } from '../workspacePath';
import type { Permission } from '../../rbac/permissions';

export interface WorkspaceRole {
  name: string;
  permissions: Permission[];
  isSystem: boolean;
}

interface RawRole {
  name: string;
  permissions: Permission[];
  is_system: boolean;
}

function normalize(r: RawRole): WorkspaceRole {
  return { name: r.name, permissions: r.permissions, isSystem: r.is_system };
}

export const rolesApi = {
  async list(): Promise<WorkspaceRole[]> {
    const raw = await api.get<{ roles: RawRole[] }>(workspacePath('/roles'));
    return raw.roles.map(normalize);
  },

  async create(name: string, permissions: Permission[]): Promise<WorkspaceRole> {
    const raw = await api.post<RawRole>(workspacePath('/roles'), { name, permissions });
    return normalize(raw);
  },

  async setPermissions(name: string, permissions: Permission[]): Promise<WorkspaceRole> {
    const raw = await api.patch<RawRole>(workspacePath(`/roles/${name}`), { permissions });
    return normalize(raw);
  },

  /** Custom roles only, and only while nobody holds them. */
  remove: (name: string) => api.del<void>(workspacePath(`/roles/${name}`)),
};
