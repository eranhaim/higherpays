import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HttpError } from '../api/http';
import { toast } from '../lib/toast';
import { formatMoney } from '../lib/format';
import { DetailRow, Select } from './ui';
import { useCurrentSession } from '../hooks/useCurrentSession';
import {
  accountsApi, linksApi, paymentsApi,
  type Account, type ReassignInput,
} from '../api/endpoints';

/** What is being changed: a link's future attribution, or one payment. */
export type ReassignKind = 'link' | 'payment';

// The server answers a refused move with a code. Only the reversal is
// reachable from here — the pickers cannot offer an illegal pair — but a
// reusable link can hold one refunded payment among many.
const REFUSALS: Record<string, string> = {
  payment_reversed: 'A refunded or charged-back sale cannot be moved.',
};

function refusal(err: unknown): string {
  const detail = err instanceof HttpError && typeof err.body === 'object' && err.body !== null
    && 'detail' in err.body && typeof err.body.detail === 'string' ? err.body.detail : null;
  return (detail && REFUSALS[detail]) || (err instanceof Error ? err.message : 'Could not save.');
}

interface ReassignFieldsProps {
  kind: ReassignKind;
  id: string;
  accountId: string;
  agentId: string | null;
  accounts: Account[];
  onSave: (input: ReassignInput) => Promise<void>;
}

/**
 * The creator and agent rows of a detail dialog, as dropdowns. Changing one
 * says what it would change and offers to save it; nothing is written until
 * then. Link changes apply only to future payments.
 *
 * The agent has to be one assigned to the creator — the server refuses any
 * other pair — so the roster is read for whichever creator is picked.
 */
export default function ReassignFields({ kind, id, accountId, agentId, accounts, onSave }: ReassignFieldsProps) {
  const { activeWorkspaceId, labels } = useCurrentSession();
  const [nextAccountId, setNextAccountId] = useState(accountId);
  const [nextAgentId, setNextAgentId] = useState(agentId ?? '');
  const [isSaving, setIsSaving] = useState(false);

  const changed = nextAccountId !== accountId || nextAgentId !== (agentId ?? '');

  const account = useQuery({
    queryKey: ['account', activeWorkspaceId, nextAccountId],
    queryFn: () => accountsApi.get(nextAccountId),
  });
  // Only worth asking once something has actually been changed.
  const impact = useQuery({
    queryKey: ['reassign-impact', activeWorkspaceId, kind, id],
    queryFn: () => (kind === 'link' ? linksApi.impact(id) : paymentsApi.impact(id)),
    enabled: changed,
  });

  const roster = account.data?.agents ?? [];
  // The kept agent may not work the newly picked creator. Saying so beats a
  // server error, and beats silently clearing an attribution nobody asked to
  // change.
  const agentIsAssigned = nextAgentId === '' || roster.some((a) => a.agentId === nextAgentId);

  const reset = () => {
    setNextAccountId(accountId);
    setNextAgentId(agentId ?? '');
  };

  const save = async () => {
    setIsSaving(true);
    try {
      await onSave({ accountId: nextAccountId, agentId: nextAgentId || null });
    } catch (err) {
      toast(refusal(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <DetailRow label={labels.account}>
        <Select label={labels.account} hideLabel value={nextAccountId} onChange={setNextAccountId}>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </Select>
      </DetailRow>
      <DetailRow label={labels.agent}>
        <Select label={labels.agent} hideLabel value={nextAgentId} onChange={setNextAgentId}>
          <option value="">Unassigned</option>
          {roster.map((a) => <option key={a.agentId} value={a.agentId}>{a.name}</option>)}
        </Select>
      </DetailRow>

      {changed && (
        <div className="callout">
          {!agentIsAssigned ? (
            <p className="sub text-neg">
              That {labels.agent.toLowerCase()} does not work this {labels.account.toLowerCase()}.
              Pick one who does, or leave it unassigned.
            </p>
          ) : impact.data == null ? (
            <p className="sub">Checking what this would move…</p>
          ) : (
            <>
              <p className="sub">
                {kind === 'link'
                  ? impact.data.payments === 0
                    ? 'Nothing has been paid on this yet. Future payments will use the new attribution.'
                    : `${impact.data.payments} past payment${impact.data.payments === 1 ? '' : 's'} — ${formatMoney(impact.data.amount)} — stay unchanged. Only future payments use the new attribution.`
                  : impact.data.payments === 0
                    ? 'Nothing has been paid on this yet, so only the attribution changes.'
                    : `${impact.data.payments} payment${impact.data.payments === 1 ? '' : 's'} — ${formatMoney(impact.data.amount)} — move, and the split is recalculated from the new terms.`}
              </p>
              {kind === 'payment' && impact.data.paidOut > 0 && (
                <p className="sub text-neg">
                  {impact.data.paidOut} of them {impact.data.paidOut === 1 ? 'is' : 'are'} in a payout that has already
                  been paid. Saving does not take that money back — the old payee stays overpaid.
                </p>
              )}
            </>
          )}
          <div className="actions-right">
            <button className="btn ghost small" onClick={reset} disabled={isSaving}>Undo</button>
            <button className="btn small" onClick={save} disabled={isSaving || !agentIsAssigned}>
              {isSaving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
