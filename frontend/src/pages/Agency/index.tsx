import { useSearchParams } from 'react-router-dom';
import { useCan } from '../../hooks/usePermission';
import { useCurrentSession } from '../../hooks/useCurrentSession';
import { PageHeader } from '../../components/ui';
import AccountsPage from '../Accounts';
import AgentsPage from '../Agents';
import TeamPage from '../Team';

type AgencyTab = 'creators' | 'agents' | 'people';

export default function AgencyPage() {
  const can = useCan();
  const { labels } = useCurrentSession();
  const [params, setParams] = useSearchParams();
  const tabs = [
    can('accounts.view') && { id: 'creators' as const, label: labels.accounts, hint: 'Creators, pay models, and assigned chatters' },
    can('agents.view') && { id: 'agents' as const, label: labels.agents, hint: 'Chatters, commissions, and creator assignments' },
    can('team.view') && { id: 'people' as const, label: 'People & access', hint: 'Every user, their role, and sign-in access' },
  ].filter(Boolean) as Array<{ id: AgencyTab; label: string; hint: string }>;
  const asked = params.get('tab') as AgencyTab | null;
  const active = tabs.some((tab) => tab.id === asked) ? asked! : tabs[0]?.id ?? 'creators';
  const select = (tab: AgencyTab) => setParams({ tab });

  return (
    <div>
      <PageHeader
        title="Agency"
        subtitle="Run your people from one place: creators, chatters, assignments, roles, and access."
      />
      <div className="agency-tabs" role="tablist" aria-label="Agency management">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            className={`agency-tab${active === tab.id ? ' active' : ''}`}
            onClick={() => select(tab.id)}
          >
            <span>{tab.label}</span>
            <small>{tab.hint}</small>
          </button>
        ))}
      </div>
      <div className="agency-panel">
        {active === 'creators' && <AccountsPage embedded />}
        {active === 'agents' && <AgentsPage embedded />}
        {active === 'people' && <TeamPage embedded />}
      </div>
    </div>
  );
}
