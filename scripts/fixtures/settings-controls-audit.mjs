// Run against BOTH real settings renderer bundles with createSettingsPreview(..., {controls:true}).
// Self-contained so the operator's browser tool can evaluate this function without dependencies.
export async function auditSettingsControls({ interactions = false } = {}) {
  const errors = [], measurements = [], checks = [];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (name, ok) => { checks.push(name); if (!ok) errors.push(name); };
  const until = async (fn, name) => {
    for (let i = 0; i < 70; i++) { if (fn()) return; await sleep(50); }
    throw Error('Timed out: ' + name);
  };
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const page = async name => {
    const button = document.querySelector('[data-settings-target="' + name + '"]');
    if (!visible(button)) document.querySelector('button[aria-controls="settingsNav"][aria-expanded="false"]')?.click();
    await sleep(30); button?.click(); await sleep(100);
  };
  const measure = (el, label) => {
    const css = getComputedStyle(el), rect = el.getBoundingClientRect();
    const knob = getComputedStyle(el, '::after');
    const result = { label, width: rect.width, height: rect.height, padding: css.padding, radius: css.borderRadius,
      background: css.backgroundColor, color: css.color, opacity: css.opacity, minHeight: css.minHeight,
      knobWidth: knob.width, knobHeight: knob.height, knobLeft: knob.left, knobTransform: knob.transform,
      checked: el.getAttribute('aria-checked'), disabled: el.disabled };
    measurements.push(result); return result;
  };
  const switchShape = (el, label) => {
    const m = measure(el, label);
    check(label + ': 30x16 track', Math.abs(m.width - 30) < .5 && Math.abs(m.height - 16) < .5);
    check(label + ': no button padding', m.padding === '0px');
    check(label + ': pill radius', parseFloat(m.radius) >= 16);
    check(label + ': 12px round thumb', m.knobWidth === '12px' && m.knobHeight === '12px');
    check(label + ': thumb anchored at 2px', m.knobLeft === '2px');
    return m;
  };
  const bounds = el => el?.getBoundingClientRect();
  const center = el => { const r = bounds(el); return r ? r.top + r.height / 2 : NaN; };
  const close = (a, b, epsilon = 1) => Math.abs(a - b) <= epsilon;
  const startWrites = window.__model.calls.length;
  // The title and Close control belong to one sticky modal header, not the scrolling page.
  // Assert every section in both host renderers and narrow/desktop layouts.
  const mainScroller = document.querySelector('.settings-shell > div[tabindex]');
  const modalHeader = mainScroller?.firstElementChild;
  const heading = modalHeader?.querySelector('h2');
  const closeButton = modalHeader?.querySelector('button[aria-label="关闭设置"]');
  const menuButton = modalHeader?.querySelector('button[aria-controls="settingsNav"]');
  const isNarrow = matchMedia('(max-width:720px)').matches;
  const navHead = document.querySelector('#settingsNav [class*="settingsNavHead"]');
  if (mainScroller) mainScroller.style.scrollBehavior = 'auto';
  for (const key of ['home', 'connections', 'network', 'agents', 'security', 'account', 'advanced']) {
    await page(key);
    if (mainScroller) mainScroller.scrollTop = 0;
    await sleep(20);
    const bodyPane = document.querySelector('.settings-shell .bhp');
    check(key + ': title equals active navigation label',
      heading?.textContent.trim() === document.querySelector('[data-settings-target="' + key + '"]')?.textContent.trim());
    check(key + ': title and close share a baseline', Math.abs(center(heading) - center(closeButton)) < 1.5);
    check(key + ': consistent header height', Math.abs((bounds(modalHeader)?.height ?? 0) - (isNarrow ? 56 : 64)) < 1);
    check(key + ': close sits in the right inset',
      close(bounds(modalHeader)?.right ?? NaN, (bounds(closeButton)?.right ?? NaN) + (isNarrow ? 12 : 16), 1.2));
    if (isNarrow) {
      check(key + ': menu and page title share top row', visible(menuButton) && close(center(menuButton), center(heading), 1.5)
        && (bounds(heading)?.left ?? NaN) >= (bounds(menuButton)?.right ?? NaN) + 6);
    } else {
      check(key + ': desktop title aligns with form content and sidebar header',
        close(bounds(heading)?.left ?? NaN, bounds(bodyPane)?.left ?? NaN, 1.2)
        && close(center(navHead), center(heading), 1.5));
    }
  }
  await page('agents');
  if (mainScroller && modalHeader && closeButton) {
    const previousY = bounds(modalHeader)?.top ?? NaN;
    const previousCloseY = center(closeButton);
    const previousScroll = mainScroller.scrollTop;
    mainScroller.scrollTop = mainScroller.scrollHeight;
    await sleep(30);
    const changed = mainScroller.scrollTop > previousScroll + 3;
    const clickable = document.elementFromPoint((bounds(closeButton)?.left ?? 0) + 16, center(closeButton))?.closest('button') === closeButton;
    check('scroll keeps title and Close fixed at the top', changed
      && close(bounds(modalHeader)?.top ?? NaN, previousY, 1.2)
      && close(center(closeButton), previousCloseY, 1.2));
    check('close remains clickable over scrolled content', clickable);
    mainScroller.scrollTop = 0;
    mainScroller.style.scrollBehavior = '';
  } else check('settings header exists', false);
  await page('home');
  await until(() => document.querySelector('.cockpit [role="switch"]'), 'home channel switch');
  const home = switchShape(document.querySelector('.cockpit [role="switch"]'), 'home');
  // Cockpit uses the same two-line hierarchy in Web and VS Code: heading + metric,
  // followed by status/identity + actions. Keep it aligned even with long strings.
  const accountHead = document.querySelector('.home-account-head');
  const accountTitle = accountHead?.querySelector('.ck-k');
  const accountRemaining = document.querySelector('.home-account-remaining');
  const accountRow = document.querySelector('.home-account-row');
  const accountName = document.querySelector('.home-account-name');
  const logout = document.querySelector('.home-signout');
  const channelHead = document.querySelector('.home-channel .ck-head');
  const activityHead = document.querySelector('.activity-head.ck-head');
  const activityMetric = document.querySelector('.activity-today.ck-summary');
  const right = el => bounds(el)?.right ?? NaN;
  check('home account keeps one heading row and one identity row', accountHead?.parentElement === accountRow?.parentElement && accountHead?.parentElement?.children.length === 2);
  check('all cockpit headings share the same height', [accountHead, channelHead, activityHead].every(el => bounds(el) && close(bounds(el).height, 18, .3)));
  check('remaining time is right-aligned in the account heading', close(right(accountHead), right(accountRemaining)) && center(accountRemaining) === center(accountRemaining) && close(center(accountTitle), center(accountRemaining), .7));
  check('activity today is right-aligned in its heading', close(right(activityHead), right(activityMetric)) && close(center(activityHead.querySelector('.ck-k')), center(activityMetric), .7));
  check('logout stays on the identity line, not on the heading', logout ? accountRow?.contains(logout) && !accountHead?.contains(logout) : true);
  if (accountName && accountRemaining && accountTitle && accountRow) {
    const savedName = accountName.textContent, savedRemaining = accountRemaining.textContent;
    try {
      accountName.textContent = 'very.long.account.identifier+suffix@example.invalid';
      accountRemaining.textContent = '剩余 128 天 23 小时';
      check('long username cannot overlap logout', !logout || bounds(accountName).right <= bounds(logout).left);
      check('long time cannot overlap heading label', bounds(accountRemaining).left >= bounds(accountTitle).right + 4);
      check('long time stays within account heading', close(right(accountHead), right(accountRemaining)) && accountHead.scrollWidth <= accountHead.clientWidth + 1);
      check('long account state keeps the page within the viewport', document.documentElement.scrollWidth <= innerWidth + 1);
    } finally {
      accountName.textContent = savedName;
      accountRemaining.textContent = savedRemaining;
    }
  } else check('account layout controls exist', false);
  await page('network');
  await until(() => document.getElementById('directAccessToggle'), 'direct switch');
  const direct = switchShape(document.getElementById('directAccessToggle'), 'direct');
  await page('agents');
  await until(() => document.querySelectorAll('.pxs .pxsw').length === 3, 'populated MCP rows');
  const proxySwitches = [...document.querySelectorAll('.pxs .pxsw')];
  const proxies = proxySwitches.map((el, i) => switchShape(el, 'MCP-' + i));
  check('same on colour across home and MCP', home.background === proxies[0].background);
  check('same off colour across direct and MCP', direct.background === proxies[1].background);
  const tools = document.querySelector('.pxs button.pchip'), chip = measure(tools, 'tool count');
  check('tool count is a 28px pill', Math.abs(chip.height - 28) < .5 && parseFloat(chip.radius) >= 28);
  const primary = getComputedStyle(document.querySelector('.bhp')).getPropertyValue('--vscode-button-background').trim();
  const colour = document.createElement('span'); colour.style.color = primary; document.body.append(colour);
  check('tool count is not a solid primary action', chip.background !== getComputedStyle(colour).color); colour.remove();
  for (const el of document.querySelectorAll('.pxbtns button.pxe')) {
    const m = measure(el, el.classList.contains('danger') ? 'delete' : 'edit');
    check(m.label + ': compact action height', Math.abs(m.height - 28) < .5);
  }
  check('visiting pages does not write', window.__model.calls.length === startWrites);
  const shell = document.querySelector('.settings-shell');
  check('no horizontal page overflow', document.documentElement.scrollWidth <= innerWidth && shell.scrollWidth <= shell.clientWidth + 1);
  check('no horizontal MCP row overflow', [...document.querySelectorAll('.pxs')].every(el => el.scrollWidth <= el.clientWidth + 1));
  check('no duplicate IDs', (() => { const ids = [...document.querySelectorAll('[id]')].map(el => el.id); return ids.length === new Set(ids).size; })());
  if (interactions) {
    tools.focus(); tools.click();
    await until(() => document.querySelector('.pxmbox [name="px-tool-enabled"]'), 'tool list');
    check('tool count opens the real tool dialog', document.querySelectorAll('.pxmbox [name="px-tool-enabled"]').length === 29);
    check('viewing tools does not write proxy config', !window.__model.calls.slice(startWrites).some(c => c.path === '/proxies/config/fields'));
    document.querySelector('.pxmhd button')?.click();
    const target = proxySwitches[1], before = window.__model.calls.length;
    target.focus(); target.click(); await sleep(40);
    switchShape(target, 'MCP-saving'); check('saving switch disabled', target.disabled);
    target.click();
    await until(() => target.getAttribute('aria-checked') === 'true' && !target.disabled, 'MCP enabled');
    await sleep(180);
    switchShape(target, 'MCP-enabled');
    check('focused switch regains focus after save', document.activeElement === target);
    check('one click saves only the selected MCP', (() => { const writes = window.__model.calls.slice(before).filter(c => c.path === '/proxies/config/fields'); return writes.length === 1 && writes[0].body.server === 'open-computer-use' && writes[0].body.fields.enabled === true; })());
    target.click(); tools.focus(); await until(() => target.getAttribute('aria-checked') === 'false' && !target.disabled, 'MCP restored');
    check('saving does not steal a deliberately moved focus', document.activeElement === tools);
    const remove = document.querySelector('.pxbtns .danger'); remove.click();
    await until(() => [...document.querySelectorAll('dialog[open]')].length > 1, 'delete confirmation');
    const lastDialog = [...document.querySelectorAll('dialog[open]')].at(-1);
    [...lastDialog.querySelectorAll('button')].find(el => el.textContent.trim() === '取消')?.click();
    check('cancel deletion does not delete', !window.__model.calls.slice(before).some(c => c.path === '/proxies/remove'));
    await page('home');
    const pairButton = document.getElementById('phonePair');
    check('pairing card has one semantic heading and no duplicate section', !!document.querySelector('.pair-card h3.pair-card-title') && !document.getElementById('set-phone'));
    check('single entry shows compact caption rather than a selector', !!document.querySelector('.pair-access-text') && !document.querySelector('.pair-access-row select'));
    check('routine detection control is absent', ![...document.querySelectorAll('.pair-card button')].some(el => /检测/.test(el.textContent)));
    check('opening settings does not probe phone network', !window.__model.calls.slice(startWrites).some(c => c.path === '/remote/probe'));
    if (pairButton && !pairButton.disabled) {
      const pairStart = window.__model.calls.length;
      pairButton.focus(); pairButton.click();
      await until(() => !!document.querySelector('.pair-dialog'), 'phone pairing dialog');
      const pairDialog = document.querySelector('.pair-dialog');
      check('pair dialog shows a real QR and countdown', !!pairDialog.querySelector('.bhp-qr') && /后过期/.test(pairDialog.querySelector('.pair-dialog-status')?.textContent || ''));
      check('active QR has no routine regeneration or done button', !pairDialog.querySelector('.pair-dialog-actions') && ![...pairDialog.querySelectorAll('button')].some(el => /完成|重新生成/.test(el.textContent)));
      const help = pairDialog.querySelector('details.pair-help');
      check('phone diagnostics start collapsed', !!help && !help.open);
      help?.querySelector('summary')?.click();
      check('diagnostics disclose a manual check without running it', !!help?.open && !!help.querySelector('button'));
      const writes = window.__model.calls.slice(pairStart);
      check('QR generation posts only a pairing request', writes.length === 1 && writes[0].path === '/remote/pair');
      pairDialog.querySelector('.pair-close')?.click();
      await sleep(40);
      check('closing QR restores focus to the generate button', document.activeElement === pairButton);
    } else check('pairing ready in fixture', false);
  }
  check('no external network in synthetic fixture', window.__model.blocked.length === 0);
  return { pass: errors.length === 0, viewport: [innerWidth, innerHeight], checks: checks.length, errors, measurements, calls: window.__model.calls.slice(startWrites) };
}
