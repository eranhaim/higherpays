import { Fragment, useState } from 'react';
import {
  NOTIFICATION_EVENT_LABELS,
  type NotificationChannel, type NotificationEvent, type NotificationPreferences,
} from '../../api/endpoints';
import { HttpError } from '../../api/http';
import { useCan } from '../../hooks/usePermission';
import { useUnsavedChanges } from '../../hooks/useUnsavedChanges';
import { toast } from '../../lib/toast';
import Modal from '../../components/Modal';
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
  const [removing, setRemoving] = useState<NotificationChannel | null>(null);
  const {
    preferences, channels,
    savePreferences, createChannel, setChannelActive, setChannelEvents, deleteChannel, testChannel,
  } = useNotificationSettings();

  if (preferences.isLoading || channels.isLoading) return <LoadingCard />;
  if (preferences.isError || channels.isError || !preferences.data || !channels.data) return <ErrorCard />;

  // Which events a chat receives is editable — the API has always accepted it,
  // the table just never offered it. Each tick is one write, so there is no
  // half-saved state to reconcile.
  const toggleChannelEvent = async (c: NotificationChannel, event: NotificationEvent, on: boolean) => {
    const next = toggleEvent(c.events, event, on);
    if (next.length === 0) { toast('A chat needs at least one event, or pause it instead.'); return; }
    try {
      await setChannelEvents.mutateAsync({ id: c.id, events: next });
    } catch (err) {
      toast(errorMessage(err, 'Could not change what this chat receives.'));
    }
  };

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

  const confirmRemove = async (channel: NotificationChannel) => {
    try {
      await deleteChannel.mutateAsync(channel.id);
      setRemoving(null);
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
                <tr>
                  <th scope="col">Chat</th>
                  <th scope="col">Events</th>
                  <th scope="col">Status</th>
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {channels.data.channels.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <div className="cname">{c.label || c.target}</div>
                      <div className="cemail">{c.target}</div>
                    </td>
                    <td>
                      {editable ? (
                        <div className="controls">
                          {channels.data.availableEvents.map((e) => (
                            <label key={e} className="check-row inline">
                              <input
                                type="checkbox"
                                checked={c.events.includes(e)}
                                disabled={setChannelEvents.isPending}
                                onChange={(ev) => toggleChannelEvent(c, e, ev.target.checked)}
                              />
                              <span>{NOTIFICATION_EVENT_LABELS[e]}</span>
                            </label>
                          ))}
                        </div>
                      ) : c.events.map((e, i) => (
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
                          <div className="cemail" title={c.lastError}>{c.lastError}</div>
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
                          <button className="btn ghost small" onClick={() => setRemoving(c)}>Remove</button>
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

      <Modal
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={removing ? `Remove ${removing.label || removing.target}?` : ''}
        subtitle="Notifications to this chat stop immediately. To restore it you have to paste the chat ID again."
      >
        {removing && (
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setRemoving(null)}>Keep</button>
            <button className="btn danger" disabled={deleteChannel.isPending} onClick={() => confirmRemove(removing)}>
              {deleteChannel.isPending ? 'Removing…' : 'Remove chat'}
            </button>
          </div>
        )}
      </Modal>
    </div>
  );
}

function PreferencesCard({ preferences, onSave }: {
  preferences: NotificationPreferences;
  onSave: (events: NotificationEvent[]) => Promise<unknown>;
}) {
  const [events, setEvents] = useState<NotificationEvent[]>(preferences.events);
  const [isSaving, setIsSaving] = useState(false);
  const saved = [...preferences.events].sort().join();
  useUnsavedChanges('notification-preferences', [...events].sort().join() !== saved);

  const save = async () => {
    setIsSaving(true);
    try {
      await onSave(events);
      toast('Notification preferences saved.');
    } catch (err) {
      toast(errorMessage(err, 'Could not save your preferences.'));
    } finally {
      setIsSaving(false);
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
        <label className="setrow" key={event}>
          <div className="k">{NOTIFICATION_EVENT_LABELS[event]}</div>
          <input type="checkbox" checked={events.includes(event)}
            onChange={(e) => setEvents(toggleEvent(events, event, e.target.checked))} />
        </label>
      ))}
      <div className="actions-right">
        <button className="btn" onClick={save} disabled={isSaving}>
          {isSaving ? 'Saving…' : 'Save my preferences'}
        </button>
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
  const [isConnecting, setIsConnecting] = useState(false);
  useUnsavedChanges('telegram-chat', target.trim() !== '' || label.trim() !== '');

  const connect = async () => {
    if (!target.trim()) { toast('Paste the Telegram chat ID.'); return; }
    if (events.length === 0) { toast('Pick at least one event.'); return; }
    setIsConnecting(true);
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
    } finally {
      setIsConnecting(false);
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
        <button className="btn" onClick={connect} disabled={isConnecting}>
          {isConnecting ? 'Connecting…' : 'Connect chat'}
        </button>
      </div>
    </>
  );
}
