import { useState } from 'react';
import { type LinkLimits, type PlatformWorkspaceDetail, type WorkspaceSettings } from '../../api/endpoints';
import { feeBreakdown, type RateCard } from '../../business/feeBreakdown';
import { useCan } from '../../hooks/usePermission';
import { useUnsavedChanges } from '../../hooks/useUnsavedChanges';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { useRateCard } from '../../hooks/useRateCard';
import { toast } from '../../lib/toast';
import { CopyButton, ErrorCard, LoadingCard, Money } from '../../components/ui';
import { useGeneralSettings, usePlatformFees, type RateCardInput } from './useSettingsData';

export function WorkspacePane() {
  const can = useCan();
  const editable = can('settings.edit');
  const { activeWorkspaceId } = useCurrentSession();
  const { rateCard, isLoading: rateCardLoading, isError: rateCardError } = useRateCard();
  const { workspace, linkLimits, update, saveLinkLimits } = useGeneralSettings();
  const platformFees = usePlatformFees();

  if (rateCardLoading || linkLimits.isLoading || workspace.isLoading) return <LoadingCard />;
  if (rateCardError || linkLimits.isError || workspace.isError || !linkLimits.data || !workspace.data) return <ErrorCard />;

  return (
    <div className="stack">
      {/* Keyed by workspace: the cards seed form state from their props once,
          so switching workspace must give them a fresh mount. */}
      <WorkspaceCard key={`ws-${activeWorkspaceId}`} editable={editable} workspace={workspace.data}
        onSave={(input) => update.mutateAsync(input)} />
      {/* Also keyed by the rate version: the operator's rate card arrives after
          this pane renders, and a save writes a new version, so the form has to
          be re-seeded both times. */}
      <FeesCard key={`fees-${activeWorkspaceId}-${platformFees.detail.data?.feeHistory[0]?.effectiveFrom ?? 'none'}`}
        rateCard={rateCard} editable={platformFees.canEdit && platformFees.detail.isSuccess}
        detail={platformFees.detail.data ?? null} currencies={platformFees.currencies}
        onSave={(input) => platformFees.save.mutateAsync(input)} />
      <LinkLimitsCard key={`lim-${activeWorkspaceId}`} editable={editable} limits={linkLimits.data} rateCard={rateCard}
        onSave={(input) => saveLinkLimits.mutateAsync(input)} />
      <MantaPayCard key={`mp-${activeWorkspaceId}`} editable={editable} workspace={workspace.data}
        onSave={(merchantId) => update.mutateAsync({ merchantId })} />
    </div>
  );
}

