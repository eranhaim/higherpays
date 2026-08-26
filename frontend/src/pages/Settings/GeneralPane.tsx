import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { authApi, type LinkLimits, type WorkspaceSettings, type RevenueRule } from '../../api/endpoints';
import { HttpError } from '../../api/http';
import { feeBreakdown, type RateCard } from '../../business/feeBreakdown';
import { TZ_LIST, detectedTZ, tzTimeLabel } from '../../business/timezone';
import { useCan } from '../../hooks/usePermission';
import { useUnsavedChanges } from '../../hooks/useUnsavedChanges';
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
  const { workspace, linkLimits, revenue, update, saveLinkLimits, saveRevenue } = useGeneralSettings();

  if (rateCardLoading || linkLimits.isLoading || workspace.isLoading) return <LoadingCard />;
  if (rateCardError || linkLimits.isError || workspace.isError || !linkLimits.data || !workspace.data) return <ErrorCard />;

  return (
    <div className="stack">
      {/* Keyed by workspace: the cards seed form state from their props once,
          so switching workspace must give them a fresh mount. */}
      <WorkspaceCard key={`ws-${activeWorkspaceId}`} editable={editable} workspace={workspace.data}
        onSave={(input) => update.mutateAsync(input)} />
      {can('revenue.view') && revenue.data && (
        <RevenueDefaultsCard key={`rev-${activeWorkspaceId}`} editable={can('revenue.manage')} rule={revenue.data.rule}
          onSave={(input) => saveRevenue.mutateAsync(input)} />
      )}
      <FeesCard rateCard={rateCard} />
      <LinkLimitsCard key={`lim-${activeWorkspaceId}`} editable={editable} limits={linkLimits.data} rateCard={rateCard}
        onSave={(input) => saveLinkLimits.mutateAsync(input)} />
      <SecurityCard />
      <SessionsCard />
      <TimeZoneCard />
    </div>
  );
}

function WorkspaceCard({ editable, workspace, onSave }: {
  editable: boolean;
  workspace: WorkspaceSettings;
  onSave: (input: { name: string; accountLabel: string; accountLabelPlural: string; agentLabel: string; agentLabelPlural: string }) => Promise<unknown>;
}) {
  const [name, setName] = useState(workspace.name);
  const [account, setAccount] = useState(workspace.labels.account);
  const [accounts, setAccounts] = useState(workspace.labels.accounts);
  const [agent, setAgent] = useState(workspace.labels.agent);
  const [agents, setAgents] = useState(workspace.labels.agents);
  const [isSaving, setIsSaving] = useState(false);
  const dirty = name.trim() !== workspace.name || account !== workspace.labels.account || accounts !== workspace.labels.accounts
    || agent !== workspace.labels.agent || agents !== workspace.labels.agents;
  useUnsavedChanges('workspace-settings', dirty);

  const save = async () => {
    if (!name.trim()) { toast('Workspace name is required.'); return; }
    if (![account, accounts, agent, agents].every((v) => v.trim())) { toast('Every label needs a value.'); return; }
    setIsSaving(true);
    try {
      await onSave({ name: name.trim(), accountLabel: account.trim(), accountLabelPlural: accounts.trim(), agentLabel: agent.trim(), agentLabelPlural: agents.trim() });
      toast('Saved.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the workspace.');
    } finally {
      setIsSaving(false);
    }
  };

  const labelRow = (id: string, label: string, hint: string, value: string, set: (v: string) => void) => (
    <div className="setrow">
      <div>
        <div className="k"><label htmlFor={id}>{label}</label></div>
        <div className="d">{hint}</div>
      </div>
      <div className="controls">
        <input id={id} type="text" maxLength={40} value={value} disabled={!editable} onChange={(e) => set(e.target.value)} />
      </div>
    </div>
  );

  return (
    <div className="card">
      <div className="sechead">Workspace</div>
      <div className="setrow">
        <div>
          <div className="k"><label htmlFor="workspace-name">Workspace name</label></div>
          <div className="d">Shown in the sidebar and on invites.</div>
        </div>
        <div className="controls">
          <input id="workspace-name" type="text" value={name} disabled={!editable} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      <div className="setrow">
        <div>
          <div className="k">Currency</div>
          <div className="d">All amounts are in this currency. Multi-currency is not enabled.</div>
        </div>
        <span className="mono-val">{workspace.currency}</span>
      </div>
      <div className="sechead">Vocabulary</div>
      <p className="sub">What this agency calls its accounts and agents. Used across the console; it changes no data.</p>
      {labelRow('label-account', 'Account, singular', 'e.g. Creator, Talent, Model', account, setAccount)}
      {labelRow('label-accounts', 'Account, plural', 'e.g. Creators, Talent, Models', accounts, setAccounts)}
      {labelRow('label-agent', 'Agent, singular', 'e.g. Chatter, Closer', agent, setAgent)}
      {labelRow('label-agents', 'Agent, plural', 'e.g. Chatters, Closers', agents, setAgents)}
      {editable && (
        <div className="actions-right">
          <button className="btn" onClick={save} disabled={isSaving || !dirty}>{isSaving ? 'Saving…' : 'Save'}</button>
        </div>
      )}
    </div>
  );
}

