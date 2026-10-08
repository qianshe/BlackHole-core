import { useEffect, useState } from 'react';
import { request } from '../api';
import { settingsHost, type SettingsHostInfo } from './host';

export function HostNotice() {
  const [info, setInfo] = useState<SettingsHostInfo | null>(null);
  useEffect(() => {
    if (settingsHost().kind !== 'vscode') return;
    let active = true;
    void request<SettingsHostInfo>('/host/info').then(value => { if (active) setInfo(value); }, () => undefined);
    return () => { active = false; };
  }, []);
  if (!info) return null;
  return <div className="host-notice" role="note">VS Code · {info.version}{info.environment === 'test' ? ` · 测试构建 · ${info.cloudOrigin}（账号与支付不代表正式环境）` : ''}</div>;
}
