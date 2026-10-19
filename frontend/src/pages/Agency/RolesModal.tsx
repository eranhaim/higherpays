import { useState } from 'react';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import type { RoleDefinition } from '../../api/endpoints';
import { PermissionsField } from './PermissionsField';
import type { PermissionState } from './permissionState';

/**
 * The workspace's custom roles: a name and a set of permissions that can be
 * given to any member. Changing a role changes everyone on it at once.
 */
export function RolesModal({ roles, onClose, onCreate, onUpdate, onDelete }: {
  roles: RoleDefinition[];
  onClose: () => void;
  onCreate: (input: { name: string; permissions: PermissionState['permissions'] }) => Promise<void>;
  onUpdate: (key: string, input: { name: string; permissions: PermissionState['permissions'] }) => Promise<void>;
  onDelete: (key: string) => Promise<void>;
}) {
  // 'new' is the unsaved role; otherwise the key of the role being edited.
  const [editingKey, setEditingKey] = useState<string | 'new' | null>(null);
  const editing = roles.find((role) => role.key === editingKey);
  const [name, setName] = useState('');
  const [permissions, setPermissions] = useState<PermissionState>({ roleKey: null, permissions: [] });
  const [isSaving, setIsSaving] = useState(false);

  const open = (key: string | 'new') => {
    const role = roles.find((item) => item.key === key);
    setEditingKey(key);
    setName(role?.name ?? '');
    setPermissions({ roleKey: null, permissions: role?.permissions ?? [] });
  };

  const run = async (action: () => Promise<void>, done: string) => {
    setIsSaving(true);
    try {
      await action();
      setEditingKey(null);
      toast(done);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save this role.');
    } finally {
      setIsSaving(false);
    }
  };

  const save = () => {
    if (!name.trim()) { toast('Give the role a name.'); return; }
    const input = { name: name.trim(), permissions: permissions.permissions };
    void run(
      () => (editingKey === 'new' ? onCreate(input) : onUpdate(editingKey as string, input)),
      editingKey === 'new' ? 'Role created.' : 'Role saved. Everyone on it was updated.',
    );
  };

  return (
    <Modal open onClose={onClose} title="Roles">
      {editingKey === null ? (
        <>
          <p className="sub">A role is a saved set of permissions. Pick one when you add or edit a member.</p>
          {roles.length === 0 ? <p className="sub">No roles yet.</p> : (
            <ul className="role-list">
              {roles.map((role) => (
                <li key={role.key} className="settings-row">
                  <div>
                    <div className="cname">{role.name}</div>
                    <div className="sub">{role.memberCount} {role.memberCount === 1 ? 'member' : 'members'}, {role.permissions.length} permissions</div>
                  </div>
                  <button type="button" className="btn ghost small" onClick={() => open(role.key)}>Edit</button>
                </li>
              ))}
            </ul>
          )}
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose}>Close</button>
            <button type="button" className="btn" onClick={() => open('new')}>New role</button>
          </div>
        </>
      ) : (
        <form onSubmit={(event) => { event.preventDefault(); save(); }}>
          <div className="field">
            <label htmlFor="role-name">Role name</label>
            <input id="role-name" type="text" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <PermissionsField roles={[]} value={permissions} onChange={setPermissions} hideRole />
          <div className="modal-actions">
            {editing && (
              <button
                type="button" className="btn ghost" disabled={isSaving || editing.memberCount > 0}
                title={editing.memberCount > 0 ? 'Move its members to another role first.' : undefined}
                onClick={() => void run(() => onDelete(editing.key), 'Role deleted.')}
              >
                Delete role
              </button>
            )}
            <button type="button" className="btn ghost" disabled={isSaving} onClick={() => setEditingKey(null)}>Back</button>
            <button type="submit" className="btn" disabled={isSaving}>{isSaving ? 'Saving…' : 'Save role'}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
