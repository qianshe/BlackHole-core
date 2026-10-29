// Mermaid diagrams in rendered Markdown (markdown.ts marks closed ```mermaid fences with .md-mermaid).
// The single-file mermaid build (emitted by vite.config.ts, same file as the VS Code panel) loads on
// first use. The daemon's CSP is style-src 'self', which would strip the <style> inside mermaid's SVG,
// so the drawing is shown as an <img> data URI: an SVG image is its own inert document (no scripts)
// and keeps its styles. SVGs are cached by theme + source and applied synchronously on later renders,
// so a streaming re-render does not flicker. A diagram that fails to parse keeps its code block.
import { mermaidConfig } from '../../vscode/src/markdown';

type Mermaid = typeof import('mermaid').default;
declare const __MERMAID_JS__: string;

let api: Promise<Mermaid> | null = null;
let theme = '';
let seq = 0;
const cache = new Map<string, string>(); // theme + source -> img src ('' = failed)
const CACHE_MAX = 200;
const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
const currentTheme = (): 'dark' | 'default' => (darkQuery?.matches ? 'dark' : 'default');

function load(): Promise<Mermaid> {
  api ??= new Promise<Mermaid>((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = `${import.meta.env.BASE_URL}${__MERMAID_JS__}`;
    sc.onload = () => {
      const m = (window as unknown as { mermaid?: Mermaid }).mermaid;
      if (m) resolve(m); else reject(new Error('mermaid'));
    };
    sc.onerror = () => reject(new Error('mermaid'));
    document.head.append(sc);
  }).catch((err: unknown) => { api = null; throw err; }); // offline etc.: retry on a later render
  return api;
}

/** Give the SVG a fixed intrinsic size (its viewBox) so it scales as an image. */
function toImageSrc(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.nodeName !== 'svg') return '';
  const vb = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2]! > 0 && vb[3]! > 0) {
    root.setAttribute('width', String(Math.ceil(vb[2]!)));
    root.setAttribute('height', String(Math.ceil(vb[3]!)));
    root.removeAttribute('style');
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
}

function apply(block: HTMLElement, src: string): void {
  if (!src) { block.dataset.mm = 'fail'; return; }
  let fig = block.querySelector<HTMLElement>(':scope > .md-diagram');
  if (!fig) {
    fig = document.createElement('div');
    fig.className = 'md-diagram';
    fig.tabIndex = 0;
    fig.title = '点击放大';
    fig.setAttribute('role', 'button');
    const img = document.createElement('img');
    img.alt = 'Mermaid 图（点击放大）';
    fig.append(img);
    block.insertBefore(fig, block.querySelector(':scope > pre'));
  }
  const img = fig.querySelector('img')!;
  if (img.getAttribute('src') !== src) img.src = src;
  block.dataset.mm = 'ok';
}

/** Render every not-yet-handled diagram under `root`. */
export function renderDiagrams(root: ParentNode | null): void {
  if (!root) return;
  const blocks = root.querySelectorAll<HTMLElement>('.md-mermaid:not([data-mm])');
  if (blocks.length === 0) return;
  const t = currentTheme();
  const pending: { block: HTMLElement; source: string; key: string }[] = [];
  for (const block of blocks) {
    const source = block.querySelector('pre code')?.textContent ?? '';
    const key = `${t}\n${source}`;
    const hit = cache.get(key);
    if (hit !== undefined) apply(block, hit);
    else { block.dataset.mm = 'wait'; pending.push({ block, source, key }); }
  }
  if (pending.length === 0) return;
  load().then(async (mermaid) => {
    for (const { block, source, key } of pending) {
      let src = cache.get(key);
      if (src === undefined) {
        if (theme !== t) {
          mermaid.initialize(mermaidConfig(t === 'dark') as Parameters<Mermaid['initialize']>[0]);
          theme = t;
        }
        const id = `bh-mm-${++seq}`;
        try { src = toImageSrc((await mermaid.render(id, source)).svg); } catch { src = ''; }
        document.getElementById(`d${id}`)?.remove(); // mermaid leaves its scratch element behind on a parse error
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
        cache.set(key, src);
      }
      if (block.isConnected) apply(block, src);
    }
  }).catch(() => {
    for (const { block } of pending) delete block.dataset.mm;
  });
}

// Light/dark switch: redraw the diagrams on screen in the new theme.
darkQuery?.addEventListener('change', () => {
  for (const block of document.querySelectorAll<HTMLElement>('.md-mermaid[data-mm="ok"], .md-mermaid[data-mm="fail"]')) delete block.dataset.mm;
  renderDiagrams(document);
});

