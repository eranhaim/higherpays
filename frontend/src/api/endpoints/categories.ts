import { api } from '../http';
import { workspacePath } from '../workspacePath';

/** A sale category the agent picks when completing a paid payment. */
export interface Category {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
}

export const categoriesApi = {
  /** Active categories only; `all` is retained for older workspaces. */
  async list(all = false): Promise<Category[]> {
    const raw = await api.get<{ categories: Category[] }>(workspacePath(all ? '/categories?all=true' : '/categories'));
    return raw.categories;
  },

  create: (name: string) => api.post<Category>(workspacePath('/categories'), { name }),

  update: (id: string, input: { name?: string; active?: boolean }) =>
    api.patch<Category>(workspacePath(`/categories/${id}`), input),
  remove: (id: string) => api.del(workspacePath(`/categories/${id}`)),
};