function RevenueDefaultsCard({ editable, rule, onSave }: {
  editable: boolean;
  rule: RevenueRule;
  onSave: (input: { accountSplitPct: number; agentPct: number }) => Promise<unknown>;
}) {
  const { labels } = useCurrentSession();
  const [accountText, setAccountText] = useState(String(rule.accountSplitPct));
  const [agentText, setAgentText] = useState(String(rule.agentPct));
  const [isSaving, setIsSaving] = useState(false);
  const accountPct = parseFloat(accountText);
  const agentPct = parseFloat(agentText);
  const valid = accountPct >= 0 && accountPct <= 100 && agentPct >= 0 && agentPct <= 100 && agentPct <= 100 - accountPct;
  const dirty = accountText !== String(rule.accountSplitPct) || agentText !== String(rule.agentPct);
  useUnsavedChanges('revenue-defaults', dirty);

  const save = async () => {
    if (!valid) { toast('Shares must be 0–100 and fit together.'); return; }
    setIsSaving(true);
    try { await onSave({ accountSplitPct: accountPct, agentPct }); toast('Defaults saved.'); }
    catch (err) { toast(err instanceof Error ? err.message : 'Could not save the defaults.'); }
    finally { setIsSaving(false); }
  };

  return (
    <div className="card">
      <div className="sechead">Revenue defaults</div>
      <p className="sub">
        What a new {labels.account.toLowerCase()} and a new {labels.agent.toLowerCase()} start on. Each one's own rate is set on its page;
        changing these never re-prices anyone already set up.
      </p>
      <div className="setrow">
        <div>
          <div className="k"><label htmlFor="default-account-split">{labels.account} share</label></div>
          <div className="d">Of the distributable amount, after fees.</div>
        </div>
        <div className="pct-input">
          <input id="default-account-split" type="number" min={0} max={100} value={accountText} disabled={!editable} onChange={(e) => setAccountText(e.target.value)} />
          <span className="sub">%</span>
        </div>
      </div>
      <div className="setrow">
        <div>
          <div className="k"><label htmlFor="default-agent-pct">{labels.agent} commission</label></div>
          <div className="d">Comes out of the agency's share.</div>
        </div>
        <div className="pct-input">
          <input id="default-agent-pct" type="number" min={0} max={100} value={agentText} disabled={!editable} onChange={(e) => setAgentText(e.target.value)} />
          <span className="sub">%</span>
        </div>
      </div>
      <div className="setrow">
        <div><div className="k">Agency keeps</div><div className="d">The remainder after both shares.</div></div>
        <span className="mono-val">{valid ? `${Math.round((100 - accountPct - agentPct) * 100) / 100}%` : '—'}</span>
      </div>
      {editable && (
        <div className="actions-right">
          <button className="btn" onClick={save} disabled={isSaving || !dirty || !valid}>{isSaving ? 'Saving…' : 'Save defaults'}</button>
        </div>
      )}
    </div>
  );
}

