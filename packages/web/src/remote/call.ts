// Phone page transport: everything goes to /remote-api/v1 with the device cookie.
export class RemoteError extends Error {
  constructor(readonly status: number, readonly code: string, readonly detail?: string) { super(code); }
}
export async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch('/remote-api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'x-blackhole-web': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  if (!res.ok) throw new RemoteError(res.status, data?.error ?? `http_${res.status}`, data?.message);
  // A cut-off or non-JSON body on a flaky phone link is a failed poll, never an empty result.
  if (!data || typeof data !== 'object') throw new RemoteError(res.status, 'bad_response');
  return data as T;
}
