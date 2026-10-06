import { useState } from 'react';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import Modal from '../../components/Modal';
import { toast } from '../../lib/toast';
import { Select } from '../../components/ui';
import { COUNTRIES } from '../../lib/countries';
import {
  type Account, type CreateAccountInput, type Member, type MemberStatus,
  type PayModel, type UpdateAccountInput,
} from '../../api/endpoints';
import { useAccountDetail } from './useAgencyData';
import { AccessField } from './fields';
import { parsePct } from './percent';

/**
 * How a creator is paid. A share is a cut of what is left after fees on every
 * sale; a salary is a fixed amount owed once per payout period, and the
 * creator takes nothing from the sales themselves.
 */
function PayFields({ idPrefix, label, model, setModel, splitText, setSplitText, salaryText, setSalaryText }: {
  idPrefix: string;
  label: string;
  model: PayModel;
  setModel: (model: PayModel) => void;
  splitText: string;
  setSplitText: (value: string) => void;
  salaryText: string;
  setSalaryText: (value: string) => void;
}) {
  const split = parsePct(splitText);
  const salary = parseFloat(salaryText);
  return (
    <div className="field" role="radiogroup" aria-labelledby={`${idPrefix}-pay-label`}>
      <div className="field-label" id={`${idPrefix}-pay-label`}>{label} pay</div>
      <label className="check-row">
        <input type="radio" name={`${idPrefix}-pay`} checked={model === 'share'} onChange={() => setModel('share')} />
        <span>Share of distributable</span>
      </label>
      {model === 'share' && (
        <div className="pct-input">
          <input
            id={`${idPrefix}-split`} type="number" min={0} max={100} value={splitText}
            aria-label="Share of distributable" aria-invalid={Number.isNaN(split) || undefined}
            onChange={(event) => setSplitText(event.target.value)}
          />
          <span className="sub">%</span>
        </div>
      )}
      <label className="check-row">
        <input type="radio" name={`${idPrefix}-pay`} checked={model === 'salary'} onChange={() => setModel('salary')} />
        <span>Salary, per payout period</span>
      </label>
      {model === 'salary' && (
        <>
          <input
            id={`${idPrefix}-salary`} type="number" min={0} step={0.01} value={salaryText}
            aria-label="Salary per payout period" aria-invalid={Number.isNaN(salary) || undefined}
            onChange={(event) => setSalaryText(event.target.value)}
          />
          <p className="sub">They take nothing from each sale; the agency keeps that share and owes this once per period.</p>
        </>
      )}
    </div>
  );
}

function AgentPicker({ agents, assigned, setAssigned }: {
  agents: Array<{ id: string; name: string }>;
  assigned: string[];
  setAssigned: (next: string[]) => void;
}) {
  const { labels } = useCurrentSession();
  return (
    <div className="field" role="group" aria-labelledby="creator-agents-label">
      <div className="field-label" id="creator-agents-label">Assigned {labels.agents.toLowerCase()}</div>
      <p className="sub">An assigned {labels.agent.toLowerCase()} can create links for this {labels.account.toLowerCase()} and sees its payments.</p>
      <div className="check-list">
        {agents.length === 0 ? <span className="sub">No {labels.agents.toLowerCase()} in this workspace yet.</span>
          : agents.map((agent) => (
            <label key={agent.id} className="check-row">
              <input
                type="checkbox" checked={assigned.includes(agent.id)}
                onChange={(event) => setAssigned(event.target.checked
                  ? [...assigned, agent.id]
                  : assigned.filter((id) => id !== agent.id))}
              />
              <span>{agent.name}</span>
            </label>
          ))}
      </div>
    </div>
  );
}

