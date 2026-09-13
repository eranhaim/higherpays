import { api } from '../http';
import { workspacePath } from '../workspacePath';

export type ArchiveType = 'links' | 'payments' | 'creators' | 'agents' | 'customers' | 'team' | 'workspaces';

export interface ArchivedItem {
  id: string;
  type: ArchiveType;
  name: string;
  detail: string | null;
  status: string | null;
  amount: number | null;
  currency: string | null;
  archivedAt: string;
}

export interface ArchivedItems {
  type: ArchiveType;
  items: ArchivedItem[];
}

export const ARCHIVE_TABS: Array<{ type: ArchiveType; label: string }> = [
  { type: 'links', label: 'Payment links' },
  { type: 'payments', label: 'Payments' },
  { type: 'creators', label: 'Creators' },
  { type: 'agents', label: 'Agents' },
  { type: 'customers', label: 'Customers' },
  { type: 'team', label: 'Team' },
  { type: 'workspaces', label: 'Workspaces' },
];

export const archiveApi = {
  list: (type: ArchiveType) =>
    type === 'workspaces'
      ? api.get<ArchivedItems>('/platform/archive', { skipWorkspace: true })
      : api.get<ArchivedItems>(workspacePath(`/archive?type=${encodeURIComponent(type)}`)),

  restore: (type: ArchiveType, id: string) =>
    type === 'workspaces'
      ? api.post<{ id: string; type: ArchiveType; restored: true }>(`/platform/archive/workspaces/${id}/restore`, {}, { skipWorkspace: true })
      : api.post<{ id: string; type: ArchiveType; restored: true }>(
          workspacePath(`/archive/${type}/${id}/restore`),
          {},
        ),
};