function FeesCard({ rateCard }: { rateCard: RateCard }) {
  // The reversal fees and the reserve are the agency's treasury: the server
  // sends them only to callers who see the whole workspace. Rendering a
  // withheld value as 0 would claim there is no chargeback fee, so the row is
  // dropped instead.
  const reserve = rateCard.reservePct === undefined ? null
    : rateCard.reservePct > 0 ? `${rateCard.reservePct}% · released after ${rateCard.reserveReleaseDays ?? 0} days` : 'none';

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
      {rateCard.refundFee !== undefined && (
        <div className="setrow">
          <div><div className="k">Refund fee</div><div className="d">Charged when a payment is refunded.</div></div>
          <Money amount={rateCard.refundFee} />
        </div>
      )}
      {rateCard.chargebackFee !== undefined && (
        <div className="setrow">
          <div><div className="k">Chargeback fee</div><div className="d">Charged when a customer disputes a payment.</div></div>
          <Money amount={rateCard.chargebackFee} />
        </div>
      )}
      {rateCard.declineFee !== undefined && (
        <div className="setrow">
          <div><div className="k">Decline fee</div><div className="d">Charged on declined attempts.</div></div>
          <Money amount={rateCard.declineFee} />
        </div>
      )}
      {reserve !== null && (
        <div className="setrow">
          <div><div className="k">Rolling reserve</div><div className="d">Share of each payment held back and released later.</div></div>
          <span className="mono-val">{reserve}</span>
        </div>
      )}
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
  const { labels } = useCurrentSession();
  const savedMin = limits.minLinkAmount == null ? '' : String(limits.minLinkAmount);
  const savedMax = limits.maxLinkAmount == null ? '' : String(limits.maxLinkAmount);
  const [min, setMin] = useState(savedMin);
  const [max, setMax] = useState(savedMax);
  const [isSaving, setIsSaving] = useState(false);
  useUnsavedChanges('link-limits', min !== savedMin || max !== savedMax);

  const minAmount = parseFloat(min);
  const feeAtMin = minAmount > 0 ? effectivePct(minAmount, rateCard) : '—';

  const save = async () => {
    const minValue = min === '' ? null : Number(min);
    const maxValue = max === '' ? null : Number(max);
    if (minValue != null && minValue < limits.providerMinimum) { toast('Minimum cannot be below the provider floor.'); return; }
    if (minValue != null && maxValue != null && maxValue < minValue) { toast('Maximum must be greater than the minimum.'); return; }
    setIsSaving(true);
    try { await onSave({ minLinkAmount: minValue, maxLinkAmount: maxValue }); toast('Link limits saved.'); }
    catch (err) { toast(err instanceof Error ? err.message : 'Could not save link limits.'); }
    finally { setIsSaving(false); }
  };

  return (
    <div className="card">
      <div className="sechead">Payment link limits</div>
      <p className="sub">
        Guardrails for every link a {labels.agent.toLowerCase()} creates. The fixed fee makes small tickets
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
          <input id="min-link-amount" type="number" min={limits.providerMinimum} step={0.01} value={min} disabled={!editable} onChange={(e) => setMin(e.target.value)} />
        </div>
      </div>
      <div className="setrow">
        <div>
          <div className="k"><label htmlFor="max-link-amount">Maximum amount</label></div>
          <div className="d">Optional ceiling. Guards against a mistyped amount.</div>
        </div>
        <div className="controls">
          <input id="max-link-amount" type="number" min={0} step={0.01} value={max} disabled={!editable} onChange={(e) => setMax(e.target.value)} />
        </div>
      </div>
      <div className="setrow">
        <div><div className="k">Effective fee at your minimum</div><div className="d">Total platform fees on a link at this amount.</div></div>
        <span className="mono-val">{feeAtMin}</span>
      </div>
      {editable && (
        <div className="actions-right">
          <button className="btn" onClick={save} disabled={isSaving}>{isSaving ? 'Saving…' : 'Save limits'}</button>
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
        <button className={enabled ? 'btn ghost' : 'btn'} onClick={() => (enabled ? setDisableOpen(true) : setEnableOpen(true))}>
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
    try { await enable.mutateAsync(code); toast('Two-factor authentication enabled.'); onClose(); }
    catch (err) { toast(codeErrorMessage(err)); }
  };

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
    if (!/^\d{6}$/.test(code)) { toast('Enter the 6-digit code from your app.'); return; }
    try { await disable.mutateAsync(code); toast('Two-factor authentication disabled.'); onClose(); }
    catch (err) { toast(codeErrorMessage(err)); }
  };

  return (
    <Modal open onClose={onClose} title="Disable two-factor?" subtitle="Your account will then be protected by password only. Enter a current code to confirm.">
      <div className="field">
        <label htmlFor="tfa-disable-code">6-digit code from your app</label>
        <input id="tfa-disable-code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} />
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
