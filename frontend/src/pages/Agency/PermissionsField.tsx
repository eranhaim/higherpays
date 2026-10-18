import { useState } from 'react';
import { Select } from '../../components/ui';
import { ROLE_PERMISSION_GROUPS, toggleRolePermission, type RoleDefinition } from '../../api/endpoints';
import type { PermissionState } from './permissionState';
import { useGrantable } from './useGrantable';

/**
 * Pick a custom role, or set permissions one by one. Ticking a box leaves the
 * role ("Custom permissions"). The server still decides what the caller may
 * grant; the boxes the caller cannot grant are shown but disabled so nobody
 * hunts for a control that will be refused.
 */
export function PermissionsField({ roles, value, onChange, hideRole }: {
  roles: RoleDefinition[];
  value: PermissionState;
  onChange: (next: PermissionState) => void;
  /** The role editor edits the role's own list, so it has no role to pick. */
  hideRole?: boolean;
}) {
  const { isGrantable } = useGrantable();
  const [search, setSearch] = useState('');

  const term = search.trim().toLowerCase();
  const groups = ROLE_PERMISSION_GROUPS.map((group) => ({
    ...group,
    permissions: group.permissions.filter((permission) => !term || permission.label.toLowerCase().includes(term)),
  })).filter((group) => group.permissions.length);

  return (
    <>
      {!hideRole && (
        <Select
          id="permission-role" label="Role" value={value.roleKey ?? ''}
          onChange={(key) => {
            const chosen = roles.find((item) => item.key === key);
            onChange(chosen ? { roleKey: chosen.key, permissions: chosen.permissions } : { roleKey: null, permissions: value.permissions });
          }}
          hint="A role is a saved set of permissions. Changing the role later changes everyone on it."
        >
          <option value="">Custom permissions</option>
          {roles.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}
        </Select>
      )}
      <div className="field">
        <label htmlFor="permission-search">Permissions</label>
        <input
          id="permission-search" type="search" placeholder="Search permissions"
          value={search} onChange={(event) => setSearch(event.target.value)}
        />
        <div className="check-list" role="group" aria-label="Permissions">
          {groups.map((group) => (
            <div key={group.label}>
              <div className="field-label">{group.label}</div>
              {group.permissions.map((permission) => {
                const isOn = value.permissions.includes(permission.key);
                return (
                  <label className="check-row" key={permission.key}>
                    <input
                      type="checkbox" checked={isOn} disabled={!isGrantable(permission.key)}
                      onChange={() => onChange({ roleKey: null, permissions: toggleRolePermission(value.permissions, permission.key) })}
                    />
                    <span>{permission.label}</span>
                  </label>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
