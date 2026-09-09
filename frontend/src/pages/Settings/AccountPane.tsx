import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { authApi } from '../../api/endpoints';
import { HttpError } from '../../api/http';
import { TZ_LIST, detectedTZ, tzTimeLabel } from '../../business/timezone';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { usePreferencesStore } from '../../store/preferences';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import { CopyButton } from '../../components/ui';
import { useTwoFactor } from './useSettingsData';
import { SessionsCard } from './SessionsCard';

/**
 * The signed-in person's own settings. Nothing here is gated on a workspace
 * permission: an agent protects their login the same way an admin does.
 */
export function AccountPane() {
  return (
    <div className="stack">
      <SecurityCard />
      <SessionsCard />
      <TimeZoneCard />
    </div>
  );
}

function codeErrorMessage(err: unknown): string {
  if (err instanceof HttpError && err.status === 400) return 'That code was not accepted. Try again.';
  return err instanceof Error ? err.message : 'Something went wrong.';
}

function SecurityCard() {
  const { user } = useCurrentSession();
  const [enableOpen, setEnableOpen] = useState(false);
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
          <button className={enabled ? 'btn ghost' : 'btn'} onClick={() => (enabled ? setDisableOpen(true) : setEnableOpen(true))}>
            {enabled ? 'Disable 2FA' : 'Enable 2FA'}
          </button>
        </div>
      </div>
      {user?.isPlatformAdmin && !enabled && (
        <div className="warnbar" role="status">Two-factor authentication is required before you can use platform administration.</div>
      )}
      {enableOpen && <EnableTwoFactorModal onClose={() => setEnableOpen(false)} />}
      {disableOpen && <DisableTwoFactorModal onClose={() => setDisableOpen(false)} />}
      {recoveryOpen && <RecoveryCodesModal onClose={() => setRecoveryOpen(false)} />}
    </div>
  );
}

function EnableTwoFactorModal({ onClose }: { onClose: () => void }) {
  const { enable } = useTwoFactor();
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  // Each setup call issues a new pending secret, so fetch once per modal open and never refetch.
  const setup = useQuery({
    queryKey: ['two-factor-setup'],
    queryFn: () => authApi.setupTwoFactor(),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  const verify = async () => {
    if (!/^\d{6}$/.test(code)) { toast('Enter the 6-digit code from your app.'); return; }
    try {
      const result = await enable.mutateAsync(code);
      setRecoveryCodes(result.recoveryCodes);
      toast('Two-factor authentication enabled.');
    }
    catch (err) { toast(codeErrorMessage(err)); }
  };

  if (recoveryCodes) {
    return (
      <Modal open onClose={onClose} title="Save your recovery codes"
        subtitle="Store these one-time codes somewhere safe. They will not be shown again.">
        <RecoveryCodesView codes={recoveryCodes} />
        <div className="modal-actions"><button className="btn" onClick={onClose}>Done</button></div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title="Enable two-factor authentication"
      subtitle="Add a new account in your authenticator app using this setup key or link, then enter the 6-digit code it shows.">
      {setup.isError ? <p className="sub">Could not start the setup. Close this and try again.</p>
        : setup.isLoading ? <p className="sub">Generating your setup key…</p>
        : (
          <>
            <div className="field">
              <label htmlFor="tfa-secret">Setup key</label>
              <div className="field-row">
                <input id="tfa-secret" type="text" readOnly value={setup.data?.secret ?? ''} onFocus={(e) => e.target.select()} />
                <CopyButton value={setup.data?.secret ?? ''} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="tfa-link">Setup link</label>
              <div className="field-row">
                <input id="tfa-link" type="text" readOnly value={setup.data?.otpauthUrl ?? ''} onFocus={(e) => e.target.select()} />
                <CopyButton value={setup.data?.otpauthUrl ?? ''} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="tfa-enable-code">6-digit code from your app</label>
              <input id="tfa-enable-code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
          </>
        )}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={!setup.data || enable.isPending} onClick={verify}>Verify &amp; enable</button>
      </div>
    </Modal>
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
