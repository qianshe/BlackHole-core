// Synthetic Web host for the *production* shared settings renderer.
// Browser CI loads this from a local file; it never contacts a live daemon or Cloud.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsModal } from '../../src/console/SettingsModal';
import { installSettingsHost } from '../../src/settings/host';
import { ApiError } from '../../src/api';
import '../../src/global.css';

const model = (window as any).__model;
installSettingsHost({
  kind: 'web',
  request: async (path, init = {}) => {
    try {
      return await model.run(init.method || 'GET', path, typeof init.body === 'string' ? JSON.parse(init.body) : undefined);
    } catch (error: any) {
      throw new ApiError(error.status || 500, error.message);
    }
  },
  copy: async text => { model.copies.push(text); return true; },
});

function Preview() {
  const [page, setPage] = useState<any>('home');
  const [account, setAccount] = useState<any>(null);
  useEffect(() => { void model.run('GET', '/account').then(setAccount); }, []);
  return <SettingsModal section={page} account={account} onAccountChange={setAccount}
    refreshAccount={async () => account} onSignOut={() => { model.calls.push({ method: 'SIGNOUT' }); }}
    onSection={setPage} onClose={() => setPage('home')} />;
}

createRoot(document.getElementById('root')!).render(<Preview />);