/** A creator and the login of the person who owns it, in one form. */
export function CreateCreatorModal({ agents, onClose, onSubmit }: {
  agents: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSubmit: (input: CreateAccountInput, agentIds: string[]) => Promise<void>;
}) {
  const { labels } = useCurrentSession();
  const [name, setName] = useState('');
  const [country, setCountry] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [splitText, setSplitText] = useState('');
  const [payModel, setPayModel] = useState<PayModel>('share');
  const [salaryText, setSalaryText] = useState('0');
  const [assigned, setAssigned] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const split = parsePct(splitText);

  const submit = async () => {
    if (!name.trim()) { toast('Name is required.'); return; }
    if (!fullName.trim() || !email.trim()) { toast("The owner's name and email are required."); return; }
    if (payModel === 'share' && Number.isNaN(split)) { toast('Share must be 0–100.'); return; }
    if (payModel === 'salary' && !(parseFloat(salaryText) >= 0)) { toast('Salary must be an amount of 0 or more.'); return; }
    setIsSaving(true);
    try {
      await onSubmit({
        email: email.trim(), fullName: fullName.trim(), name: name.trim(),
        ...(country ? { country } : {}),
        payModel,
        revenueSplitPct: payModel === 'share' ? split : 0,
        salaryAmount: payModel === 'salary' ? parseFloat(salaryText) : 0,
      }, assigned);
    } catch (err) {
      toast(err instanceof Error ? err.message : `Could not add the ${labels.account.toLowerCase()}.`);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Add ${labels.account.toLowerCase()}`}>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="form-row">
          <div className="field">
            <label htmlFor="creator-name">{labels.account} name</label>
            <input id="creator-name" type="text" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <Select id="creator-country" label="Country" value={country} onChange={setCountry}>
            <option value="">Not set</option>
            {COUNTRIES.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
          </Select>
        </div>
        <div className="sechead">Who signs in</div>
        <p className="sub">They get an email and choose their own password. Nothing is sent if this address already has a login.</p>
        <div className="form-row">
          <div className="field">
            <label htmlFor="creator-owner-name">Full name</label>
            <input id="creator-owner-name" type="text" value={fullName} onChange={(event) => setFullName(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="creator-owner-email">Email</label>
            <input id="creator-owner-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </div>
        </div>
        <PayFields
          idPrefix="creator" label={labels.account} model={payModel} setModel={setPayModel}
          splitText={splitText} setSplitText={setSplitText} salaryText={salaryText} setSalaryText={setSalaryText}
        />
        <AgentPicker agents={agents} assigned={assigned} setAssigned={setAssigned} />
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn" disabled={isSaving}>
            {isSaving ? 'Adding…' : `Add ${labels.account.toLowerCase()}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export interface EditCreatorSubmit {
  account: UpdateAccountInput;
  agentIds: string[];
  access: Exclude<MemberStatus, 'removed'>;
}

/**
 * Everything about one creator in a single dialog: its details, what it is
 * paid, who works it, and whether the owner can sign in — who is assigned is
 * what decides what an agent sees, so it belongs with the rest.
 */
export function EditCreatorModal({ member, account, agents, canEditPay, canEditAccess, onClose, onSubmit }: {
  member: Member;
  account: Account | undefined;
  agents: Array<{ id: string; name: string }>;
  canEditPay: boolean;
  canEditAccess: boolean;
  onClose: () => void;
  onSubmit: (input: EditCreatorSubmit) => Promise<void>;
}) {
  const { labels } = useCurrentSession();
  const detail = useAccountDetail(member.accountId);

  return (
    <Modal open onClose={onClose} title={`Edit ${account?.name ?? member.accountName ?? member.name}`}>
      {detail.isError ? <p className="sub">Couldn't load this {labels.account.toLowerCase()}.</p>
        : !detail.data ? <p className="sub">Loading…</p>
          : (
            <EditCreatorForm
              member={member}
              account={detail.data}
              agents={agents}
              assigned={detail.data.agents?.map((item) => item.agentId) ?? []}
              canEditPay={canEditPay}
              canEditAccess={canEditAccess}
              onClose={onClose}
              onSubmit={onSubmit}
            />
          )}
    </Modal>
  );
}

// Mounted only once the roster is known, so every field seeds from a prop
// instead of syncing itself in an effect.
function EditCreatorForm({ member, account, agents, assigned: initialAssigned, canEditPay, canEditAccess, onClose, onSubmit }: {
  member: Member;
  account: Account;
  agents: Array<{ id: string; name: string }>;
  assigned: string[];
  canEditPay: boolean;
  canEditAccess: boolean;
  onClose: () => void;
  onSubmit: (input: EditCreatorSubmit) => Promise<void>;
}) {
  const { labels } = useCurrentSession();
  const [name, setName] = useState(account.name);
  const [country, setCountry] = useState(account.country ?? '');
  const [splitText, setSplitText] = useState(account.revenueSplitPct === undefined ? '' : String(account.revenueSplitPct));
  const [payModel, setPayModel] = useState<PayModel>(account.payModel ?? 'share');
  const [salaryText, setSalaryText] = useState(String(account.salaryAmount ?? 0));
  const [assigned, setAssigned] = useState(initialAssigned);
  const [access, setAccess] = useState<Exclude<MemberStatus, 'removed'>>(member.status === 'suspended' ? 'suspended' : 'active');
  const [isSaving, setIsSaving] = useState(false);
  const split = parsePct(splitText);
  const splitInvalid = canEditPay && payModel === 'share' && Number.isNaN(split);
  const salaryInvalid = canEditPay && payModel === 'salary' && !(parseFloat(salaryText) >= 0);

  const submit = async () => {
    if (!name.trim()) { toast('Name is required.'); return; }
    if (splitInvalid) { toast('Share must be 0–100.'); return; }
    if (salaryInvalid) { toast('Salary must be an amount of 0 or more.'); return; }
    setIsSaving(true);
    try {
      await onSubmit({
        account: {
          name: name.trim(),
          country: country.trim(),
          ...(canEditPay ? {
            payModel,
            revenueSplitPct: payModel === 'share' ? split : 0,
            salaryAmount: payModel === 'salary' ? parseFloat(salaryText) : 0,
          } : {}),
        },
        agentIds: assigned,
        access,
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="form-row">
        <div className="field">
          <label htmlFor="edit-creator-name">Name</label>
          <input id="edit-creator-name" type="text" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <Select id="edit-creator-country" label="Country" value={country} onChange={setCountry}>
          <option value="">Not set</option>
          {COUNTRIES.map((item) => <option key={item.code} value={item.code}>{item.name}</option>)}
        </Select>
      </div>
      {/* Renaming is accounts.manage; changing what it is paid is a revenue
          decision, so without that permission the field is absent, not dead. */}
      {canEditPay && (
        <>
          <PayFields
            idPrefix="edit-creator" label={labels.account} model={payModel} setModel={setPayModel}
            splitText={splitText} setSplitText={setSplitText} salaryText={salaryText} setSalaryText={setSalaryText}
          />
          {payModel === 'share' && (
            <p className="sub">
              {splitInvalid ? <span className="text-neg">0–100 only</span> : `Agency keeps ${100 - split}%. Changing the share only affects sales from now on.`}
            </p>
          )}
        </>
      )}
      <AgentPicker agents={agents} assigned={assigned} setAssigned={setAssigned} />
      {canEditAccess && <AccessField value={access} onChange={setAccess} />}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn" disabled={isSaving || splitInvalid || salaryInvalid}>
          {isSaving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
