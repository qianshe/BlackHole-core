// One shared poll of the Courier state for the whole console. The sidebar, the new-session
// pane and the chat dock all read it, so the page asks the daemon once per tick instead of
// once per component. Paused while the tab is hidden; resumes with a fetch when shown.

const URL_CACHED = '/web-api/v1/courier?cached=1';
const URL_FRESH = '/web-api/v1/courier';
const HEAD = { 'x-blackhole-web': '1' };
export const COURIER_POLL_MS = 3000;

/** The /courier response; each reader picks the fields it needs. */
export interface CourierState {
  connected: boolean;
  targets?: Array<{ sessionId: string | null; busy: boolean | null } & Record<string, unknown>>;
  links?: Record<string, string>;
  sites?: Array<{ id: string; name: string } & Record<string, unknown>>;
  asking?: string[];
}
type Listener = (st: CourierState | null) => void;

const listeners = new Set<Listener>();
let last: CourierState | null | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let inflight: Promise<CourierState | null> | null = null;

async function fetchState(fresh: boolean): Promise<CourierState | null> {
  try {
    const r = await fetch(fresh ? URL_FRESH : URL_CACHED, { credentials: 'same-origin', cache: 'no-store', headers: HEAD });
    if (!r.ok) return null;
    return (await r.json()) as CourierState;
  } catch {
    return null;
  }
}

function schedule(): void {
  clearTimeout(timer);
  timer = undefined;
  if (listeners.size && !document.hidden) timer = setTimeout(() => void refreshCourier(), COURIER_POLL_MS);
}

/**
 * Fetch now and hand the result to every reader. Plain refreshes share an in-flight request;
 * `fresh` asks Courier for a new list instead of the pushed one.
 */
export function refreshCourier(fresh = false): Promise<CourierState | null> {
  if (inflight && !fresh) return inflight;
  const p = fetchState(fresh).then((st) => {
    last = st;
    for (const fn of listeners) fn(st);
    return st;
  });
  const shared = p.finally(() => {
    if (inflight === shared) inflight = null;
    schedule();
  });
  if (!fresh) inflight = shared;
  return shared;
}

function onVisible(): void {
  if (!document.hidden) void refreshCourier();
  else schedule();
}

/** Receive every Courier state; the first reader starts the poll, the last one stops it. */
export function subscribeCourier(fn: Listener): () => void {
  listeners.add(fn);
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', onVisible);
    void refreshCourier();
  } else if (last !== undefined) {
    fn(last);
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size) {
      clearTimeout(timer);
      timer = undefined;
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}
