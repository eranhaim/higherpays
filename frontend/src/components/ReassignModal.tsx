import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Modal from './Modal';
import { HttpError } from '../api/http';
import { toast } from '../lib/toast';
import { DetailRow, Money, Select } from './ui';
import { useCurrentSession } from '../hooks/useCurrentSession';
import {
  accountsApi, linksApi, paymentsApi,
  type Account, type ReassignInput,
} from '../api/endpoints';

// The server answers a refused move with a code. Only the reversal is
// reachable from this dialog — the pickers cannot offer an illegal pair — but
// a reusable link can hold one refunded payment among many.
const REFUSALS: Record<string, string> = {
  payment_reversed: 'A refunded or charged-back sale cannot be moved.',
};

function refusal(err: unknown): string {
  const detail = err instanceof HttpError && typeof err.body === 'object' && err.body !== null
    && 'detail' in err.body && typeof err.body.detail === 'string' ? err.body.detail : null;
  return (detail && REFUSALS[detail]) || (err instanceof Error ? err.message : 'Could not reassign.');
}

/** What is being moved: a whole link with its payments, or one payment. */
export type ReassignKind = 'link' | 'payment';

interface ReassignModalProps {
  kind: ReassignKind;
  id: string;
  /** The reference shown in the title, so it is clear what is being moved. */
  reference: string;
  accountId: string;
  agentId: string | null;
  agentName: string | null;
  accounts: Account[];
  onClose: () => void;
  onSubmit: (input: ReassignInput) => Promise<void>;
}

const COPY: Record<ReassignKind, { title: string; subtitle: string }> = {
  link: {
    title: 'Reassign link',
    subtitle: 'Moves the link and every payment already taken on it. The splits are recalculated from the new owner’s terms.',
  },
  payment: {
    title: 'Reassign payment',
    subtitle: 'Moves this one payment. Its split is recalculated from the new owner’s terms; a reusable link and its other payments stay where they are.',
  },
};

/**
 * Changes who a link or a payment belongs to after the fact. The agent has to
 * be one assigned to the creator — the server refuses any other pair — so the
 * roster is read for whichever creator is picked.
 */
export default function ReassignModal({
  kind, id, reference, accountId, agentId, agentName, accounts, onClose, onSubmit,
}: ReassignModalProps) {
  const { activeWorkspaceId, labels } = useCurrentSession();
  const [nextAccountId, setNextAccountId] = useState(accountId);
  const [nextAgentId, setNextAgentId] = useState(agentId ?? '');
  const [isSaving, setIsSaving] = useState(false);

  const impact = useQuery({
    queryKey: ['reassign-impact', activeWorkspaceId, kind, id],
    queryFn: () => (kind === 'link' ? linksApi.impact(id) : paymentsApi.impact(id)),
  });
  const account = useQuery({
    queryKey: ['account', activeWorkspaceId, nextAccountId],
    queryFn: () => accountsApi.get(nextAccountId),
  });

  const roster = account.data?.agents ?? [];
  // The kept agent may not work the newly picked creator. Saying so beats a
  // server error, and beats silently clearing an attribution nobody asked to
  // change.
  const agentIsAssigned = nextAgentId === '' || roster.some((a) => a.agentId === nextAgentId);
  const unchanged = nextAccountId === accountId && nextAgentId === (agentId ?? '');

  const submit = async () => {
    setIsSaving(true);
    try {
      await onSubmit({ accountId: nextAccountId, agentId: nextAgentId || null });
    } catch (err) {
      toast(refusal(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`${COPY[kind].title} ${reference}`} subtitle={COPY[kind].subtitle}>
      <Select id="reassign-account" label={labels.account} value={nextAccountId} onChange={setNextAccountId}>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </Select>
      <Select
        id="reassign-agent" label={labels.agent} value={nextAgentId} onChange={setNextAgentId}
        hint={account.isLoading ? 'Loading…'
          : roster.length === 0 ? `No ${labels.agents.toLowerCase()} are assigned to this ${labels.account.toLowerCase()}.`
            : undefined}
      >
        <option value="">Unassigned</option>
        {roster.map((a) => <option key={a.agentId} value={a.agentId}>{a.name}</option>)}
      </Select>

      {!agentIsAssigned && !account.isLoading && (
        <div className="warnbar" role="alert">
          {agentName ?? 'That ' + labels.agent.toLowerCase()} does not work this {labels.account.toLowerCase()}.
          Pick one who does, or leave it unassigned.
        </div>
      )}

      <div className="callout">
        <DetailRow label="Payments moved">{impact.data ? impact.data.payments : '—'}</DetailRow>
        <DetailRow label="Amount">{impact.data ? <Money amount={impact.data.amount} /> : '—'}</DetailRow>
        {impact.data != null && impact.data.paidOut > 0 && (
          <p className="sub text-neg">
            {impact.data.paidOut} of them {impact.data.paidOut === 1 ? 'is' : 'are'} in a payout that has already been
            paid. Reassigning does not take that money back — the old payee stays overpaid.
          </p>
        )}
      </div>

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={submit} disabled={isSaving || unchanged || !agentIsAssigned}>
          {isSaving ? 'Reassigning…' : 'Reassign'}
        </button>
      </div>
    </Modal>
  );
}
