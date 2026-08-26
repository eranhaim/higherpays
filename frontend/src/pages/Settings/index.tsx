import { useSearchParams } from 'react-router-dom';
import { useCan } from '../../hooks/usePermission';
import { EmptyState, PageHeader } from '../../components/ui';
import { GeneralPane } from './GeneralPane';
import { RolesPane } from './RolesPane';
import { NotificationsPane } from './NotificationsPane';

type SettingsTab = 'general' | 'roles' | 'notifications';

export default function SettingsPage() {
  const can = useCan();
  const [searchParams, setSearchParams] = useSearchParams();

  if (!can('settings.view')) {
    return (
      <div>
        <PageHeader title="Settings" />
        <div className="card">
          <EmptyState
            title="You don't have access to settings."
            hint="Ask an owner or admin if you need it."
          />
        </div>
      </div>
    );
  }

  const tabs: Array<{ id: SettingsTab; label: string }> = [
    { id: 'general', label: 'General' },
    ...(can('team.view') ? [{ id: 'roles' as const, label: 'Roles' }] : []),
    ...(can('payments.view') ? [{ id: 'notifications' as const, label: 'Notifications' }] : []),
  ];
  const requested = searchParams.get('tab');
  const tab = tabs.find((t) => t.id === requested)?.id ?? 'general';

  return (
    <div>
      <PageHeader title="Settings" />

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
        {tab === 'general' && <GeneralPane />}
        {tab === 'roles' && <RolesPane />}
        {tab === 'notifications' && <NotificationsPane />}
      </div>
    </div>
  );
}
