import { useCallback, useEffect, useRef, useState } from 'react';

/** Shared refresh cadence for every live view. */
export const POLL_MS = 3000;

export interface PollState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  updatedAt: number | null;
  refresh: () => void;
}

/**
 * Single-flight polling: the next request is scheduled only after the previous
 * one settles; a key change or unmount aborts the in-flight request. Hidden
 * tabs pause and refresh once when shown again.
 */
export function usePoll<T>(
  load: (signal: AbortSignal) => Promise<T>,
  key: string,
  intervalMs: number,
  enabled: boolean,
): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const kick = useRef<() => void>(() => undefined);

  useEffect(() => {
    setData(null);
    setError(null);
    setUpdatedAt(null);
  }, [key]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;

    const schedule = (): void => {
      if (disposed || !enabled) return;
      timer = setTimeout(run, intervalMs);
    };
    const run = (): void => {
      if (disposed || controller) return;
      clearTimeout(timer);
      if (document.hidden) return; // resumed by visibilitychange
      const current = new AbortController();
      controller = current;
      setLoading(true);
      loadRef
        .current(current.signal)
        .then((value) => {
          if (disposed || current.signal.aborted) return;
          setData(value);
          setError(null);
          setUpdatedAt(Date.now());
        })
        .catch((e: unknown) => {
          if (disposed || current.signal.aborted) return;
          setError(e);
        })
        .finally(() => {
          if (controller === current) controller = null;
          if (!disposed) {
            setLoading(false);
            schedule();
          }
        });
    };
    const onVisible = (): void => {
      if (!document.hidden) run();
    };

    kick.current = run;
    run();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, intervalMs, enabled]);

  const refresh = useCallback(() => kick.current(), []);
  return { data, error, loading, updatedAt, refresh };
}

/** Re-render on a fixed tick so relative times ("3 秒前") stay fresh. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
