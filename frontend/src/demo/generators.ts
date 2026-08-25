import type {
  AppState, Workspace, Creator, Chatter, Member, Customer,
  PaymentLink, Transaction, Commission, LinkLimits, MyWorkspace, Brand, Permission,
} from '../types';
import { ROLE_PERMISSIONS } from '../rbac/permissions';

const now = Date.now();
const DAY = 86400000;

export function createDemoState(): AppState {
  const brand: Brand = { name: 'Aurora Media', initial: 'A' };

  const workspaces: Workspace[] = [
    { id: 'ws1', name: 'Aurora Media', initial: 'A', color: '#15C3AF', client: 'Aurora Media Ltd', contact: 'ops@auroramedia.co', mid: 'MID-4471-EU', reservePct: 5, reserveReleaseDays: 180, declineFee: 0.2, refundFee: 15, chargebackFee: 60, currencies: ['EUR'], pspRate: 8, marginRate: 5, pspFixedFee: 0.5, minLink: 20, maxLink: 400, status: 'live' },
    { id: 'ws2', name: 'Nordic Elite', initial: 'N', color: '#4ADE9E', client: 'Nordic Media AB', contact: 'admin@nordic.se', mid: 'MID-8820-SE', reservePct: 5, reserveReleaseDays: 180, declineFee: 0.2, refundFee: 15, chargebackFee: 60, currencies: ['EUR'], pspRate: 8, marginRate: 5, pspFixedFee: 0.5, minLink: 25, maxLink: 500, status: 'setup' },
    { id: 'ws3', name: 'Iberia Collective', initial: 'I', color: '#F5C451', client: 'Iberia Digital SL', contact: 'hi@iberia.es', mid: 'MID-3390-ES', reservePct: 5, reserveReleaseDays: 180, declineFee: 0.2, refundFee: 15, chargebackFee: 60, currencies: ['EUR'], pspRate: 8, marginRate: 5, pspFixedFee: 0.5, minLink: 15, maxLink: 300, status: 'live' },
  ];

  const members: Member[] = [
    { name: 'You', email: 'owner@auroramedia.co', role: 'owner' },
    { name: 'Rina Adler', email: 'rina@auroramedia.co', role: 'admin' },
    { name: 'Deniz Kaya', email: 'deniz@auroramedia.co', role: 'analyst' },
    { name: 'Marco Vidal', email: 'marco@auroramedia.co', role: 'manager' },
  ];

  const creators: Creator[] = [
    { id: 'cr1', name: 'Ava Lane', handle: '@avalane', color: '#F4707A', status: 'active', revModel: 'revshare', splitCreator: 70, mrr: 8420 },
    { id: 'cr2', name: 'Mia Cole', handle: '@miacole', color: '#B98CFF', status: 'active', revModel: 'salary', salary: 3500, salaryInc: 5, splitCreator: 0, mrr: 5110 },
    { id: 'cr3', name: 'Nova Reed', handle: '@novareed', color: '#4ADE9E', status: 'paused', revModel: 'ai', splitCreator: 0, mrr: 0 },
  ];

  const chatters: Chatter[] = [
    { id: 'ch1', name: 'Sam Ortiz', email: 'sam@auroramedia.co', status: 'active', shift: 'Day', assigned: ['Ava Lane'], commissionPct: 15 },
    { id: 'ch2', name: 'Priya Nair', email: 'priya@auroramedia.co', status: 'active', shift: 'Night', assigned: ['Ava Lane', 'Mia Cole'], commissionPct: 8 },
    { id: 'ch3', name: 'Leo Marsh', email: 'leo@auroramedia.co', status: 'offline', shift: 'Day', assigned: ['Mia Cole'], commissionPct: 5 },
  ];

  const customers: Customer[] = [
    { id: 'cu1', name: 'John D.', username: '@nightowl_92', email: 'j.d@example.com', creator: 'Ava Lane', chatter: 'Sam Ortiz', spend: 1240, purchases: 11, last: now - 2 * DAY, seg: 'VIP' },
    { id: 'cu2', name: 'Marco R.', username: '@marco_r', email: 'marco@example.com', creator: 'Ava Lane', chatter: 'Priya Nair', spend: 340, purchases: 4, last: now - 5 * DAY, seg: 'High value' },
    { id: 'cu3', name: 'Sky', username: '@sky_blue', email: 's.b@example.com', creator: 'Mia Cole', chatter: 'Priya Nair', spend: 90, purchases: 3, last: now - 1 * DAY, seg: 'Regular' },
    { id: 'cu4', name: 'New Guy', username: '@newguy01', email: 'new@example.com', creator: 'Mia Cole', chatter: 'Leo Marsh', spend: 15, purchases: 1, last: now - 1 * 3600e3, seg: 'New' },
    { id: 'cu5', name: 'Quiet Fan', username: '@quiet_fan', email: 'q@example.com', creator: 'Ava Lane', chatter: 'Sam Ortiz', spend: 520, purchases: 6, last: now - 40 * DAY, seg: 'Inactive' },
    { id: 'cu6', name: 'D. Disputes', username: '@disputes_guy', email: 'd@example.com', creator: 'Nova Reed', chatter: 'Leo Marsh', spend: 210, purchases: 2, last: now - 12 * DAY, seg: 'At-risk' },
  ];

  const links: PaymentLink[] = [
    { id: 'pl1', creator: 'Ava Lane', chatter: 'Sam Ortiz', customerName: 'John D.', customerUsername: '@nightowl_92', amount: 120, unit: 'EUR', status: 'Paid', ts: now - 2 * DAY },
    { id: 'pl2', creator: 'Ava Lane', chatter: 'Priya Nair', customerName: 'Marco R.', customerUsername: '@marco_r', amount: 45, unit: 'EUR', status: 'Paid', ts: now - 1 * DAY },
    { id: 'pl3', creator: 'Mia Cole', chatter: 'Priya Nair', customerName: 'Sky', customerUsername: '@sky_blue', amount: 30, unit: 'EUR', status: 'Created', ts: now - 6 * 3600e3 },
    { id: 'pl4', creator: 'Mia Cole', chatter: 'Leo Marsh', customerName: 'New Guy', customerUsername: '@newguy01', amount: 15, unit: 'EUR', status: 'Created', ts: now - 2 * 3600e3 },
    { id: 'pl5', creator: 'Ava Lane', chatter: 'Sam Ortiz', customerName: 'Quiet Fan', customerUsername: '@quiet_fan', amount: 80, unit: 'EUR', status: 'Failed', ts: now - 3 * DAY },
    { id: 'pl6', creator: 'Mia Cole', chatter: 'Leo Marsh', customerName: 'Sky', customerUsername: '@sky_blue', amount: 60, unit: 'EUR', status: 'Paid', ts: now - 4 * DAY },
  ];

  const transactions: Transaction[] = [
    { id: 'tx-10231', referenceId: 'order-10231', clientName: 'Anna Bauer', username: '@anna_b', creator: 'Ava Lane', chatter: 'Sam Ortiz', notes: 'Custom set #12', amount: 49.99, currency: 'EUR', status: 'approved', ts: now - 2 * 3600e3 },
    { id: 'tx-10230', referenceId: 'order-10230', clientName: 'Luca Rossi', username: '@luca_r', creator: 'Ava Lane', chatter: 'Priya Nair', notes: 'PPV bundle', amount: 129.00, currency: 'EUR', status: 'approved', ts: now - 5 * 3600e3 },
    { id: 'tx-10229', referenceId: 'order-10229', clientName: 'Sophie Meyer', username: '@sky_blue', creator: 'Mia Cole', chatter: 'Priya Nair', notes: 'Top-up', amount: 20.00, currency: 'EUR', status: 'declined', ts: now - 1 * DAY },
    { id: 'tx-10228', referenceId: 'order-10228', clientName: 'Karel Novak', username: '@karel_n', creator: 'Ava Lane', chatter: 'Sam Ortiz', notes: 'Custom video', amount: 340.50, currency: 'EUR', status: 'approved', ts: now - 1 * DAY - 3600e3 },
    { id: 'tx-10227', referenceId: 'order-10227', clientName: 'Marta Kowal', username: '@marta_k', creator: 'Mia Cole', chatter: 'Leo Marsh', notes: 'PPV', amount: 14.99, currency: 'EUR', status: 'approved', ts: now - 2 * DAY },
    { id: 'tx-10226', referenceId: 'order-10226', clientName: 'Jonas Vik', username: '@jonas_v', creator: 'Mia Cole', chatter: 'Leo Marsh', notes: 'Tip', amount: 88.00, currency: 'EUR', status: 'declined', ts: now - 3 * DAY },
    { id: 'tx-10225', referenceId: 'order-10225', clientName: 'Elena Popa', username: '@elena_p', creator: 'Ava Lane', chatter: 'Priya Nair', notes: 'Custom set', amount: 49.99, currency: 'EUR', status: 'approved', ts: now - 6 * DAY },
    { id: 'tx-10224', referenceId: 'order-10224', clientName: 'Tom Fischer', username: '@tom_f', creator: 'Ava Lane', chatter: 'Sam Ortiz', notes: 'PPV bundle', amount: 210.00, currency: 'EUR', status: 'approved', ts: now - 9 * DAY },
  ];

  const commission: Commission = { creatorSplit: 70, agencySplit: 30, chatterPct: 8 };
  const linkLimits: LinkLimits = { min: 20, max: null, providerMin: 3 };
  const myWorkspaces: MyWorkspace[] = [
    { id: 'ws1', name: 'Aurora Media', role: 'owner' },
    { id: 'ws3', name: 'Iberia Collective', role: 'analyst' },
  ];

  const roles: Record<string, Permission[]> = { ...ROLE_PERMISSIONS };

  return {
    brand,
    role: 'owner',
    workspaces,
    members,
    creators,
    chatters,
    customers,
    links,
    commission,
    linkLimits,
    activeWsId: 'ws1',
    myWorkspaces,
    roles,
    transactions,
  };
}
