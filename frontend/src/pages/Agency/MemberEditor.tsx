import { useState } from 'react';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import { type Member, type MemberStatus, type RoleDefinition } from '../../api/endpoints';
import { ROLE_PERMISSIONS } from '../../rbac/permissions';
import { AccessField } from './fields';
import { PermissionsField } from './PermissionsField';
import { passwordProblem, type PermissionState } from './permissionState';
import { useGrantable } from './useGrantable';

export type PlainType = 'workspace_admin' | 'member';

export interface MemberEditorSubmit {
  fullName: string;
  email: string;
  /** Omitted for a profile-backed seat: the database type is not editable. */
  role?: PlainType;
  permissions: PermissionState;
  password?: string;
  passwordConfirm?: string;
  access: Exclude<MemberStatus, 'removed'>;
}

/**
 * One admin or plain member: who they are, what they may do, and whether they
 * can sign in. Making someone the agency owner or a HigherPays operator sits
 * at the bottom, apart from the fields, because both move this person out of
 * what the rest of the dialog describes.
 */
export function MemberEditorModal({
  member, roles, canTransferOwner, canSetPlatformAdmin, onClose, onSubmit, onTransferOwner, onSetPlatformAdmin,
}: {
  /** Absent while creating. */
  member?: Member;
  roles: RoleDefinition[];
  canTransferOwner: boolean;
  canSetPlatformAdmin: boolean;
  onClose: () => void;
  onSubmit: (input: MemberEditorSubmit) => Promise<void>;
  onTransferOwner: () => Promise<void>;
  onSetPlatformAdmin: (enabled: boolean) => Promise<void>;
}) {
  const creating = !member;
  const { grantsAnything, onlyGrantable } = useGrantable();
  // A seat behind a profile cannot change type: the profile's foreign key is
  // what ties the person to this workspace.
  const fixedRole = member && (member.agentId || member.accountId)
    ? { value: member.role, label: member.roleName }
    : null;
  const [name, setName] = useState(member?.name ?? '');
  const [email, setEmail] = useState(member?.email ?? '');
  const [role, setRole] = useState<PlainType>(member?.role === 'workspace_admin' ? 'workspace_admin' : 'member');
  const [permissions, setPermissions] = useState<PermissionState>(
    { roleKey: member?.customRoleKey ?? null, permissions: member?.permissions ?? onlyGrantable(ROLE_PERMISSIONS.member) },
  );
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [access, setAccess] = useState<Exclude<MemberStatus, 'removed'>>(member?.status === 'suspended' ? 'suspended' : 'active');
  const [isSaving, setIsSaving] = useState(false);
  const [isElevating, setIsElevating] = useState(false);

  const submit = async () => {
    if (!email.trim() || !name.trim()) { toast('Name and username are required.'); return; }
    if (creating && !password) { toast('Set a password for the new member.'); return; }
    if (password && passwordProblem(password)) { toast(passwordProblem(password) as string); return; }
    if (password && password !== passwordConfirm) { toast('The password confirmation does not match.'); return; }
    setIsSaving(true);
    try {
      await onSubmit({
        fullName: name.trim(),
        email: email.trim(),
        ...(fixedRole ? {} : { role }),
        permissions,
        ...(password ? { password, passwordConfirm } : {}),
        access,
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save this member.');
    } finally {
      setIsSaving(false);
    }
  };

  const elevate = async (run: () => Promise<void>) => {
    setIsElevating(true);
    try {
      await run();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change this.');
    } finally {
      setIsElevating(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={creating ? 'Add member' : `Edit ${member.name}`}>
      <div className="field">
        <label htmlFor="member-name">Full name</label>
        <input id="member-name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="member-email">Username</label>
        <input id="member-email" type="text" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} />
        {!creating && <p className="sub">The name and username belong to the login, so they change in every workspace this person belongs to.</p>}
      </div>
      <div className="field">
        <label htmlFor="member-type">Membership type</label>
        <select
          id="member-type" value={fixedRole ? fixedRole.value : role} disabled={fixedRole !== null}
          onChange={(event) => {
            const next = event.target.value as PlainType;
            setRole(next);
            setPermissions({ roleKey: null, permissions: onlyGrantable(ROLE_PERMISSIONS[next]) });
          }}
        >
          {fixedRole ? <option value={fixedRole.value}>{fixedRole.label}</option> : null}
          <option value="member">Member</option>
          <option value="workspace_admin" disabled={!grantsAnything}>Admin</option>
        </select>
        {fixedRole && <p className="sub">This type comes from the person's profile. Changing it would strand their record, so it is fixed.</p>}
      </div>
      <PermissionsField roles={roles} value={permissions} onChange={setPermissions} />
      {!creating && <AccessField value={access} onChange={setAccess} />}
      <div className="field">
        <label htmlFor="member-password">{creating ? 'Password' : 'Set a new password'}</label>
        <input id="member-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        <p className="sub">At least 12 characters, with upper case, lower case, and a number. Passwords cannot be viewed.</p>
      </div>
      <div className="field">
        <label htmlFor="member-password-confirm">Confirm password</label>
        <input id="member-password-confirm" type="password" autoComplete="new-password" value={passwordConfirm} onChange={(event) => setPasswordConfirm(event.target.value)} />
      </div>

      {!creating && (canTransferOwner || canSetPlatformAdmin) && (
        <>
          <div className="sechead">Elevate</div>
          {canTransferOwner && (
            <div className="settings-row">
              <div>
                <div className="cname">Make {member.name} the agency owner</div>
                <div className="sub">You become an admin. One person owns the agency, and the change is immediate.</div>
              </div>
              <button className="btn ghost small" disabled={isElevating} onClick={() => void elevate(onTransferOwner)}>Make owner</button>
            </div>
          )}
          {canSetPlatformAdmin && (
            <div className="settings-row">
              <div>
                <div className="cname">{member.isPlatformAdmin ? 'HigherPays operator' : 'Make a HigherPays operator'}</div>
                <div className="sub">An operator administers every agency on the platform, not just this one.</div>
              </div>
              <button
                className="btn ghost small" disabled={isElevating}
                onClick={() => void elevate(() => onSetPlatformAdmin(!member.isPlatformAdmin))}
              >
                {member.isPlatformAdmin ? 'Remove operator' : 'Make operator'}
              </button>
            </div>
          )}
        </>
      )}

      <div className="modal-actions">
        <button className="btn ghost" disabled={isSaving} onClick={onClose}>Cancel</button>
        <button className="btn" disabled={isSaving} onClick={() => void submit()}>
          {isSaving ? 'Saving…' : creating ? 'Add member' : 'Save changes'}
        </button>
      </div>
    </Modal>
  );
}
