import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { authApi, type LinkLimits } from '../../api/endpoints';
import { HttpError } from '../../api/http';
import { feeBreakdown, type RateCard } from '../../business/feeBreakdown';
import { TZ_LIST, detectedTZ, tzTimeLabel } from '../../business/timezone';
import { useCan } from '../../hooks/usePermission';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { useRateCard } from '../../hooks/useRateCard';
import { usePreferencesStore } from '../../store/preferences';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import { CopyButton, ErrorCard, LoadingCard, Money } from '../../components/ui';
import { useGeneralSettings, useTwoFactor } from './useSettingsData';
import { SessionsCard } from './SessionsCard';

export function GeneralPane() {
  const can = useCan();
  const editable = can('settings.edit');
  const { activeWorkspaceId } = useCurrentSession();
  const { rateCard, isLoading: rateCardLoading, isError: rateCardError } = useRateCard();
  const { linkLimits, rename, saveLinkLimits } = useGeneralSettings();

  if (rateCardLoading || linkLimits.isLoading) return <LoadingCard />;
  if (rateCardError || linkLimits.isError || !linkLimits.data) return <ErrorCard />;

  return (
    <div className="stack">
      {/* Keyed by workspace: both cards seed form state from their props once,
          so switching workspace must give them a fresh mount. */}
      <WorkspaceCard key={activeWorkspaceId} editable={editable} onRename={(name) => rename.mutateAsync(name)} />
      <FeesCard rateCard={rateCard} />
      <LinkLimitsCard
        key={activeWorkspaceId}
        editable={editable}
        limits={linkLimits.data}
        rateCard={rateCard}
        onSave={(input) => saveLinkLimits.mutateAsync(input)}
      />
      <SecurityCard />
      <SessionsCard />
      <TimeZoneCard />
    </div>
  );
}

