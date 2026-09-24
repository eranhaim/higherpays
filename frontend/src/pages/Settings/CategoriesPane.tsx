import { useState } from 'react';
import { HttpError } from '../../api/http';
import type { Category } from '../../api/endpoints';
import { useCan } from '../../hooks/usePermission';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { toast } from '../../lib/toast';
import { EmptyState, ErrorCard, LoadingCard } from '../../components/ui';
import { useCategories } from './useSettingsData';

/**
 * The sale categories an agent picks from when completing a paid payment.
 * Categories are deliberately hard-deleted rather than archived.
 */
export function CategoriesPane() {
  const can = useCan();
  const { labels } = useCurrentSession();
  const editable = can('settings.edit');
  const { categories, create, update, remove } = useCategories();
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  if (categories.isLoading) return <LoadingCard />;
  if (categories.isError || !categories.data) return <ErrorCard />;

  const add = async () => {
    if (!name.trim()) { toast('Category name is required.'); return; }
    try {
      await create.mutateAsync(name.trim());
      setName('');
      toast('Category added.');
    } catch (err) {
      toast(err instanceof HttpError && err.status === 409 ? 'A category with that name already exists.' : err instanceof Error ? err.message : 'Could not add the category.');
    }
  };

  const deleteCategory = async (c: Category) => {
    try {
      await remove.mutateAsync(c.id);
      toast(`${c.name} deleted.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete the category.');
    }
  };

  const saveRename = async () => {
    if (!renaming) return;
    if (!renaming.name.trim()) { toast('Category name is required.'); return; }
    try {
      await update.mutateAsync({ id: renaming.id, input: { name: renaming.name.trim() } });
      setRenaming(null);
      toast('Renamed.');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not rename the category.');
    }
  };

  return (
    <div className="card">
      <div className="sechead">Sale categories</div>
      <p className="sub">
        After a customer pays, the {labels.agent.toLowerCase()} picks one of these to say what the sale was for.
        Deleting a category removes it from the picker; past payment amounts stay unchanged.
      </p>

      {categories.data.length === 0 ? <EmptyState title="No categories yet." hint={`${labels.agents} cannot complete a payment until there is at least one.`} /> : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Category</th>
                {editable && <th scope="col"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {categories.data.map((c) => (
                <tr key={c.id}>
                  <th scope="row">
                    {renaming?.id === c.id ? (
                      <div className="controls">
                        <input type="text" aria-label="New name" value={renaming.name} onChange={(e) => setRenaming({ id: c.id, name: e.target.value })} />
                        <button className="btn small" onClick={saveRename} disabled={update.isPending}>Save</button>
                        <button className="btn ghost small" onClick={() => setRenaming(null)}>Cancel</button>
                      </div>
                    ) : c.name}
                  </th>
                  {editable && (
                    <td className="cell-actions">
                      <button className="btn ghost small" onClick={() => setRenaming({ id: c.id, name: c.name })}>Rename</button>
                      <button className="btn ghost small" onClick={() => deleteCategory(c)} disabled={remove.isPending}>Delete</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editable && (
        <>
          <div className="sechead">Add a category</div>
          <div className="controls">
            <input type="text" aria-label="Category name" placeholder="e.g. Subscription" value={name}
              onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
            <button className="btn" onClick={add} disabled={create.isPending}>{create.isPending ? 'Adding…' : 'Add'}</button>
          </div>
        </>
      )}
    </div>
  );
}
