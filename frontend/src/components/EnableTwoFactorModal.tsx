import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { authApi } from '../api/endpoints';
import { HttpError } from '../api/http';
import Modal from './Modal';
import { CopyButton } from './ui';
import { toast } from '../lib/toast';
import { useTwoFactor } from '../hooks/useTwoFactor';

interface EnableTwoFactorModalProps {
  onClose: () => void;
}

function codeErrorMessage(error: unknown): string {
  if (error instanceof HttpError && error.status === 400) return 'That code was not accepted. Try again.';
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export default function EnableTwoFactorModal({ onClose }: EnableTwoFactorModalProps) {
  const { enable } = useTwoFactor();
  const [code, setCode] = useState('');
  const [showManualKey, setShowManualKey] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const setup = useQuery({
    queryKey: ['two-factor-setup'],
    queryFn: () => authApi.setupTwoFactor(),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

  const verify = async () => {
    if (!/^\d{6}$/.test(code)) {
      toast('Enter the 6-digit code from your app.');
      return;
    }
    try {
      const result = await enable.mutateAsync(code);
      setRecoveryCodes(result.recoveryCodes);
      toast('Two-factor authentication enabled.');
    } catch (error) {
      toast(codeErrorMessage(error));
    }
  };

  if (recoveryCodes) {
    return (
      <Modal open onClose={onClose} title="Save your recovery codes"
        subtitle="Store these one-time codes somewhere safe. They will not be shown again.">
        <RecoveryCodesView codes={recoveryCodes} />
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Done</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title="Enable two-factor authentication"
      subtitle="Scan the QR code with your authenticator app, then enter the 6-digit code it shows.">
      {setup.isError ? <p className="sub">Could not start setup. Close this and try again.</p>
        : setup.isLoading ? <p className="sub">Generating your setup key…</p>
          : (
            <>
              <div className="tfa-qr">
                <QRCodeSVG
                  value={setup.data?.otpauthUrl ?? ''}
                  size={192}
                  level="M"
                  marginSize={2}
                  bgColor="var(--text)"
                  fgColor="var(--bg)"
                  title="Scan to add HigherPays to your authenticator app"
                />
                <p className="sub">Scan this code with your authenticator app.</p>
                <button className="btn ghost small" type="button" onClick={() => setShowManualKey((visible) => !visible)}>
                  {showManualKey ? 'Hide setup key' : 'Use setup key instead'}
                </button>
              </div>
              {showManualKey && (
                <div className="field">
                  <label htmlFor="tfa-secret">Setup key</label>
                  <div className="field-row">
                    <input id="tfa-secret" type="text" readOnly value={setup.data?.secret ?? ''} onFocus={(e) => e.target.select()} />
                    <CopyButton value={setup.data?.secret ?? ''} />
                  </div>
                </div>
              )}
              <div className="field">
                <label htmlFor="tfa-enable-code">6-digit code from your app</label>
                <input id="tfa-enable-code" type="text" inputMode="numeric" autoComplete="one-time-code"
                  maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              </div>
            </>
          )}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Later</button>
        <button className="btn" disabled={!setup.data || enable.isPending} onClick={verify}>Verify &amp; enable</button>
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
