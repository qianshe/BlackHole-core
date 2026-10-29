// Copy button on Markdown code blocks (markdown.ts emits .md-code > button.md-copy + pre > code).
// One delegated listener covers the console and the phone page, including replies that re-render.
/** Clipboard write with a fallback for pages without the clipboard API. */
export async function copyText(text: string): Promise<boolean> {
  return write(text);
}
async function write(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const t = document.createElement('textarea'); // no clipboard API (plain http / no focus)
    t.value = text;
    t.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  }
}

let installed = false;
export function installCodeCopy(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('click', (e) => {
    const btn = (e.target as Element | null)?.closest?.('.md-copy');
    if (!(btn instanceof HTMLElement)) return;
    e.preventDefault();
    const code = btn.closest('.md-code')?.querySelector('pre code');
    if (!code) return;
    void write(code.textContent ?? '').then((ok) => {
      btn.classList.toggle('done', ok);
      btn.title = ok ? '已复制' : '复制失败';
      setTimeout(() => { btn.classList.remove('done'); btn.title = '复制代码'; }, 1500);
    });
  });
}
