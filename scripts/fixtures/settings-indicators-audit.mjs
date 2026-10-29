// Self-contained DOM audit for the real shared settings renderer, with synthetic data only.
export async function auditSettingsIndicators() {
  const checks = [], errors = [], measurements = [];
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (name, ok) => { checks.push(name); if (!ok) errors.push(name); };
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const centre = rect => rect.top + rect.height / 2;
  const page = async name => {
    const button = document.querySelector('[data-settings-target="' + name + '"]');
    if (!visible(button)) document.querySelector('button[aria-controls="settingsNav"][aria-expanded="false"]')?.click();
    await wait(40); button?.click(); await wait(140);
  };
  const until = async fn => { for (let i = 0; i < 80; i++) { if (fn()) return; await wait(50); } throw Error('Indicator fixture did not become ready'); };
  const dots = context => {
    const list = [...document.querySelectorAll('.bhp .status-dot, .bhp .ck-v > .d, .bhp .pxb > .d, .bhp .agchip > .d')].filter(visible);
    for (const dot of list) {
      const parent = dot.parentElement, d = dot.getBoundingClientRect(), p = parent.getBoundingClientRect(), css = getComputedStyle(dot);
      const label = parent.querySelector('.status-label, .home-account-name');
      const offset = centre(d) - centre(p), textOffset = label ? centre(d) - centre(label.getBoundingClientRect()) : null;
      const name = context + ': ' + parent.textContent.trim().slice(0, 60);
      measurements.push({ name, offset, textOffset, margin: css.margin, size: [d.width, d.height] });
      check(name + ' dot is centred', Math.abs(offset) <= .5);
      if (textOffset !== null) check(name + ' dot matches label centre', Math.abs(textOffset) <= .5);
      check(name + ' no description margin', css.margin === '0px');
      check(name + ' round non-shrinking dot', Math.abs(d.width - d.height) < .1 && d.width >= 6 && d.width <= 7.1 && css.flexShrink === '0');
      check(name + ' decorative dot is hidden from accessibility tree', dot.getAttribute('aria-hidden') === 'true');
      if (parent.classList.contains('pxb')) check(name + ' dot retains status colour', css.backgroundColor === getComputedStyle(parent).color);
    }
    return list.length;
  };
  const icons = context => {
    for (const svg of [...document.querySelectorAll('.settings-shell button svg, .settings-shell .scan-icon svg')].filter(visible)) {
      const owner = svg.closest('button') || svg.parentElement, s = svg.getBoundingClientRect(), b = owner.getBoundingClientRect();
      check(context + ': icon centred in ' + (owner.getAttribute('aria-label') || owner.textContent.trim()), Math.abs(centre(s) - centre(b)) <= .5);
      check(context + ': icon is not distorted', Math.abs(s.width - s.height) <= .5);
    }
  };
  const overflow = context => {
    const shell = document.querySelector('.settings-shell');
    check(context + ': no horizontal overflow', document.documentElement.scrollWidth <= innerWidth && shell.scrollWidth <= shell.clientWidth + 1);
  };
  const before = window.__model.calls.length;
  try {
    await page('home'); await until(() => document.querySelector('.cockpit [role="switch"]'));
    check('home has both account and channel indicators', dots('home') === 2); icons('home'); overflow('home');
    await page('connections'); icons('connections'); overflow('connections');
    for (const hint of [...document.querySelectorAll('.chrow > .hint, .btnrow > .hint')].filter(visible)) {
      check('inline helper does not inherit paragraph margin', getComputedStyle(hint).marginTop === '0px');
    }
    window.__model.setStatusCases(true);
    await page('agents'); await until(() => document.querySelectorAll('.pxs .pxb').length === 8);
    check('all MCP states and semantic-mode indicators are rendered', dots('agents') === 11);
    const labels = [...document.querySelectorAll('.pxs .pxb')].map(el => el.textContent.trim());
    for (const text of ['在线', '已停用', '启动中…', '等待启动', '工具异常', '启动失败', '配置错误']) check('state present: ' + text, labels.includes(text));
    for (const row of document.querySelectorAll('.pxs')) check('long MCP name fits: ' + row.querySelector('.nm').textContent, row.scrollWidth <= row.clientWidth + 1);
    icons('agents'); overflow('agents');
    const descriptions = [...document.querySelectorAll('.f > .d')].filter(visible);
    check('field descriptions retain their spacing', descriptions.length > 0 && descriptions.every(el => getComputedStyle(el).marginTop === '4px'));
    for (const name of ['network', 'security', 'account', 'advanced']) { await page(name); icons(name); overflow(name); }
    check('status inspection never writes business settings', window.__model.calls.length === before);
    check('no external service request', window.__model.blocked.length === 0);
    check('no duplicate IDs', (() => { const ids = [...document.querySelectorAll('[id]')].map(el => el.id); return ids.length === new Set(ids).size; })());
  } finally { window.__model.setStatusCases(false); await page('agents'); }
  return { pass: !errors.length, checks: checks.length, errors, measurements, viewport: [innerWidth, innerHeight] };
}
