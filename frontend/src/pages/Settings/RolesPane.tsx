import { useState } from 'react';
import { HttpError } from '../../api/http';
import type { WorkspaceRole } from '../../api/endpoints';
import { ALL_PERMISSIONS, PERMISSION_LABELS, type Permission } from '../../rbac/permissions';
import { useCan } from '../../hooks/usePermission';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import { ErrorCard, LoadingCard, Pill } from '../../components/ui';
import { useRoles } from './useSettingsData';

function normalizeRoleName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

export function RolesPane() {
  const can = useCan();
  const editable = can('team.manage');
  const { roles, setPermissions, createRole } = useRoles();
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState('');

  if (roles.isLoading) return <LoadingCard />;
  if (roles.isError || !roles.data) return <ErrorCard />;

  const ordered = [...roles.data].sort((a, b) => Number(b.isSystem) - Number(a.isSystem));

  const toggle = async (role: WorkspaceRole, permission: Permission, granted: boolean) => {
    const permissions = granted
      ? [...role.permissions, permission]
      : role.permissions.filter((p) => p !== permission);
    try {
      await setPermissions.mutateAsync({ name: role.name, permissions });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update the role.');
    }
  };

  const closeAdd = () => { setAddOpen(false); setNewName(''); };

  const add = async () => {
    const name = normalizeRoleName(newName);
    if (!name) { toast('Role name is required.'); return; }
    try {
      await createRole.mutateAsync(name);
      toast(`Role "${name}" created.`);
      closeAdd();
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        toast('A role with that name already exists.');
      } else {
        toast(err instanceof Error ? err.message : 'Could not create the role.');
      }
    }
  };

  return (
    <>
      <div className="card">
        <div className="sechead">Role permissions</div>
        <p className="sub">
          What each role can see and do in this workspace. Built-in roles are fixed; add a custom role
          for a different set. You can only grant permissions you hold yourself.
        </p>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Permission</th>
                {ordered.map((r) => <th key={r.name}>{r.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {ALL_PERMISSIONS.map((permission) => (
                <tr key={permission}>
                  <td>{PERMISSION_LABELS[permission]}</td>
                  {ordered.map((role) => {
                    const granted = role.permissions.includes(permission);
                    return (
                      <td key={role.name}>
                        {editable && !role.isSystem ? (
                          <input type="checkbox" checked={granted} disabled={setPermissions.isPending}
                            onChange={(e) => toggle(role, permission, e.target.checked)} />
                        ) : granted ? <Pill tone="ok">Yes</Pill> : '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {editable && (
          <div className="actions-right">
            <button className="btn ghost" onClick={() => setAddOpen(true)}>Add custom role</button>
          </div>
        )}
      </div>

      <Modal open={addOpen} onClose={closeAdd}>
        <h3>New custom role</h3>
        <p className="sub">Starts with no permissions. Grant them in the table.</p>
        <div className="field">
          <label>Role name</label>
          <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} />
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={closeAdd}>Cancel</button>
          <button className="btn" disabled={createRole.isPending} onClick={add}>Create role</button>
        </div>
      </Modal>
    </>
  );
}
