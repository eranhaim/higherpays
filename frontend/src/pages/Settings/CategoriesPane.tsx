import { useState } from 'react';
import { HttpError } from '../../api/http';
import type { Category } from '../../api/endpoints';
import { useCan } from '../../hooks/usePermission';
import { toast } from '../../lib/toast';
import { EmptyState, ErrorCard, LoadingCard, Pill } from '../../components/ui';
import { useCategories } from './useSettingsData';

/**
 * The sale categories an agent picks from when completing a paid payment.
 * Retiring one hides it from the picker; payments that used it keep it.
 */
export function CategoriesPane() {
  const can = useCan();
  const editable = can('settings.edit');
  const { categories, create, update } = useCategories();
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

  const toggle = async (c: Category) => {
    try {
      await update.mutateAsync({ id: c.id, input: { active: !c.active } });
      toast(c.active ? `${c.name} retired.` : `${c.name} active again.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update the category.');
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
        After a customer pays, the agent picks one of these to say what the sale was for.
        Retired categories stay on past payments but leave the picker.
      </p>

      {categories.data.length === 0 ? <EmptyState title="No categories yet." hint="Agents cannot complete a payment until there is at least one." /> : (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Status</th>
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
                  <td>{c.active ? <Pill tone="ok">Active</Pill> : <Pill tone="muted">Retired</Pill>}</td>
                  {editable && (
                    <td className="cell-actions">
                      <button className="btn ghost small" onClick={() => setRenaming({ id: c.id, name: c.name })}>Rename</button>
                      <button className="btn ghost small" onClick={() => toggle(c)} disabled={update.isPending}>{c.active ? 'Retire' : 'Reactivate'}</button>
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