function MantaPayCard({ editable, workspace, onSave }: {
  editable: boolean;
  workspace: WorkspaceSettings;
  onSave: (merchantId: string | null) => Promise<unknown>;
}) {
  const [merchantId, setMerchantId] = useState(workspace.merchantId ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const dirty = merchantId.trim() !== (workspace.merchantId ?? '');
  useUnsavedChanges('mantapay-settings', dirty);
  const webhookUrl = `${window.location.origin}/api/webhooks/payment/${workspace.webhookEndpointId}`;

  const save = async () => {
    setIsSaving(true);
    try { await onSave(merchantId.trim() || null); toast('Merchant ID saved.'); }
    catch (err) { toast(err instanceof Error ? err.message : 'Could not save the merchant ID.'); }
    finally { setIsSaving(false); }
  };

  return (
    <div className="card">
      <div className="sechead">MantaPay</div>
      <p className="sub">
        Your agency's own merchant account at MantaPay. The merchant ID goes on every payment link and
        is checked on every incoming notification, so a wrong value breaks both.
      </p>
      <div className="setrow">
        <div>
          <div className="k">{editable ? <label htmlFor="merchant-id">Merchant ID</label> : 'Merchant ID'}</div>
          <div className="d">The MID MantaPay gave you. Leave it empty to use the platform default.</div>
        </div>
        {editable
          ? <div className="controls"><input id="merchant-id" type="text" maxLength={64} value={merchantId} onChange={(e) => setMerchantId(e.target.value)} /></div>
          : <span className="mono-val">{workspace.merchantId ?? 'platform default'}</span>}
      </div>
      <div className="setrow">
        <div>
          <div className="k">Notification URL</div>
          <div className="d">Give this to MantaPay as the URL to notify when a payment happens.</div>
        </div>
        <div className="controls">
          <span className="mono-val">{webhookUrl}</span>
          <CopyButton value={webhookUrl} />
        </div>
      </div>
      {editable && (
        <div className="actions-right">
          <button className="btn" onClick={save} disabled={isSaving || !dirty}>{isSaving ? 'Saving…' : 'Save'}</button>
        </div>
      )}
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

  // Without settings.edit this pane is a read-only view of the workspace, so a
  // value is shown in place of the control rather than a control that is dead.
  const labelRow = (id: string, label: string, hint: string, value: string, set: (v: string) => void) => (
    <div className="setrow">
      <div>
        <div className="k">{editable ? <label htmlFor={id}>{label}</label> : label}</div>
        <div className="d">{hint}</div>
      </div>
      {editable
        ? <div className="controls"><input id={id} type="text" maxLength={40} value={value} onChange={(e) => set(e.target.value)} /></div>
        : <span className="mono-val">{value}</span>}
    </div>
  );

  return (
    <div className="card">
      <div className="sechead">Workspace</div>
      <div className="setrow">
        <div>
          <div className="k">{editable ? <label htmlFor="workspace-name">Workspace name</label> : 'Workspace name'}</div>
          <div className="d">Shown in the sidebar and on invites.</div>
        </div>
        {editable
          ? <div className="controls"><input id="workspace-name" type="text" value={name} onChange={(e) => setName(e.target.value)} /></div>
          : <span className="mono-val">{name}</span>}
      </div>
      <div className="setrow">
        <div>
          <div className="k">Currency</div>
          <div className="d">All amounts are in this currency. Multi-currency is not enabled.</div>
        </div>
        <span className="mono-val">{workspace.currency}</span>
      </div>
      <div className="sechead">Vocabulary</div>
      <p className="sub">What this agency calls its creators and agents. Used across the console; it changes no data.</p>
      {labelRow('label-account', `${workspace.labels.account}, singular`, 'e.g. Talent or Model', account, setAccount)}
      {labelRow('label-accounts', `${workspace.labels.accounts}, plural`, 'e.g. Talent or Models', accounts, setAccounts)}
      {labelRow('label-agent', `${workspace.labels.agent}, singular`, 'e.g. Chatter or Closer', agent, setAgent)}
      {labelRow('label-agents', `${workspace.labels.agents}, plural`, 'e.g. Chatters or Closers', agents, setAgents)}
      {editable && (
        <div className="actions-right">
          <button className="btn" onClick={save} disabled={isSaving || !dirty}>{isSaving ? 'Saving…' : 'Save'}</button>
        </div>
      )}
    </div>
  );
}

function FeesCard({ rateCard, editable, detail, currencies, onSave }: {
  rateCard: RateCard;
  /** Only a HigherPays platform admin may change what an agency is charged. */
  editable: boolean;
  /**
   * The operator's own read of the rate card, from the platform-admin-only
   * `/platform/workspaces/:id`. Null for agency staff, who get the read-only
   * rows below instead — the rate composition and the margin are not theirs
   * to edit.
   */
  detail: PlatformWorkspaceDetail | null;
  currencies: string[];
  onSave: (input: RateCardInput) => Promise<unknown>;
}) {
  const rate = detail?.feeHistory[0];
  const settlement = detail?.settlementFee;
  const saved = {
    pspRate: String(rate?.pspRatePct ?? 0),
    settlementPct: String(rate?.settlementPct ?? 0),
    margin: String(rate?.marginRatePct ?? 0),
    fixed: String(rate?.pspFixedFee ?? rateCard.fixed),
    checkout: String(rate?.checkoutFee ?? rateCard.checkoutFee),
    refund: String(settlement?.refundFee ?? rateCard.refundFee ?? 0),
    chargeback: String(settlement?.chargebackFee ?? rateCard.chargebackFee ?? 0),
    decline: String(settlement?.declineFee ?? rateCard.declineFee ?? 0),
    currency: detail?.currency ?? '',
  };
  const [pspRate, setPspRate] = useState(saved.pspRate);
  const [settlementPct, setSettlementPct] = useState(saved.settlementPct);
  const [margin, setMargin] = useState(saved.margin);
  const [fixed, setFixed] = useState(saved.fixed);
  const [checkout, setCheckout] = useState(saved.checkout);
  const [refund, setRefund] = useState(saved.refund);
  const [chargeback, setChargeback] = useState(saved.chargeback);
  const [decline, setDecline] = useState(saved.decline);
  const [currency, setCurrency] = useState(saved.currency);
  const [isSaving, setIsSaving] = useState(false);

  const percentages = [pspRate, settlementPct, margin].map(Number);
  const amounts = [fixed, checkout, refund, chargeback, decline].map(Number);
  const valid = amounts.every((v) => Number.isFinite(v) && v >= 0)
    && percentages.every((v) => Number.isFinite(v) && v >= 0 && v <= 100);
  const dirty = pspRate !== saved.pspRate || settlementPct !== saved.settlementPct || margin !== saved.margin
    || fixed !== saved.fixed || checkout !== saved.checkout || refund !== saved.refund
    || chargeback !== saved.chargeback || decline !== saved.decline || currency !== saved.currency;
  useUnsavedChanges('platform-fees', editable && dirty);
  // Editing the three percentages changes the blended rate before it is saved,
  // so the row has to follow the form rather than the stored value. Rounded
  // because adding three decimals in binary shows 13.149999999999999.
  const blended = editable && valid
    ? Number((Number(pspRate) + Number(settlementPct) + Number(margin)).toFixed(2))
    : rateCard.blended;

  // The reversal fees and the reserve are the agency's treasury: the server
  // sends them only to callers who see the whole workspace. Rendering a
  // withheld value as 0 would claim there is no chargeback fee, so the row is
  // dropped instead.
  const reserve = rateCard.reservePct === undefined ? null
    : rateCard.reservePct > 0 ? `${rateCard.reservePct}% · released after ${rateCard.reserveReleaseDays ?? 0} days` : 'none';

  const save = async () => {
    if (!valid) { toast('Percentages must be 0–100 and every fee an amount of 0 or more.'); return; }
    setIsSaving(true);
    try {
      await onSave({
        pspRatePct: Number(pspRate), settlementPct: Number(settlementPct), marginRatePct: Number(margin),
        fixedFee: Number(fixed), checkoutFee: Number(checkout),
        refundFee: Number(refund), chargebackFee: Number(chargeback), declineFee: Number(decline),
        currency,
      });
      toast('Fees saved.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the fees.');
    } finally {
      setIsSaving(false);
    }
  };

  const feeRow = (id: string, label: string, hint: string, value: string, set: (v: string) => void, amount: number) => (
    <div className="setrow">
      <div>
        <div className="k">{editable ? <label htmlFor={id}>{label}</label> : label}</div>
        <div className="d">{hint}</div>
      </div>
      {editable
        ? <div className="controls"><input id={id} type="number" min={0} step={0.01} value={value} onChange={(e) => set(e.target.value)} /></div>
        : <Money amount={amount} />}
    </div>
  );

  // The three parts of the blended rate. Only an operator sees them as rows of
  // their own; agency staff get the blended total and nothing underneath it.
  const pctRow = (id: string, label: string, hint: string, value: string, set: (v: string) => void) => (
    <div className="setrow">
      <div>
        <div className="k"><label htmlFor={id}>{label}</label></div>
        <div className="d">{hint}</div>
      </div>
      <div className="controls">
        <div className="pct-input">
          <input id={id} type="number" min={0} max={100} step={0.01} value={value} onChange={(e) => set(e.target.value)} />
          <span className="sub">%</span>
        </div>
      </div>
    </div>
  );

  return (
    <div className="card">
      <div className="sechead">Fees</div>
      <p className="sub">
        {editable
          ? 'What HigherPays charges this agency. A change applies to sales from now on; the history is kept.'
          : 'Set by HigherPays. Contact support to change them.'}
      </p>
      {editable && (
        <div className="setrow">
          <div>
            <div className="k"><label htmlFor="fee-currency">Workspace currency</label></div>
            <div className="d">
              {detail?.currencyChangeAllowed
                ? 'The unit every amount below is in. Changeable only until the agency has links or money history.'
                : 'Locked: this agency already has links or money history, so it cannot switch denomination.'}
            </div>
          </div>
          <div className="controls">
            <select id="fee-currency" value={currency} disabled={!detail?.currencyChangeAllowed}
              onChange={(e) => setCurrency(e.target.value)}>
              {currencies.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
        </div>
      )}
      <div className="setrow">
        <div><div className="k">Blended rate</div><div className="d">Percentage taken from every successful payment.</div></div>
        <span className="mono-val">{blended}%</span>
      </div>
      {editable && (
        <>
          {pctRow('fee-mdr', 'MDR rate', 'Taken by the provider from the price plus the checkout fee.', pspRate, setPspRate)}
          {pctRow('fee-settlement', 'Settlement fee', 'Applied after the MDR and the fixed fee.', settlementPct, setSettlementPct)}
          {pctRow('fee-margin', 'HigherPays margin', 'Our own cut, taken from the price alone.', margin, setMargin)}
        </>
      )}
      {feeRow('fee-fixed', 'Fixed fee', 'Charged on every transaction, on top of the blended rate.', fixed, setFixed, rateCard.fixed)}
      {editable && feeRow('fee-checkout', 'Checkout fee',
        'Added to the price and paid by the customer, so it never enters the agency’s gross.', checkout, setCheckout, rateCard.checkoutFee)}
      {(editable || rateCard.refundFee !== undefined) &&
        feeRow('fee-refund', 'Refund fee', 'Charged when a payment is refunded.', refund, setRefund, rateCard.refundFee ?? 0)}
      {(editable || rateCard.chargebackFee !== undefined) &&
        feeRow('fee-chargeback', 'Chargeback fee', 'Charged when a customer disputes a payment.', chargeback, setChargeback, rateCard.chargebackFee ?? 0)}
      {(editable || rateCard.declineFee !== undefined) &&
        feeRow('fee-decline', 'Decline fee', 'Charged on declined attempts.', decline, setDecline, rateCard.declineFee ?? 0)}
      {reserve !== null && (
        <div className="setrow">
          <div><div className="k">Rolling reserve</div><div className="d">Share of each payment held back and released later.</div></div>
          <span className="mono-val">{reserve}</span>
        </div>
      )}
      {editable && (
        <div className="actions-right">
          <button className="btn" onClick={save} disabled={isSaving || !dirty || !valid}>{isSaving ? 'Saving…' : 'Save fees'}</button>
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
  onSave: (input: {
    minLinkAmount: number | null;
    maxLinkAmount: number | null;
    linkTtlMinutes: number;
    reusableLinksEnabled: boolean;
  }) => Promise<unknown>;
}) {
  const { labels } = useCurrentSession();
  const savedMin = limits.minLinkAmount == null ? '' : String(limits.minLinkAmount);
  const savedMax = limits.maxLinkAmount == null ? '' : String(limits.maxLinkAmount);
  const savedHours = String(limits.linkTtlMinutes / 60);
  const savedReusable = limits.reusableLinksEnabled;
  const [min, setMin] = useState(savedMin);
  const [max, setMax] = useState(savedMax);
  const [hours, setHours] = useState(savedHours);
  const [reusableEnabled, setReusableEnabled] = useState(savedReusable);
  const [isSaving, setIsSaving] = useState(false);
  useUnsavedChanges('link-limits', min !== savedMin || max !== savedMax || hours !== savedHours || reusableEnabled !== savedReusable);

  const minAmount = parseFloat(min);
  const feeAtMin = minAmount > 0 ? effectivePct(minAmount, rateCard) : '—';

  const save = async () => {
    const minValue = min === '' ? null : Number(min);
    const maxValue = max === '' ? null : Number(max);
    if (minValue != null && minValue < limits.providerMinimum) { toast('Minimum cannot be below the provider floor.'); return; }
    if (minValue != null && maxValue != null && maxValue < minValue) { toast('Maximum must be greater than the minimum.'); return; }
    const ttlHours = Number(hours);
    if (!(ttlHours > 0)) { toast('An unpaid link has to expire after some number of hours.'); return; }
    setIsSaving(true);
    try {
      await onSave({
        minLinkAmount: minValue,
        maxLinkAmount: maxValue,
        linkTtlMinutes: Math.round(ttlHours * 60),
        reusableLinksEnabled: reusableEnabled,
      });
      toast('Link limits saved.');
    }
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
          <div className="k">{editable ? <label htmlFor="min-link-amount">Minimum amount</label> : 'Minimum amount'}</div>
          <div className="d">Links below this are blocked. Provider floor is <Money amount={limits.providerMinimum} />.</div>
        </div>
        {editable
          ? <div className="controls"><input id="min-link-amount" type="number" min={limits.providerMinimum} step={0.01} value={min} onChange={(e) => setMin(e.target.value)} /></div>
          : <span className="mono-val">{min === '' ? 'none' : min}</span>}
      </div>
      <div className="setrow">
        <div>
          <div className="k">{editable ? <label htmlFor="max-link-amount">Maximum amount</label> : 'Maximum amount'}</div>
          <div className="d">Optional ceiling. Guards against a mistyped amount.</div>
        </div>
        {editable
          ? <div className="controls"><input id="max-link-amount" type="number" min={0} step={0.01} value={max} onChange={(e) => setMax(e.target.value)} /></div>
          : <span className="mono-val">{max === '' ? 'none' : max}</span>}
      </div>
      <div className="setrow">
        <div>
          <div className="k">{editable ? <label htmlFor="link-ttl-hours">Single-use link expires after</label> : 'Single-use link expires after'}</div>
          <div className="d">An unpaid single-use link stops working after this. A reusable link never expires.</div>
        </div>
        {editable
          ? (
            <div className="controls">
              <input id="link-ttl-hours" type="number" min={1} step={1} value={hours} onChange={(e) => setHours(e.target.value)} />
              <span className="sub">hours</span>
            </div>
          )
          : <span className="mono-val">{hours} hours</span>}
      </div>
      <div className="setrow">
        <div>
          <div className="k">Reusable links</div>
          <div className="d">Allow links that stay open for multiple payments.</div>
        </div>
        {editable
          ? <label className="check-row"><input type="checkbox" checked={reusableEnabled} onChange={(e) => setReusableEnabled(e.target.checked)} /> Enabled</label>
          : <span className="mono-val">{reusableEnabled ? 'enabled' : 'disabled'}</span>}
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

