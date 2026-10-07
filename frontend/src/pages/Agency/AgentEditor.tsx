import { useState } from 'react';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import { Select } from '../../components/ui';
import { COUNTRIES } from '../../lib/countries';
import type { Account, Agent, Member, MemberStatus } from '../../api/endpoints';
import { AccessField } from './fields';
import { parsePct } from './percent';

export interface AgentFormValues {
  email: string;
  fullName: string;
  password?: string;
  country?: string;
  commissionPct: number;
}

export interface AgentFormSubmit {
  values: AgentFormValues;
  accountIds: string[];
  access: Exclude<MemberStatus, 'removed'>;
}

/**
 * One agent: who they are, what they earn on a sale, which creators they may
 * sell for, and whether they can sign in.
 */
export function AgentEditorModal({ member, agent, accounts, canEditCommission, canEditAccess, onClose, onSubmit }: {
  /** Absent while creating: there is no seat yet. */
  member?: Member;
  agent?: Agent;
  accounts: Account[];
  canEditCommission: boolean;
  canEditAccess: boolean;
  onClose: () => void;
  onSubmit: (input: AgentFormSubmit) => Promise<void>;
}) {
  const { labels } = useCurrentSession();
  const [fullName, setFullName] = useState(agent?.name ?? '');
  const [email, setEmail] = useState(agent?.email ?? '');
  const [password, setPassword] = useState('');
  const [country, setCountry] = useState(agent?.country ?? '');
  const [commissionText, setCommissionText] = useState(
    agent ? String(agent.commissionPct) : canEditCommission ? '' : '0',
  );
  const [assigned, setAssigned] = useState<string[]>(agent?.accounts.map((account) => account.id) ?? []);
  const [access, setAccess] = useState<Exclude<MemberStatus, 'removed'>>(member?.status === 'suspended' ? 'suspended' : 'active');
  const [isSaving, setIsSaving] = useState(false);
  const commission = canEditCommission ? parsePct(commissionText) : 0;
  const creating = !agent;

  const submit = async () => {
    if (!fullName.trim()) { toast('Name is required.'); return; }
    if (creating && !email.trim()) { toast('Email is required.'); return; }
    if (creating && password.length < 8) { toast('Password must be at least 8 characters.'); return; }
    if (Number.isNaN(commission)) { toast('Commission must be 0–100.'); return; }
    setIsSaving(true);
    try {
      await onSubmit({
        values: {
          email: email.trim(), fullName: fullName.trim(),
          ...(creating ? { password } : {}),
          country: country.trim() || undefined,
          commissionPct: commission,
        },
        accountIds: assigned,
        access,
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={creating ? `Add ${labels.agent.toLowerCase()}` : `Edit ${agent?.name}`}>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="form-row">
          <div className="field">
            <label htmlFor="agent-name">Full name</label>
            <input id="agent-name" type="text" value={fullName} onChange={(event) => setFullName(event.target.value)} />
          </div>
          <div className="field">
            {/* The email is how they sign in, so it is fixed after creation. */}
            <label htmlFor="agent-email">Email</label>
            <input id="agent-email" type="email" value={email} disabled={!creating} onChange={(event) => setEmail(event.target.value)} />
          </div>
        </div>
        {creating && (
          <div className="field">
            <label htmlFor="agent-password">Password</label>
            <input id="agent-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
            <p className="sub">At least 8 characters. Ignored if this email already has a login.</p>
          </div>
        )}
        <div className="form-row">
          <Select id="agent-country" label="Country" value={country} onChange={setCountry}>
            <option value="">Not set</option>
            {COUNTRIES.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
          </Select>
          {/* What someone earns is a revenue decision; without that permission
              the field is absent rather than shown greyed out. */}
          {canEditCommission && (
            <div className="field">
              <label htmlFor="agent-commission">Commission on each sale</label>
              <div className="pct-input">
                <input
                  id="agent-commission" type="number" min={0} max={100} value={commissionText}
                  aria-invalid={Number.isNaN(commission) || undefined}
                  onChange={(event) => setCommissionText(event.target.value)}
                />
                <span className="sub">%</span>
              </div>
              <p className="sub">Share of the distributable amount, after fees. Together with the {labels.account.toLowerCase()} share it must fit in 100%.</p>
            </div>
          )}
        </div>
        <div className="field" role="group" aria-labelledby="agent-accounts-label">
          <div className="field-label" id="agent-accounts-label">Assigned {labels.accounts.toLowerCase()}</div>
          <p className="sub">An assigned {labels.agent.toLowerCase()} can create links for these {labels.accounts.toLowerCase()}.</p>
          <div className="check-list">
            {accounts.length === 0 ? <span className="sub">No {labels.accounts.toLowerCase()} in this workspace yet.</span>
              : accounts.map((account) => (
                <label key={account.id} className="check-row">
                  <input
                    type="checkbox" checked={assigned.includes(account.id)}
                    onChange={(event) => setAssigned((prev) => event.target.checked
                      ? [...prev, account.id]
                      : prev.filter((id) => id !== account.id))}
                  />
                  <span>{account.name}</span>
                </label>
              ))}
          </div>
        </div>
        {!creating && canEditAccess && <AccessField value={access} onChange={setAccess} />}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={isSaving}>
            {isSaving ? 'Saving…' : creating ? `Add ${labels.agent.toLowerCase()}` : 'Save changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
