// Loaded ONLY by isolated Node test children. Synthetic cloud session provider;
// no network access to any real HTTPS service or mutation of OS secrets.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.protocol === 'https:' && url.pathname === '/api/auth/plugin/session') {
    const expected = 'Bearer ' + 'bhp_' + 'a'.repeat(43);
    if (init?.headers?.Authorization !== expected)
      return Response.json({ error: 'rejected' }, { status: 401 });
    return Response.json({
      userId: 'user_1', clientId: 'c'.repeat(22),
      sessionId: '11111111-2222-4333-8444-555555555555',
      expiresAt: Number(process.env.WEB_TEST_AUTH_EXPIRES_AT), loginOrder: 7,
    });
  }
  if (url.protocol === 'https:' && url.pathname === '/api/auth/plugin/logout')
    return new Response(null, { status: 204 });
  if (url.protocol === 'https:') throw Error('external_cloud_network_forbidden_in_test');
  return originalFetch(input, init);
};