// ── Zoom viewer: click a diagram to open it full screen; wheel / pinch to zoom, drag to pan,
// double-click to toggle fit / 2x, keys + - 0 Esc. Transforms are set through CSSOM (CSP-safe).
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;

function openZoom(src: string): void {
  const overlay = document.createElement('div');
  overlay.className = 'mm-zoom';
  overlay.tabIndex = -1;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Mermaid 图');
  const bar = document.createElement('div');
  bar.className = 'mm-zoom-bar';
  const button = (label: string, title: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    bar.append(b);
    return b;
  };
  const out = button('−', '缩小');
  const pct = button('100%', '适应窗口');
  const zin = button('+', '放大');
  const close = button('×', '关闭');
  const stage = document.createElement('div');
  stage.className = 'mm-zoom-stage';
  const img = document.createElement('img');
  img.alt = 'Mermaid 图';
  img.draggable = false;
  stage.append(img);
  overlay.append(bar, stage);

  let scale = 1, x = 0, y = 0;
  const draw = (): void => {
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    pct.textContent = `${Math.round(scale * 100)}%`;
  };
  const fit = (): void => {
    const r = stage.getBoundingClientRect();
    const w = img.naturalWidth || 1, h = img.naturalHeight || 1;
    scale = Math.min((r.width - 32) / w, (r.height - 32) / h, 2);
    x = (r.width - w * scale) / 2;
    y = (r.height - h * scale) / 2;
    draw();
  };
  /** Zoom to `next` keeping the stage point (px, py) fixed. */
  const zoomAt = (next: number, px: number, py: number): void => {
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    x = px - ((px - x) * s) / scale;
    y = py - ((py - y) * s) / scale;
    scale = s;
    draw();
  };
  const center = (): [number, number] => { const r = stage.getBoundingClientRect(); return [r.width / 2, r.height / 2]; };
  const local = (e: { clientX: number; clientY: number }): [number, number] => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  stage.addEventListener('wheel', (e) => { e.preventDefault(); const [px, py] = local(e); zoomAt(scale * Math.exp(-e.deltaY * 0.0015), px, py); }, { passive: false });
  stage.addEventListener('dblclick', (e) => {
    const [px, py] = local(e);
    const r = stage.getBoundingClientRect();
    const fitScale = Math.min((r.width - 32) / (img.naturalWidth || 1), (r.height - 32) / (img.naturalHeight || 1), 2);
    if (Math.abs(scale - fitScale) < 0.01) zoomAt(fitScale * 2, px, py); else fit();
  });
  // One pointer pans, two pinch-zoom around their midpoint.
  const pointers = new Map<number, [number, number]>();
  let pinch = 0;
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a![0] - b![0], a![1] - b![1]); }
  });
  stage.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = local(e);
    pointers.set(e.pointerId, cur);
    if (pointers.size === 1) { x += cur[0] - prev[0]; y += cur[1] - prev[1]; draw(); return; }
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a![0] - b![0], a![1] - b![1]);
    if (pinch > 0 && d > 0) zoomAt(scale * (d / pinch), (a![0] + b![0]) / 2, (a![1] + b![1]) / 2);
    pinch = d;
  });
  const lift = (e: PointerEvent): void => { pointers.delete(e.pointerId); pinch = 0; };
  stage.addEventListener('pointerup', lift);
  stage.addEventListener('pointercancel', lift);

  const prevFocus = document.activeElement as HTMLElement | null;
  const shut = (): void => { overlay.remove(); prevFocus?.focus?.(); };
  out.addEventListener('click', () => { const [px, py] = center(); zoomAt(scale / 1.25, px, py); });
  zin.addEventListener('click', () => { const [px, py] = center(); zoomAt(scale * 1.25, px, py); });
  pct.addEventListener('click', fit);
  close.addEventListener('click', shut);
  overlay.addEventListener('keydown', (e) => {
    const [px, py] = center();
    if (e.key === 'Escape') shut();
    else if (e.key === '+' || e.key === '=') zoomAt(scale * 1.25, px, py);
    else if (e.key === '-') zoomAt(scale / 1.25, px, py);
    else if (e.key === '0') fit();
    else return;
    e.preventDefault();
  });
  img.addEventListener('load', fit, { once: true });
  img.src = src;
  document.body.append(overlay);
  overlay.focus();
  if (img.complete) fit();
}

function zoomTarget(target: EventTarget | null): string | null {
  const fig = (target as Element | null)?.closest?.('.md-diagram');
  return fig?.querySelector('img')?.getAttribute('src') ?? null;
}
document.addEventListener('click', (e) => { const src = zoomTarget(e.target); if (src) openZoom(src); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const src = zoomTarget(e.target);
  if (src) { e.preventDefault(); openZoom(src); }
});
