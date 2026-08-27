import { api } from '../http';
import { workspacePath } from '../workspacePath';

/** Agents and account owners are created directly, login included. */
export type InvitableRole = 'workspace_admin' | 'analyst';
export const INVITABLE_ROLES: InvitableRole[] = ['workspace_admin', 'analyst'];

export interface Invite {
  id: string;
  email: string;
  role: InvitableRole;
  expiresAt: string;
  acceptedAt: string | null;
}

interface RawInvite {
  id: string;
  email: string;
  role: InvitableRole;
  expires_at: string;
  accepted_at: string | null;
}

function normalize(i: RawInvite): Invite {
  return { id: i.id, email: i.email, role: i.role, expiresAt: i.expires_at, acceptedAt: i.accepted_at };
}

/** What the invited person sees before they accept. */
export interface InvitePreview {
  email: string;
  role: InvitableRole;
  workspace: string;
}

export const invitesApi = {
  async list(): Promise<Invite[]> {
    const raw = await api.get<{ invites: RawInvite[] }>(workspacePath('/invites'));
    return raw.invites.map(normalize);
  },

  async create(input: { email: string; role: InvitableRole }): Promise<Invite> {
    const raw = await api.post<RawInvite>(workspacePath('/invites'), input);
    return normalize(raw);
  },

  /** Withdraws a pending invite; its token stops resolving immediately. */
  remove: (id: string) => api.del<void>(workspacePath(`/invites/${id}`)),

  // The two public calls below are made before sign-in, keyed by the token alone.
  preview: (token: string) =>
    api.get<InvitePreview>(`/invites/${encodeURIComponent(token)}`, { skipWorkspace: true, skipRefresh: true }),

  accept: (token: string, input: { password?: string; fullName?: string }) =>
    api.post<{ ok: true; existingUser: boolean }>(`/invites/${encodeURIComponent(token)}/accept`, input, { skipWorkspace: true, skipRefresh: true }),
};
