import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordSessionActivity, SESSION_ACTIVITY_KEY, SESSION_IDLE_MS, startSessionIdleMonitor } from './sessionIdle';

describe('session inactivity', () => {
  let browser: EventTarget;
  let values: Map<string, string>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    values = new Map();
    browser = new EventTarget();
    Object.assign(browser, {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    vi.stubGlobal('window', browser);
    vi.stubGlobal('document', new EventTarget());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('ends the session after six hours with no interaction', () => {
    const onIdle = vi.fn();
    const stop = startSessionIdleMonitor(onIdle);
    vi.advanceTimersByTime(SESSION_IDLE_MS - 1);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledOnce();
    stop();
  });

  it('starts a new six-hour window after a user action', () => {
    const onIdle = vi.fn();
    const stop = startSessionIdleMonitor(onIdle);
    vi.advanceTimersByTime(5 * 60 * 60 * 1000);
    browser.dispatchEvent(new Event('keydown'));
    vi.advanceTimersByTime(SESSION_IDLE_MS - 1);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledOnce();
    stop();
  });

  it('honours activity from another tab', () => {
    const onIdle = vi.fn();
    const stop = startSessionIdleMonitor(onIdle);
    vi.advanceTimersByTime(5 * 60 * 60 * 1000);
    recordSessionActivity();
    const storage = new Event('storage');
    Object.defineProperty(storage, 'key', { value: SESSION_ACTIVITY_KEY });
    browser.dispatchEvent(storage);
    vi.advanceTimersByTime(SESSION_IDLE_MS - 1);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledOnce();
    stop();
  });

  it('expires an idle session when a previously closed tab is reopened', () => {
    recordSessionActivity();
    vi.advanceTimersByTime(SESSION_IDLE_MS);
    const onIdle = vi.fn();
    const stop = startSessionIdleMonitor(onIdle);
    expect(onIdle).toHaveBeenCalledOnce();
    stop();
  });
});
