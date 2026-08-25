export type Role = 'owner' | 'admin' | 'manager' | 'analyst' | 'chatter' | 'creator' | 'super_admin';

export type Permission =
  | 'payments.view' | 'payments.export'
  | 'links.view' | 'links.create'
  | 'analytics.view'
  | 'workspaces.view' | 'workspaces.create'
  | 'creators.view' | 'creators.manage'
  | 'customers.view' | 'customers.manage' | 'customers.export'
  | 'sales.view'
  | 'commissions.view' | 'commissions.manage'
  | 'team.view' | 'team.manage'
  | 'settings.view' | 'settings.edit' | 'settings.danger'
  | 'platform.view';

export type CustomerSegment = 'New' | 'Regular' | 'High value' | 'VIP' | 'Inactive' | 'At-risk';
export type RevenueModel = 'revshare' | 'salary' | 'ai';
export type LinkStatus = 'Created' | 'Paid' | 'Failed' | 'Expired';
export type CreatorStatus = 'active' | 'paused' | 'suspended';
export type ChatterStatus = 'active' | 'offline';
export type WorkspaceStatus = 'live' | 'setup';

export interface Workspace {
  id: string;
  name: string;
  initial: string;
  color: string;
  client: string;
  contact: string;
  mid: string;
  reservePct: number;
  reserveReleaseDays: number;
  declineFee: number;
  refundFee: number;
  chargebackFee: number;
  currencies: string[];
  pspRate: number;
  marginRate: number;
  pspFixedFee: number;
  minLink: number;
  maxLink: number | null;
  status: WorkspaceStatus;
}

export interface Creator {
  id: string;
  name: string;
  handle: string;
  color: string;
  status: CreatorStatus;
  revModel: RevenueModel;
  splitCreator: number;
  salary?: number;
  salaryInc?: number;
  mrr: number;
}

export interface Chatter {
  id: string;
  membershipId?: string;
  name: string;
  email: string;
  status: ChatterStatus;
  shift: 'Day' | 'Night';
  assigned: string[];
  commissionPct: number;
}

export interface Member {
  name: string;
  email: string;
  role: string;
}

export interface Customer {
  id: string;
  name: string;
  username: string;
  email: string;
  creator: string;
  chatter: string;
  spend: number;
  purchases: number;
  last: number;
  seg: CustomerSegment;
}

export interface PaymentLink {
  id: string;
  creator: string;
  chatter: string;
  customerName: string;
  customerUsername: string;
  amount: number;
  unit: string;
  status: LinkStatus;
  ts: number;
  checkoutUrl?: string | null;
}

import type { TransactionStatus } from '../api/endpoints/payouts';

export interface Transaction {
  id: string;
  referenceId: string;
  providerTxId?: string;
  clientName: string;
  username: string;
  creator: string;
  chatter: string;
  amount: number;
  currency: string;
  status: TransactionStatus;
  notes: string;
  ts: number;
}

export interface Commission {
  creatorSplit: number;
  agencySplit: number;
  chatterPct: number;
}

export interface LinkLimits {
  min: number;
  max: number | null;
  providerMin: number;
}

export interface MyWorkspace {
  id: string;
  name: string;
  role: string;
}

export interface Brand {
  name: string;
  initial: string;
}

export interface Fees {
  blended: number;
  psp: number | null;
  margin: number | null;
  fixed: number;
  refundFee: number;
  chargebackFee: number;
  declineFee: number;
  reservePct: number;
  reserveReleaseDays: number;
  providerRefundAvailable?: boolean;
}

export interface RateCard {
  blended: number;
  psp: number | null;
  margin: number | null;
  fixed: number;
  refundFee: number;
  chargebackFee: number;
  declineFee: number;
  reservePct: number;
  reserveReleaseDays: number;
}

export interface FeeBreakdownResult {
  amount: number;
  blendedPct: number;
  blendedFee: number;
  fixed: number;
  total: number;
  pspPct: number | null;
  marginPct: number | null;
  pspFee: number | null;
  marginFee: number | null;
  effectivePct: number;
  net: number;
}

export interface SplitResult {
  g: number;
  platformFee: number;
  dist: number;
  creatorCut: number;
  chatterCut: number;
  agencyCut: number;
  pspFee: number;
  margin: number;
  model: RevenueModel;
  blended: number;
}

export interface Reserve {
  held: number;
  source: 'settlements' | 'estimated';
}

export interface Settlement {
  period: string;
  volume: number;
  fees: number;
  reserve: number;
  payable: number;
  reconciliation: {
    volume: number;
    status: string;
  };
}

export interface Notification {
  id: string;
  event: string;
  title: string;
  body: string;
  amount?: number;
  currency?: string;
  read: boolean;
  createdAt: number | string;
  entityType?: string;
  entityId?: string;
}

export interface GoalTarget {
  memberName: string;
  metric: string;
  targetValue: number;
  period: string;
}

export interface TzParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

export interface AppState {
  brand: Brand;
  role: Role;
  workspaces: Workspace[];
  members: Member[];
  creators: Creator[];
  chatters: Chatter[];
  customers: Customer[];
  links: PaymentLink[];
  commission: Commission;
  linkLimits: LinkLimits;
  activeWsId: string;
  myWorkspaces: MyWorkspace[];
  roles: Record<string, Permission[]>;
  transactions: Transaction[];
  reserve?: Reserve;
  fees?: Fees;
  platformBlended?: number;
  channels?: unknown[];
  identity?: { chatter?: string; creator?: string };
  targets?: GoalTarget[];
  settlements?: Settlement[];
}
