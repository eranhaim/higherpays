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
        <PageHeader eyebrow="Admin" title="Settings" />
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
      <PageHeader eyebrow="Admin" title="Settings" />

      <div className="tabbar">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`btn ghost tgl${tab === t.id ? ' active' : ''}`}
            onClick={() => setSearchParams({ tab: t.id })}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'general' && <GeneralPane />}
      {tab === 'roles' && <RolesPane />}
      {tab === 'notifications' && <NotificationsPane />}
    </div>
  );
}
