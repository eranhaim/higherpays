/** Shared across tabs so activity in any open HigherPays tab keeps the session active. */
export const SESSION_ACTIVITY_KEY = 'higherpays.lastActivity';
export const SESSION_IDLE_MS = 6 * 60 * 60 * 1000;
const POINTER_WRITE_INTERVAL_MS = 1_000;

function readActivity(now: number): number | null {
  try {
    const value = Number(window.localStorage.getItem(SESSION_ACTIVITY_KEY));
    return Number.isFinite(value) && value > 0 && value <= now ? value : null;
  } catch {
    return null;
  }
}

export function recordSessionActivity(now = Date.now()): void {
  try { window.localStorage.setItem(SESSION_ACTIVITY_KEY, String(now)); } catch { /* storage may be unavailable */ }
}

/** Sign out after six hours without interaction, including after a tab resumes. */
export function startSessionIdleMonitor(onIdle: () => void): () => void {
  let lastActivity = readActivity(Date.now()) ?? Date.now();
  let lastPointerWrite = 0;
  let timer: number | undefined;
  let stopped = false;
  if (readActivity(Date.now()) === null) recordSessionActivity(lastActivity);

  const check = () => {
    if (stopped) return;
    const now = Date.now();
    lastActivity = Math.max(lastActivity, readActivity(now) ?? 0);
    if (now - lastActivity >= SESSION_IDLE_MS) {
      stopped = true;
      onIdle();
      return;
    }
    window.clearTimeout(timer);
    timer = window.setTimeout(check, SESSION_IDLE_MS - (now - lastActivity));
  };

  const activity = (event: Event) => {
    const now = Date.now();
    lastActivity = Math.max(lastActivity, readActivity(now) ?? 0);
    if (now - lastActivity >= SESSION_IDLE_MS) { check(); return; }
    lastActivity = now;
    if (event.type !== 'pointermove' || now - lastPointerWrite >= POINTER_WRITE_INTERVAL_MS) {
      recordSessionActivity(now);
      if (event.type === 'pointermove') lastPointerWrite = now;
    }
  };

  const onStorage = (event: StorageEvent) => {
    if (event.key === SESSION_ACTIVITY_KEY) check();
  };
  const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'focus'];
  for (const event of events) window.addEventListener(event, activity, { passive: true });
  window.addEventListener('storage', onStorage);
  document.addEventListener('visibilitychange', check);
  check();

  return () => {
    stopped = true;
    window.clearTimeout(timer);
    for (const event of events) window.removeEventListener(event, activity);
    window.removeEventListener('storage', onStorage);
    document.removeEventListener('visibilitychange', check);
  };
}
