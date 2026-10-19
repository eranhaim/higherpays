import { useState } from 'react';
import { HttpError } from '../../api/http';
import { TZ_LIST, detectedTZ, tzTimeLabel } from '../../business/timezone';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { usePreferencesStore } from '../../store/preferences';
import Modal from '../../components/Modal';
import EnableTwoFactorModal, { ReEnrollTwoFactorModal } from '../../components/EnableTwoFactorModal';
import { CopyButton } from '../../components/ui';
import { toast } from '../../lib/toast';
import { useTwoFactor } from '../../hooks/useTwoFactor';
import { useAuthStore } from '../../store/auth';
import { authApi } from '../../api/endpoints/auth';
import { SessionsCard } from './SessionsCard';

/**
 * The signed-in person's own settings. Nothing here is gated on a workspace
 * permission: an agent protects their login the same way an admin does.
 */
export function AccountPane() {
  return (
    <div className="stack">
      <ProfileCard />
      <SecurityCard />
      <SessionsCard />
      <TimeZoneCard />
    </div>
  );
}

function ProfileCard() {
  const { user } = useCurrentSession();
  const [fullName, setFullName] = useState(user?.fullName ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [saving, setSaving] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);

  const saveProfile = async () => {
    const trimmedName = fullName.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName && !trimmedEmail) { toast('Nothing to save.'); return; }
    if (trimmedName === user?.fullName && trimmedEmail === user?.email) { toast('No changes to save.'); return; }
    setSaving(true);
    try {
      const updated = await authApi.updateProfile({
        ...(trimmedName !== user?.fullName ? { fullName: trimmedName } : {}),
        ...(trimmedEmail !== user?.email ? { email: trimmedEmail } : {}),
      });
      useAuthStore.getState().setUser(updated);
      toast('Profile updated.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to update profile.');
    } finally {
      setSaving(false);
    }
  };

  const changePassword = async () => {
    if (!currentPassword) { toast('Enter your current password.'); return; }
    if (!newPassword) { toast('Enter a new password.'); return; }
    if (newPassword.length < 8) { toast('New password must be at least 8 characters.'); return; }
    if (newPassword !== confirmPassword) { toast('Passwords do not match.'); return; }
    setChangingPassword(true);
    try {
      const updated = await authApi.updateProfile({ currentPassword, newPassword });
      useAuthStore.getState().setUser(updated);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast('Password changed.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to change password.');
    } finally {
      setChangingPassword(false);
    }
  };

  return (
    <div className="card">
      <div className="sechead">Profile</div>
      <div className="setrow">
        <div>
          <div className="k">Full name</div>
          <div className="d">Your display name across the platform.</div>
        </div>
        <div className="controls">
          <input type="text" aria-label="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
      </div>
      <div className="setrow">
        <div>
          <div className="k">Username</div>
          <div className="d">The email address you sign in with.</div>
        </div>
        <div className="controls">
          <input type="text" aria-label="Username" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
      </div>
      <div className="setrow">
        <div />
        <div className="controls">
          <button className="btn" disabled={saving} onClick={saveProfile}>Save</button>
        </div>
      </div>

      <div className="sechead">Change password</div>
      <div className="setrow">
        <div><div className="k">Current password</div></div>
        <div className="controls">
          <input type="password" aria-label="Current password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
        </div>
      </div>
      <div className="setrow">
        <div><div className="k">New password</div></div>
        <div className="controls">
          <input type="password" aria-label="New password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
        </div>
      </div>
      <div className="setrow">
        <div><div className="k">Confirm new password</div></div>
        <div className="controls">
          <input type="password" aria-label="Confirm new password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
        </div>
      </div>
      <div className="setrow">
        <div />
        <div className="controls">
          <button className="btn" disabled={changingPassword} onClick={changePassword}>Change password</button>
        </div>
      </div>
    </div>
  );
}

function codeErrorMessage(error: unknown): string {
  if (error instanceof HttpError && error.status === 400) return 'That code was not accepted. Try again.';
  return error instanceof Error ? error.message : 'Something went wrong.';
}

