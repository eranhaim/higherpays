import { useSearchParams } from 'react-router-dom';
import { useCan } from '../../hooks/usePermission';
import { PageHeader } from '../../components/ui';
import { WorkspacePane } from './WorkspacePane';
import { CategoriesPane } from './CategoriesPane';
import { NotificationsPane } from './NotificationsPane';
import { ActivityPane } from './ActivityPane';
import { AccountPane } from './AccountPane';

type SettingsTab = 'workspace' | 'categories' | 'notifications' | 'activity' | 'account';

/**
 * Two kinds of settings share this page. The workspace tabs need
 * `settings.view`; the personal tabs (notifications, account) belong to
 * everyone with a login, so the page itself is open to every role.
 */
export default function SettingsPage() {
  const can = useCan();
  const [searchParams, setSearchParams] = useSearchParams();
  const seesWorkspace = can('settings.view');

  const tabs: Array<{ id: SettingsTab; label: string }> = [
    ...(seesWorkspace ? [
      { id: 'workspace' as const, label: 'Workspace' },
      { id: 'categories' as const, label: 'Categories' },
    ] : []),
    { id: 'notifications', label: 'Notifications' },
    ...(seesWorkspace ? [{ id: 'activity' as const, label: 'Activity' }] : []),
    { id: 'account', label: 'My account' },
  ];
  const requested = searchParams.get('tab');
  const tab = tabs.find((t) => t.id === requested)?.id ?? tabs[0].id;

  return (
    <div>
      <PageHeader title="Settings" subtitle={seesWorkspace ? 'How this workspace runs, and your own login.' : 'Your notifications and your login.'} />

      <div className="tabbar" role="tablist" aria-label="Settings sections">
        {tabs.map((t) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            // Only the selected tab is in the tab order; arrows move between
            // them, which is how a tablist is expected to behave.
            tabIndex={tab === t.id ? 0 : -1}
            className={`btn ghost tgl${tab === t.id ? ' active' : ''}`}
            onClick={() => setSearchParams({ tab: t.id })}
            onKeyDown={(e) => {
              const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
              if (step === 0) return;
              e.preventDefault();
              const next = tabs[(tabs.findIndex((x) => x.id === tab) + step + tabs.length) % tabs.length];
              setSearchParams({ tab: next.id });
              document.getElementById(`tab-${next.id}`)?.focus();
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'workspace' && <WorkspacePane />}
        {tab === 'categories' && <CategoriesPane />}
        {tab === 'notifications' && <NotificationsPane />}
        {tab === 'activity' && <ActivityPane />}
        {tab === 'account' && <AccountPane />}
      </div>
    </div>
  );
}
