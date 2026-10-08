import { settingsHost } from '../settings/host';
import '../settings/shared.css';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { SettingsPanel } from '../panel/SettingsPanel';
import type { AccountView } from '../api';
import { SETTINGS_SECTIONS, type SettingsSection } from '../format';
import { Icon, SettingsIcon } from '../ui';
import { Modal } from './common';
import c from './console.module.css';
import { renderSettingsNavItems, SETTINGS_LABELS } from '../../../contracts/src/settings-navigation';

const LABEL = SETTINGS_LABELS;

const COLLAPSED_KEY = 'blackhole.settingsNavCollapsed.v1';
const PAGE_KEY = 'blackhole.settingsLastPage.v1';
const validPage = (value: string | null | undefined): value is SettingsSection => !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
const stored = (key: string): string | null => { const host = settingsHost(); if (host.readState) return host.readState(key); try { return localStorage.getItem(key); } catch { return null; } };
const save = (key: string, value: string): void => { const host = settingsHost(); if (host.saveState) { host.saveState(key, value); return; } try { localStorage.setItem(key, value); } catch { /* browser storage unavailable */ } };

export function SettingsModal({ section, account, onAccountChange, refreshAccount, onSignOut, onSection, onClose }: {
  section: string;
  account: AccountView | null;
  onAccountChange: (view: AccountView | null) => void;
  refreshAccount: () => Promise<AccountView | null>;
  onSignOut: () => void;
  onSection: (s: SettingsSection) => void;
  onClose: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const nav = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawerWasOpen = useRef(false);
  const savedPage = stored(PAGE_KEY);
  const first: SettingsSection = validPage(section) ? section : validPage(savedPage) ? savedPage : 'home';
  const [active, setActive] = useState<SettingsSection>(first);
  const [collapsed, setCollapsed] = useState(() => stored(COLLAPSED_KEY) === '1');
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 720px)').matches);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 720px)');
    const change = () => { setNarrow(mq.matches); setDrawerOpen(false); };
    mq.addEventListener('change', change);
    return () => mq.removeEventListener('change', change);
  }, []);

  useEffect(() => {
    if (!validPage(section) || section === active) return;
    setActive(section);
    save(PAGE_KEY, section);
    body.current?.scrollTo({ top: 0 });
  }, [section, active]);

  useEffect(() => { body.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    if (!narrow) { drawerWasOpen.current = drawerOpen; return; }
    if (drawerOpen && !drawerWasOpen.current) nav.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus();
    else if (!drawerOpen && drawerWasOpen.current) menuButton.current?.focus();
    drawerWasOpen.current = drawerOpen;
  }, [drawerOpen, narrow]);

  const go = (id: SettingsSection): void => {
    setActive(id);
    save(PAGE_KEY, id);
    onSection(id);
    body.current?.scrollTo({ top: 0 });
    if (narrow) setDrawerOpen(false);
  };

  const toggle = (): void => {
    if (narrow) { setDrawerOpen((value) => !value); return; }
    setCollapsed((value) => {
      const next = !value;
      save(COLLAPSED_KEY, next ? '1' : '0');
      return next;
    });
  };
  const closeDrawer = (): void => setDrawerOpen(false);
  const handleModalClose = (): void => {
    if (narrow && drawerOpen) { closeDrawer(); return; }
    onClose();
  };
  const navItems = renderSettingsNavItems({
    page: active,
    collapsed: !narrow && collapsed,
    buttonClassName: c.settingsNavBtn ?? '',
    iconClassName: c.settingsNavIcon ?? '',
    labelClassName: c.settingsNavLabel ?? '',
  });
  const selectNavPage = (event: MouseEvent<HTMLUListElement>): void => {
    const page = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-settings-target]')?.dataset.settingsTarget;
    if (validPage(page)) go(page);
  };

  return (
    <Modal label="设置" onClose={handleModalClose} className={'settings-shell ' + c.modal + (active === 'home' ? ' settings-shell-home' : '') + (collapsed && !narrow ? ' settings-shell-collapsed ' + c.settingsModalCollapsed : '')}>
      <nav ref={nav} id="settingsNav" className={c.settingsNav + (!narrow && collapsed ? ' ' + c.settingsNavCollapsed : '') + (narrow && drawerOpen ? ' ' + c.settingsNavOpen : '')} aria-label="设置分区" aria-hidden={narrow && !drawerOpen}>
        <div className={c.settingsNavHead}>
          <h2>{collapsed ? '' : '设置'}</h2>
          <button type="button" className={c.settingsNavToggle} aria-label={collapsed ? '展开设置菜单' : '收起设置菜单'} title={collapsed ? '展开设置菜单' : '收起设置菜单'} aria-controls="settingsNav" aria-expanded={!collapsed} onClick={toggle}>
            <SettingsIcon name="sidebar" size={15} />
          </button>
        </div>
        <ul hidden={narrow && !drawerOpen} onClick={selectNavPage} dangerouslySetInnerHTML={{ __html: navItems }} />
      </nav>
      <button type="button" className={c.settingsScrim} aria-hidden="true" tabIndex={-1} hidden={!narrow || !drawerOpen} onClick={closeDrawer} />
      <div className={c.settingsContent} ref={body} tabIndex={-1}>
        <div className={c.settingsHead}>
          {narrow && (
            <button ref={menuButton} type="button" className={c.settingsPageMenu} aria-label={drawerOpen ? '关闭设置菜单' : '打开设置菜单'} aria-controls="settingsNav" aria-expanded={drawerOpen} onClick={toggle}>
              <SettingsIcon name={drawerOpen ? 'close' : 'menu'} size={18} />
            </button>
          )}
          <h2>{LABEL[active]}</h2>
          <button type="button" className={c.close} aria-label="关闭设置" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className={c.settingsBody}>
          <SettingsPanel page={active} account={account} onAccountChange={onAccountChange} refreshAccount={refreshAccount} onSignOut={onSignOut} onNavigate={go} />
        </div>
      </div>
    </Modal>
  );
}
