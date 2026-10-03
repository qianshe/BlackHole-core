import { useEffect, useRef, useState } from 'react';
import { SettingsPanel } from '../panel/SettingsPanel';
import { SETTINGS_SECTIONS, type SettingsSection } from '../format';
import { Icon } from '../ui';
import { Modal } from './common';
import c from './console.module.css';

const LABEL: Record<SettingsSection, string> = {
  overview: '概览',
  account: '账号与订阅',
  channel: '公网渠道',
  mcp: 'MCP 连接',
  common: '常用',
  grants: '授权管理',
  proxies: 'MCP Proxies',
  advanced: '高级',
};

const target = (root: HTMLElement | null, id: SettingsSection): HTMLElement | null => root?.querySelector<HTMLElement>(`#set-${id}`) ?? null;

export function SettingsModal({ section, onSection, onClose }: { section: string; onSection: (s: SettingsSection) => void; onClose: () => void }) {
  const body = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<SettingsSection>((SETTINGS_SECTIONS as readonly string[]).includes(section) ? (section as SettingsSection) : 'overview');
  const jumping = useRef(false);

  const go = (id: SettingsSection, smooth = true): void => {
    const el = target(body.current, id);
    setActive(id);
    onSection(id);
    if (!el) return;
    if (el instanceof HTMLDetailsElement) el.open = true;
    jumping.current = true;
    el.scrollIntoView({ behavior: smooth ? 'smooth' : 'instant', block: 'start' }); // 'auto' would follow the CSS smooth scrolling
    setTimeout(() => (jumping.current = false), smooth ? 600 : 50);
  };

  // open at the requested section once the panel has rendered its sections
  useEffect(() => {
    let tries = 0;
    const id = setInterval(() => {
      tries++;
      if (target(body.current, active) || tries > 30) {
        clearInterval(id);
        if (active !== 'overview') go(active, false);
      }
    }, 50);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus the scrolling body (after Modal's showModal focus) so arrow keys and PageDown
  // scroll the settings, not the first nav button.
  useEffect(() => { body.current?.focus({ preventScroll: true }); }, []);

  // scrollspy: the last section whose top has passed the sticky header
  const onScroll = (): void => {
    if (jumping.current || !body.current) return;
    const top = body.current.getBoundingClientRect().top + 90;
    let cur: SettingsSection = 'overview';
    for (const id of SETTINGS_SECTIONS) {
      const el = target(body.current, id);
      if (el && el.getBoundingClientRect().top <= top) cur = id;
    }
    // The last sections are too short to reach the header: at the bottom, the last one is current.
    const b = body.current;
    if (b.scrollTop > 0 && b.scrollTop + b.clientHeight >= b.scrollHeight - 4) cur = SETTINGS_SECTIONS[SETTINGS_SECTIONS.length - 1] ?? cur;
    if (cur !== active) {
      setActive(cur);
      onSection(cur);
    }
  };

  return (
    <Modal label="设置" onClose={onClose} className={c.modal}>
      <nav className={c.settingsNav} aria-label="设置分区">
        <h2>设置</h2>
        <ul>
          {SETTINGS_SECTIONS.map((id) => (
            <li key={id}>
              <button type="button" className={c.settingsNavBtn} aria-current={active === id ? 'true' : undefined} onClick={() => go(id)}>
                {LABEL[id]}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className={c.settingsContent} ref={body} tabIndex={-1} onScroll={onScroll}>
        <div className={c.settingsHead}>
          <h2>{LABEL[active]}</h2>
          <button type="button" className={c.close} aria-label="关闭设置" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className={c.settingsBody}>
          <SettingsPanel />
        </div>
      </div>
    </Modal>
  );
}
