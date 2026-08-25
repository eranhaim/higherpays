import { api } from '../http';
import { workspacePath } from '../workspacePath';

export interface Invite {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  acceptedAt: string | null;
}

interface RawInvite {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  accepted_at: string | null;
}

function normalize(i: RawInvite): Invite {
  return { id: i.id, email: i.email, role: i.role, expiresAt: i.expires_at, acceptedAt: i.accepted_at };
}

export const invitesApi = {
  async list(): Promise<Invite[]> {
    const raw = await api.get<{ invites: RawInvite[] }>(workspacePath('/invites'));
    return raw.invites.map(normalize);
  },

  async create(input: { email: string; role: string; accountId?: string }): Promise<Invite> {
    const raw = await api.post<RawInvite>(workspacePath('/invites'), input);
    return normalize(raw);
  },
};
