import { ProxyAgent, fetch as undiciFetch } from 'undici';

/**
 * Run one bounded HTTP workflow through an optional proxy without mutating
 * process.env or globalThis.fetch. The agent is closed before returning.
 */
export async function withProxyFetch<T>(
  proxy: string | undefined,
  task: (fetchFile: typeof fetch) => Promise<T>,
): Promise<T> {
  const value = proxy?.trim();
  if (!value) return task(globalThis.fetch);
  const dispatcher = new ProxyAgent(value);
  const fetchFile = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    return await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    }) as unknown as Response;
  }) as typeof fetch;
  try {
    return await task(fetchFile);
  } finally {
    try { await dispatcher.close(); } catch { /* best-effort cleanup */ }
  }
}