function WorkspaceCard({ editable, onRename }: {
  editable: boolean;
  onRename: (name: string) => Promise<unknown>;
}) {
  const { activeWorkspace, currency } = useCurrentSession();
  const [name, setName] = useState(activeWorkspace?.name ?? '');
  const [isSaving, setIsSaving] = useState(false);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) { toast('Workspace name is required.'); return; }
    setIsSaving(true);
    try {
      await onRename(trimmed);
      toast('Saved.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not rename the workspace.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="card">
      <div className="sechead">Workspace</div>
      <div className="setrow">
        <div>
          <div className="k"><label htmlFor="workspace-name">Workspace name</label></div>
          <div className="d">Shown next to the logo in the sidebar.</div>
        </div>
        <div className="controls">
          <input id="workspace-name" type="text" value={name} disabled={!editable}
            onChange={(e) => setName(e.target.value)} />
          {editable && (
            <button className="btn" onClick={save} disabled={isSaving}>
              {isSaving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>
      <div className="setrow">
        <div>
          <div className="k">Currency</div>
          <div className="d">All amounts are in this currency. Multi-currency is not enabled.</div>
        </div>
        <span className="mono-val">{currency}</span>
      </div>
    </div>
  );
}

function FeesCard({ rateCard }: { rateCard: RateCard }) {
  const reserve = rateCard.reservePct > 0
    ? `${rateCard.reservePct}% · released after ${rateCard.reserveReleaseDays} days`
    : 'none';

  return (
    <div className="card">
      <div className="sechead">Fees</div>
      <p className="sub">Set by HigherPays. Contact support to change them.</p>
      <div className="setrow">
        <div><div className="k">Blended rate</div><div className="d">Percentage taken from every successful payment.</div></div>
        <span className="mono-val">{rateCard.blended}%</span>
      </div>
      <div className="setrow">
        <div><div className="k">Fixed fee</div><div className="d">Charged on every transaction, on top of the blended rate.</div></div>
        <Money amount={rateCard.fixed} />
      </div>
      <div className="setrow">
        <div><div className="k">Refund fee</div><div className="d">Charged when a payment is refunded.</div></div>
        <Money amount={rateCard.refundFee} />
      </div>
      <div className="setrow">
        <div><div className="k">Chargeback fee</div><div className="d">Charged when a customer disputes a payment.</div></div>
        <Money amount={rateCard.chargebackFee} />
      </div>
      <div className="setrow">
        <div><div className="k">Decline fee</div><div className="d">Charged on declined attempts.</div></div>
        <Money amount={rateCard.declineFee} />
      </div>
      <div className="setrow">
        <div><div className="k">Rolling reserve</div><div className="d">Share of each payment held back and released later.</div></div>
        <span className="mono-val">{reserve}</span>
      </div>
    </div>
  );
}

function effectivePct(amount: number, rateCard: RateCard): string {
  return feeBreakdown(amount, rateCard).effectivePct.toFixed(1) + '%';
}

function LinkLimitsCard({ editable, limits, rateCard, onSave }: {
  editable: boolean;
  limits: LinkLimits;
  rateCard: RateCard;
  onSave: (input: { minLinkAmount: number | null; maxLinkAmount: number | null }) => Promise<unknown>;
}) {
  const [min, setMin] = useState(limits.minLinkAmount == null ? '' : String(limits.minLinkAmount));
  const [max, setMax] = useState(limits.maxLinkAmount == null ? '' : String(limits.maxLinkAmount));
  const [isSaving, setIsSaving] = useState(false);

  const minAmount = parseFloat(min);
  const feeAtMin = minAmount > 0 ? effectivePct(minAmount, rateCard) : '—';

  const save = async () => {
    const minValue = min === '' ? null : Number(min);
    const maxValue = max === '' ? null : Number(max);
    if (minValue != null && minValue < limits.providerMinimum) {
      toast('Minimum cannot be below the provider floor.');
      return;
    }
    if (minValue != null && maxValue != null && maxValue < minValue) {
      toast('Maximum must be greater than the minimum.');
      return;
    }
    setIsSaving(true);
    try {
      await onSave({ minLinkAmount: minValue, maxLinkAmount: maxValue });
      toast('Link limits saved.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save link limits.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="card">
      <div className="sechead">Payment link limits</div>
      <p className="sub">
        Guardrails for every link a agent creates. The fixed fee makes small tickets
        disproportionately expensive: a <Money amount={5} /> link costs {effectivePct(5, rateCard)} in
        fees, a <Money amount={20} /> link {effectivePct(20, rateCard)}, a <Money amount={100} /> link{' '}
        {effectivePct(100, rateCard)}. Enforced on the server, so the limits cannot be bypassed.
      </p>
      <div className="setrow">
        <div>
          <div className="k"><label htmlFor="min-link-amount">Minimum amount</label></div>
          <div className="d">Links below this are blocked. Provider floor is <Money amount={limits.providerMinimum} />.</div>
        </div>
        <div className="controls">
          <input id="min-link-amount" type="number" min={limits.providerMinimum} step={0.01} value={min}
            disabled={!editable} onChange={(e) => setMin(e.target.value)} />
        </div>
      </div>
      <div className="setrow">
        <div>
          <div className="k"><label htmlFor="max-link-amount">Maximum amount</label></div>
          <div className="d">Optional ceiling. Guards against a mistyped amount.</div>
        </div>
        <div className="controls">
          <input id="max-link-amount" type="number" min={0} step={0.01} value={max}
            disabled={!editable} onChange={(e) => setMax(e.target.value)} />
        </div>
      </div>
      <div className="setrow">
        <div>
          <div className="k">Effective fee at your minimum</div>
          <div className="d">Total platform fees on a link at this amount.</div>
        </div>
        <span className="mono-val">{feeAtMin}</span>
      </div>
      {editable && (
        <div className="setrow">
          <div>
            <div className="k">Save limits</div>
            <div className="d">Applies to all new links in this workspace.</div>
          </div>
          <button className="btn" onClick={save} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save limits'}
          </button>
        </div>
      )}
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
  const enabled = user?.twoFactorEnabled ?? false;

  return (
    <div className="card">
      <div className="sechead">Security</div>
      <div className="setrow">
        <div>
          <div className="k">Two-factor authentication</div>
          <div className="d">Require a 6-digit code from an authenticator app at login, in addition to your password.</div>
        </div>
        <button
          className={enabled ? 'btn ghost' : 'btn'}
          onClick={() => (enabled ? setDisableOpen(true) : setEnableOpen(true))}
        >
          {enabled ? 'Disable 2FA' : 'Enable 2FA'}
        </button>
      </div>
      {enableOpen && <EnableTwoFactorModal onClose={() => setEnableOpen(false)} />}
      {disableOpen && <DisableTwoFactorModal onClose={() => setDisableOpen(false)} />}
    </div>
  );
}

function EnableTwoFactorModal({ onClose }: { onClose: () => void }) {
  const { enable } = useTwoFactor();
  const [code, setCode] = useState('');

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
      await enable.mutateAsync(code);
      toast('Two-factor authentication enabled.');
      onClose();
    } catch (err) {
      toast(codeErrorMessage(err));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Enable two-factor authentication"
      subtitle="Add a new account in your authenticator app using this setup key or link, then enter the 6-digit code it shows."
    >
      {setup.isError ? (
        <p className="sub">Could not start the setup. Close this and try again.</p>
      ) : setup.isLoading ? (
        <p className="sub">Generating your setup key…</p>
      ) : (
        <>
          <div className="field">
            <label htmlFor="tfa-secret">Setup key</label>
            <div className="field-row">
              <input id="tfa-secret" type="text" readOnly value={setup.data?.secret ?? ''}
                onFocus={(e) => e.target.select()} />
              <CopyButton value={setup.data?.secret ?? ''} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="tfa-link">Setup link</label>
            <div className="field-row">
              <input id="tfa-link" type="text" readOnly value={setup.data?.otpauthUrl ?? ''}
                onFocus={(e) => e.target.select()} />
              <CopyButton value={setup.data?.otpauthUrl ?? ''} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="tfa-enable-code">6-digit code from your app</label>
            <input id="tfa-enable-code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
              value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
        </>
      )}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" disabled={!setup.data || enable.isPending} onClick={verify}>
          Verify &amp; enable
        </button>
      </div>
    </Modal>
  );
}

function DisableTwoFactorModal({ onClose }: { onClose: () => void }) {
  const { disable } = useTwoFactor();
  const [code, setCode] = useState('');

  const confirm = async () => {
    if (!/^\d{6}$/.test(code)) { toast('Enter the 6-digit code from your app.'); return; }
    try {
      await disable.mutateAsync(code);
      toast('Two-factor authentication disabled.');
      onClose();
    } catch (err) {
      toast(codeErrorMessage(err));
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Disable two-factor?"
      subtitle="Your account will then be protected by password only. Enter a current code to confirm."
    >
      <div className="field">
        <label htmlFor="tfa-disable-code">6-digit code from your app</label>
        <input id="tfa-disable-code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
          value={code} onChange={(e) => setCode(e.target.value)} />
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Keep it on</button>
        <button className="btn danger" disabled={disable.isPending} onClick={confirm}>Disable</button>
      </div>
    </Modal>
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
            <input type="checkbox" checked={tzMode === 'auto'}
              onChange={(e) => setTz(e.target.checked ? 'auto' : 'manual', activeZone)} />
            Automatic
          </label>
          <select aria-label="Time zone" disabled={tzMode === 'auto'} value={activeZone}
            onChange={(e) => setTz('manual', e.target.value)}>
            {TZ_LIST.map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </div>
      </div>
      <div className="setrow">
        <div>
          <div className="k">Active zone</div>
          <div className="d">Device detected: {detectedTZ()}</div>
        </div>
        <span className="mono-val">{activeZone} &middot; {tzTimeLabel(null, activeZone)}</span>
      </div>
    </div>
  );
}
