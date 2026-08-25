import { Fragment, useState } from 'react';
import {
  NOTIFICATION_EVENT_LABELS,
  type NotificationChannel, type NotificationEvent, type NotificationPreferences,
} from '../../api/endpoints';
import { HttpError } from '../../api/http';
import { useCan } from '../../hooks/usePermission';
import { toast } from '../../lib/toast';
import { EmptyState, ErrorCard, LoadingCard, Pill } from '../../components/ui';
import { useNotificationSettings } from './useSettingsData';

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof HttpError && typeof err.body === 'object' && err.body !== null
    && 'detail' in err.body && typeof err.body.detail === 'string') {
    return err.body.detail;
  }
  return err instanceof Error ? err.message : fallback;
}

function toggleEvent(events: NotificationEvent[], event: NotificationEvent, on: boolean): NotificationEvent[] {
  return on ? [...events, event] : events.filter((e) => e !== event);
}

export function NotificationsPane() {
  const can = useCan();
  const editable = can('settings.edit');
  const {
    preferences, channels,
    savePreferences, createChannel, setChannelActive, deleteChannel, testChannel,
  } = useNotificationSettings();

  if (preferences.isLoading || channels.isLoading) return <LoadingCard />;
  if (preferences.isError || channels.isError || !preferences.data || !channels.data) return <ErrorCard />;

  const test = async (channel: NotificationChannel) => {
    try {
      await testChannel.mutateAsync(channel.id);
      toast('Test message sent.');
    } catch (err) {
      toast(errorMessage(err, 'Test message failed.'));
    }
  };

  const setActive = async (channel: NotificationChannel, active: boolean) => {
    try {
      await setChannelActive.mutateAsync({ id: channel.id, active });
      toast(active ? 'Chat resumed.' : 'Chat paused.');
    } catch (err) {
      toast(errorMessage(err, 'Could not update the chat.'));
    }
  };

  const remove = async (channel: NotificationChannel) => {
    try {
      await deleteChannel.mutateAsync(channel.id);
      toast('Chat removed.');
    } catch (err) {
      toast(errorMessage(err, 'Could not remove the chat.'));
    }
  };

  return (
    <div className="stack">
      <PreferencesCard
        preferences={preferences.data}
        onSave={(events) => savePreferences.mutateAsync(events)}
      />

      <div className="card">
        <div className="sechead">Telegram notifications</div>
        <p className="sub">
          Send a message to a Telegram chat every time a payment happens. Add the HigherPays bot to
          your group, then paste the chat ID below.
        </p>

        {channels.data.channels.length === 0 ? (
          <EmptyState title="No chats connected yet." />
        ) : (
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>Chat</th><th>Events</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {channels.data.channels.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <div className="cname">{c.label || c.target}</div>
                      <div className="cemail">{c.target}</div>
                    </td>
                    <td>
                      {c.events.map((e, i) => (
                        <Fragment key={e}>
                          {i > 0 && ' '}
                          <span className="seg">{NOTIFICATION_EVENT_LABELS[e]}</span>
                        </Fragment>
                      ))}
                    </td>
                    <td>
                      {c.lastError ? (
                        <>
                          <Pill tone="no">Error</Pill>
                          <div className="cemail">{c.lastError}</div>
                        </>
                      ) : c.active ? <Pill tone="ok">Active</Pill> : <Pill>Paused</Pill>}
                    </td>
                    <td>
                      {editable && (
                        <div className="controls">
                          <button className="btn ghost small" disabled={testChannel.isPending} onClick={() => test(c)}>Test</button>
                          <button className="btn ghost small" disabled={setChannelActive.isPending} onClick={() => setActive(c, !c.active)}>
                            {c.active ? 'Pause' : 'Resume'}
                          </button>
                          <button className="btn danger small" disabled={deleteChannel.isPending} onClick={() => remove(c)}>Remove</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {editable && (
          <AddChannelForm
            availableEvents={channels.data.availableEvents}
            onCreate={(input) => createChannel.mutateAsync(input)}
          />
        )}
      </div>
    </div>
  );
}

function PreferencesCard({ preferences, onSave }: {
  preferences: NotificationPreferences;
  onSave: (events: NotificationEvent[]) => Promise<unknown>;
}) {
  const [events, setEvents] = useState<NotificationEvent[]>(preferences.events);

  const save = async () => {
    try {
      await onSave(events);
      toast('Notification preferences saved.');
    } catch (err) {
      toast(errorMessage(err, 'Could not save your preferences.'));
    }
  };

  return (
    <div className="card">
      <div className="sechead">Your notifications</div>
      <p className="sub">
        Choose what appears in your notification bell. This is personal &mdash; it doesn't change
        what your teammates see.
      </p>
      {preferences.available.map((event) => (
        <div className="setrow" key={event}>
          <div className="k">{NOTIFICATION_EVENT_LABELS[event]}</div>
          <input type="checkbox" checked={events.includes(event)}
            onChange={(e) => setEvents(toggleEvent(events, event, e.target.checked))} />
        </div>
      ))}
      <div className="actions-right">
        <button className="btn" onClick={save}>Save my preferences</button>
      </div>
    </div>
  );
}

function AddChannelForm({ availableEvents, onCreate }: {
  availableEvents: NotificationEvent[];
  onCreate: (input: { target: string; label?: string; events: NotificationEvent[] }) => Promise<unknown>;
}) {
  const [target, setTarget] = useState('');
  const [label, setLabel] = useState('');
  const [events, setEvents] = useState<NotificationEvent[]>(['payment.paid']);

  const connect = async () => {
    if (!target.trim()) { toast('Paste the Telegram chat ID.'); return; }
    if (events.length === 0) { toast('Pick at least one event.'); return; }
    try {
      await onCreate({
        target: target.trim(),
        ...(label.trim() ? { label: label.trim() } : {}),
        events,
      });
      setTarget(''); setLabel(''); setEvents(['payment.paid']);
      toast('Chat connected.');
    } catch (err) {
      toast(errorMessage(err, 'Could not connect the chat.'));
    }
  };

  return (
    <>
      <div className="sechead">Add a chat</div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="telegram-chat-id">Telegram chat ID</label>
          <input id="telegram-chat-id" type="text" value={target} onChange={(e) => setTarget(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="telegram-label">Label</label>
          <input id="telegram-label" type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
      </div>
      <div className="check-inline">
        {availableEvents.map((event) => (
          <label key={event} className="check">
            <input type="checkbox" checked={events.includes(event)}
              onChange={(e) => setEvents(toggleEvent(events, event, e.target.checked))} />
            {NOTIFICATION_EVENT_LABELS[event]}
          </label>
        ))}
      </div>
      <div className="actions-right">
        <button className="btn" onClick={connect}>Connect chat</button>
      </div>
    </>
  );
}
