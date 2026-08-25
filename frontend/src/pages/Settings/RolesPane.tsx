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
  // Edited permission sets per role, held until Save. Granting a role a
  // handful of permissions is one decision, so it is one write — the same
  // model the account splits and agent commission tables use.
  const [edits, setEdits] = useState<Record<string, Permission[]>>({});
  const [isSaving, setIsSaving] = useState(false);

  if (roles.isLoading) return <LoadingCard />;
  if (roles.isError || !roles.data) return <ErrorCard />;

  const ordered = [...roles.data].sort((a, b) => Number(b.isSystem) - Number(a.isSystem));
  const permissionsFor = (role: WorkspaceRole) => edits[role.name] ?? role.permissions;
  const dirtyRoles = Object.keys(edits);

  const toggle = (role: WorkspaceRole, permission: Permission, granted: boolean) => {
    const current = permissionsFor(role);
    setEdits((prev) => ({
      ...prev,
      [role.name]: granted ? [...current, permission] : current.filter((p) => p !== permission),
    }));
  };

  const savePermissions = async () => {
    const dirty = Object.entries(edits);
    if (dirty.length === 0) return;
    setIsSaving(true);
    // allSettled, not all: one rejected role must not strand the others.
    const results = await Promise.allSettled(
      dirty.map(([name, permissions]) => setPermissions.mutateAsync({ name, permissions })),
    );
    setIsSaving(false);

    const failed = dirty.filter((_, i) => results[i].status === 'rejected').map(([name]) => name);
    setEdits(Object.fromEntries(failed.map((name) => [name, edits[name]])));
    toast(failed.length === 0
      ? 'Role permissions saved.'
      : `Saved ${dirty.length - failed.length} of ${dirty.length}. Try the rest again.`);
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
                <th scope="col">Permission</th>
                {ordered.map((r) => <th key={r.name} scope="col">{r.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {ALL_PERMISSIONS.map((permission) => (
                <tr key={permission}>
                  <th scope="row">{PERMISSION_LABELS[permission]}</th>
                  {ordered.map((role) => {
                    const granted = permissionsFor(role).includes(permission);
                    return (
                      <td key={role.name}>
                        {editable && !role.isSystem ? (
                          <input
                            type="checkbox"
                            aria-label={`${role.name}: ${PERMISSION_LABELS[permission]}`}
                            checked={granted}
                            disabled={isSaving}
                            onChange={(e) => toggle(role, permission, e.target.checked)}
                          />
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
            <span className="grow" />
            {dirtyRoles.length > 0 && (
              <button className="btn ghost" onClick={() => setEdits({})} disabled={isSaving}>
                Discard changes
              </button>
            )}
            <button className="btn" onClick={savePermissions} disabled={isSaving || dirtyRoles.length === 0}>
              {isSaving ? 'Saving…' : 'Save permissions'}
            </button>
          </div>
        )}
      </div>

      <Modal
        open={addOpen}
        onClose={closeAdd}
        title="New custom role"
        subtitle="Starts with no permissions. Grant them in the table."
      >
        <div className="field">
          <label htmlFor="role-name">Role name</label>
          <input id="role-name" type="text" value={newName} onChange={(e) => setNewName(e.target.value)} />
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={closeAdd}>Cancel</button>
          <button className="btn" disabled={createRole.isPending} onClick={add}>Create role</button>
        </div>
      </Modal>
    </>
  );
}