function SecurityCard() {
  const { user } = useCurrentSession();
  const [enableOpen, setEnableOpen] = useState(false);
  const [reEnrollOpen, setReEnrollOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const enabled = user?.twoFactorEnabled ?? false;

  return (
    <div className="card">
      <div className="sechead">Security</div>
      <div className="setrow">
        <div>
          <div className="k">Two-factor authentication</div>
          <div className="d">Require a 6-digit code from an authenticator app at login, in addition to your password.</div>
        </div>
        <div className="controls">
          {enabled && <button className="btn ghost" onClick={() => setRecoveryOpen(true)}>New recovery codes</button>}
          {enabled && <button className="btn ghost" onClick={() => setReEnrollOpen(true)}>Replace authenticator</button>}
          <button className={enabled ? 'btn ghost' : 'btn'} onClick={() => (enabled ? setDisableOpen(true) : setEnableOpen(true))}>
            {enabled ? 'Disable 2FA' : 'Enable 2FA'}
          </button>
        </div>
      </div>
      {user?.isPlatformAdmin && !enabled && (
        <div className="warnbar" role="status">Two-factor authentication is required before you can use platform administration.</div>
      )}
      {enableOpen && <EnableTwoFactorModal onClose={() => setEnableOpen(false)} />}
      {reEnrollOpen && <ReEnrollTwoFactorModal onClose={() => setReEnrollOpen(false)} />}
      {disableOpen && <DisableTwoFactorModal onClose={() => setDisableOpen(false)} />}
      {recoveryOpen && <RecoveryCodesModal onClose={() => setRecoveryOpen(false)} />}
    </div>
  );
}

function DisableTwoFactorModal({ onClose }: { onClose: () => void }) {
  const { disable } = useTwoFactor();
  const [code, setCode] = useState('');

  const confirm = async () => {
    if (!code.trim()) { toast('Enter a current authentication or recovery code.'); return; }
    try { await disable.mutateAsync(code); toast('Two-factor authentication disabled.'); onClose(); }
    catch (err) { toast(codeErrorMessage(err)); }
  };

  return (
    <Modal open onClose={onClose} title="Disable two-factor?" subtitle="Your account will then be protected by password only. Enter a current authentication or recovery code to confirm.">
      <div className="field">
        <label htmlFor="tfa-disable-code">Authentication or recovery code</label>
        <input id="tfa-disable-code" type="text" autoComplete="one-time-code" maxLength={21} value={code} onChange={(e) => setCode(e.target.value)} />
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Keep it on</button>
        <button className="btn danger" disabled={disable.isPending} onClick={confirm}>Disable</button>
      </div>
    </Modal>
  );
}

function RecoveryCodesModal({ onClose }: { onClose: () => void }) {
  const { regenerateRecoveryCodes } = useTwoFactor();
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const confirm = async () => {
    if (!code.trim()) { toast('Enter a current authentication or recovery code.'); return; }
    try {
      const result = await regenerateRecoveryCodes.mutateAsync(code);
      setRecoveryCodes(result.recoveryCodes);
    } catch (err) {
      toast(codeErrorMessage(err));
    }
  };

  return (
    <Modal open onClose={onClose} title="Generate new recovery codes"
      subtitle={recoveryCodes
        ? 'Store these one-time codes somewhere safe. Your previous recovery codes no longer work.'
        : 'Enter a current authentication or recovery code. This replaces all previous recovery codes.'}>
      {recoveryCodes ? <RecoveryCodesView codes={recoveryCodes} /> : (
        <div className="field">
          <label htmlFor="tfa-recovery-code">Authentication or recovery code</label>
          <input id="tfa-recovery-code" type="text" autoComplete="one-time-code" maxLength={21}
            value={code} onChange={(e) => setCode(e.target.value)} />
        </div>
      )}
      <div className="modal-actions">
        {!recoveryCodes && <button className="btn ghost" onClick={onClose}>Cancel</button>}
        <button className="btn" disabled={regenerateRecoveryCodes.isPending}
          onClick={recoveryCodes ? onClose : confirm}>{recoveryCodes ? 'Done' : 'Generate codes'}</button>
      </div>
    </Modal>
  );
}

function RecoveryCodesView({ codes }: { codes: string[] }) {
  const text = codes.join('\n');
  return (
    <div className="field">
      <label htmlFor="tfa-recovery-codes">One-time recovery codes</label>
      <div className="field-row">
        <textarea id="tfa-recovery-codes" readOnly rows={5} value={text} onFocus={(e) => e.target.select()} />
        <CopyButton value={text} />
      </div>
    </div>
  );
}

function TimeZoneCard() {
  const tzMode = usePreferencesStore((s) => s.tzMode);
  const tzManual = usePreferencesStore((s) => s.tzManual);
  const setTz = usePreferencesStore((s) => s.setTz);
  const activeZone = tzMode === 'manual' && tzManual ? tzManual : detectedTZ();

  return (
    <div className="card">
      <div className="sechead">Time &amp; region</div>
      <div className="setrow">
        <div>
          <div className="k">Time zone</div>
          <div className="d">All dates and time filters are shown in this zone. Choose automatic to match your device.</div>
        </div>
        <div className="controls">
          <label className="check">
            <input type="checkbox" checked={tzMode === 'auto'} onChange={(e) => setTz(e.target.checked ? 'auto' : 'manual', activeZone)} />
            Automatic
          </label>
          <select aria-label="Time zone" disabled={tzMode === 'auto'} value={activeZone} onChange={(e) => setTz('manual', e.target.value)}>
            {TZ_LIST.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </div>
      </div>
      <div className="setrow">
        <div><div className="k">Active zone</div><div className="d">Device detected: {detectedTZ()}</div></div>
        <span className="mono-val">{activeZone} &middot; {tzTimeLabel(null, activeZone)}</span>
      </div>
    </div>
  );
}
