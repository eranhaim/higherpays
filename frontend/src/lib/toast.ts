/**
 * Tiny pub/sub for the toast. `toast()` can be called from anywhere (event
 * handlers, mutations); `<ToastContainer>` subscribes once and renders.
 */

type Listener = (message: string) => void;

let listener: Listener | null = null;

/** Shows a short, non-blocking message at the bottom of the screen. */
export function toast(message: string) {
  listener?.(message);
}

export function subscribeToast(next: Listener): () => void {
  listener = next;
  return () => { if (listener === next) listener = null; };
}
