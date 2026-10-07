/**
 * Filling in a payment's details — who paid and what for — is one job reachable
 * from both Payments and Payment links, so the dialog and the data it needs
 * live here rather than on either page.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCurrentSession } from '../hooks/useCurrentSession';
import { categoriesApi, customersApi, paymentsApi, type CompletePaymentInput, type Payment } from '../api/endpoints';
import { formatMoney } from '../lib/format';
import { toast } from '../lib/toast';
import Modal from './Modal';
import { Select } from './ui';

/**
 * Completing a payment moves money into the ledger, so every list and figure
 * derived from it is stale afterwards.
 */
const DEPENDENT_QUERIES = [
  'payments', 'payments-summary', 'payment-filter-options',
  'links', 'links-summary', 'link',
  'customers', 'payouts-breakdown', 'analytics',
];

function useCompletePayment() {
  const { activeWorkspaceId } = useCurrentSession();
  const queryClient = useQueryClient();
  const enabled = Boolean(activeWorkspaceId);

  const categories = useQuery({
    queryKey: ['categories', activeWorkspaceId],
    queryFn: () => categoriesApi.list(),
    enabled,
    staleTime: 5 * 60_000,
  });
  const customers = useQuery({
    queryKey: ['customers', activeWorkspaceId, 'picker'],
    queryFn: () => customersApi.list({ limit: 200 }),
    enabled,
  });
  const complete = useMutation({
    mutationFn: ({ id, input }: { id: string; input: CompletePaymentInput }) => paymentsApi.complete(id, input),
    onSuccess: () => {
      for (const key of DEPENDENT_QUERIES) {
        queryClient.invalidateQueries({ queryKey: [key, activeWorkspaceId] });
      }
    },
  });

  return {
    categories: categories.data ?? [],
    customers: customers.data ?? [],
    areCustomersLoading: customers.isLoading,
    hasCustomersError: customers.isError,
    retryCustomers: () => { void customers.refetch(); },
    complete: (id: string, input: CompletePaymentInput) => complete.mutateAsync({ id, input }),
  };
}

interface CompletePaymentModalProps {
  payment: Payment;
  onClose: () => void;
  onCompleted: () => void;
}

/** The agent says who paid and what for. An existing customer or a new one. */
export default function CompletePaymentModal({ payment, onClose, onCompleted }: CompletePaymentModalProps) {
  const {
    categories, customers, areCustomersLoading, hasCustomersError, retryCustomers, complete,
  } = useCompletePayment();
  const [categoryId, setCategoryId] = useState('');
  const [customerId, setCustomerId] = useState(payment.customerId ?? '');
  const [name, setName] = useState('');
  const [telegramName, setTelegramName] = useState('');
  const [email, setEmail] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const typingNew = customerId === '';
  // The list arrives after the first render, so the default cannot be set from
  // it in useState. Falling back here keeps the first category preselected
  // without an effect that would fight the user's own choice.
  const category = categoryId || categories[0]?.id || '';

  const submit = async () => {
    if (areCustomersLoading || hasCustomersError) { toast('Wait for the customer list to load.'); return; }
    if (!category) { toast('Pick a category.'); return; }
    if (typingNew && !name.trim()) { toast('Enter the customer name.'); return; }
    setIsSaving(true);
    try {
      await complete(payment.id, {
        categoryId: category,
        ...(typingNew
          ? {
            customer: {
              name: name.trim(),
              ...(telegramName.trim() ? { telegramName: telegramName.trim() } : {}),
              ...(email.trim() ? { email: email.trim() } : {}),
            },
          }
          : { customerId }),
      });
      onCompleted();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the details.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Fill payment details" subtitle={`${formatMoney(payment.amount, payment.currency)} · ${payment.account}`}>
      {hasCustomersError && (
        <div className="warnbar" role="alert">
          Existing customers could not be loaded. Retry before creating a new one.{' '}
          <button className="btn ghost small" onClick={retryCustomers}>Try again</button>
        </div>
      )}
      <Select id="complete-customer" label="Customer" value={customerId} onChange={setCustomerId}
        disabled={areCustomersLoading || hasCustomersError}>
        <option value="">{areCustomersLoading ? 'Loading customers…' : hasCustomersError ? 'Customers unavailable' : 'New customer…'}</option>
        {customers.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}{c.email ? ` · ${c.email}` : c.telegramName ? ` · ${c.telegramName}` : ''}
          </option>
        ))}
      </Select>
      {typingNew && !areCustomersLoading && !hasCustomersError && (
        <div className="form-row">
          <div className="field">
            <label htmlFor="complete-name">Customer name</label>
            <input id="complete-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="complete-telegram">Telegram name</label>
            <input id="complete-telegram" type="text" placeholder="@name" value={telegramName} onChange={(e) => setTelegramName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="complete-email">Email (optional)</label>
            <input id="complete-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
        </div>
      )}
      <Select id="complete-category" label="Category" value={category} onChange={setCategoryId}
        hint={categories.length === 0 ? (
          <>
            No categories defined yet.{' '}
            <Link className="btn ghost small" to="/settings?tab=categories" target="_blank" rel="noreferrer">
              Manage categories
            </Link>
          </>
        ) : undefined}>
        {categories.length === 0 && <option value="">No categories defined</option>}
        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </Select>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={submit}
          disabled={isSaving || !category || areCustomersLoading || hasCustomersError}>
          {isSaving ? 'Saving…' : 'Save details'}
        </button>
      </div>
    </Modal>
  );
}
