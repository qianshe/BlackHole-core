/**
 * Small Markdown renderer for chat replies, shared by the VS Code sidebar and the Web console.
 * Everything is HTML-escaped first; only the syntax below produces markup, and links are
 * limited to http(s) and mailto. Unclosed code fences (a reply still streaming) run to the end.
 *
 * Blocks: paragraphs, # headings, > quotes, - / 1. lists (one nesting level), ``` code,
 * | tables |, --- rules. Inline: `code`, **bold**, *italic*, ~~strike~~, [text](url), bare URLs.
 */
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]!);

const SAFE_URL = /^(?:https?:\/\/|mailto:)/i;
/** Copy icon of the code-block button (inline SVG: the webviews load nothing external). */
const COPY_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>';

function link(url: string, label: string): string {
  const raw = url.replace(/&amp;/g, '&');
  if (!SAFE_URL.test(raw)) return label;
  return `<a href="${escapeHtml(raw)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

/** Inline syntax on one already-escaped line. Code spans are cut out first so nothing inside them is formatted. */
function inline(src: string): string {
  const codes: string[] = [];
  let s = src.replace(/`([^`\n]+)`/g, (_m, c: string) => `\u0000${codes.push(`<code>${c}</code>`) - 1}\u0000`);
  const links: string[] = [];
  const keep = (html: string): string => `\u0001${links.push(html) - 1}\u0001`;
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => keep(link(url, label)));
  s = s.replace(/\bhttps?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/g, (url) => keep(link(url, url)));
  s = s
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_\n]*?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
  return s.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => links[Number(i)]!).replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]!);
}

const cells = (row: string): string[] => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

export function renderMarkdown(text: string): string {
  const lines = escapeHtml(text.replace(/\r\n?/g, '\n')).split('\n');
  const out: string[] = [];
  let para: string[] = [];
  const flush = (): void => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence[1]!); i++) body.push(lines[i]!);
      const lang = fence[2] ? ` data-lang="${fence[2]}"` : '';
      // The copy button sits outside <pre> so it stays in the corner while the code scrolls sideways;
      // each UI copies the block's <code> text on click (.md-copy).
      out.push(`<div class="md-code"><button type="button" class="md-copy" title="复制代码" aria-label="复制代码">${COPY_ICON}</button><pre${lang}><code>${body.join('\n')}</code></pre></div>`);
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) { flush(); out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); continue; }
    if (/^\s*&gt;/.test(line)) {
      flush();
      const quote: string[] = [];
      for (; i < lines.length && /^\s*&gt;/.test(lines[i]!); i++) quote.push(lines[i]!.replace(/^\s*&gt;\s?/, ''));
      i--;
      out.push(`<blockquote>${renderQuoted(quote)}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i]!.includes('|') && lines[i]!.trim(); i++) rows.push(cells(lines[i]!));
      i--;
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr>${head.map((_c, k) => `<td>${inline(r[k] ?? '')}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      flush();
      i = list(lines, i, out) - 1;
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return out.join('');
}

// Blockquote bodies are already escaped: render them without escaping twice.
function renderQuoted(lines: string[]): string {
  const text = lines.join('\n').replace(/&(amp|lt|gt|quot|#39);/g, (_m, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]!);
  return renderMarkdown(text);
}

/** One list (and its nested items one level deeper); returns the index after it. */
function list(lines: string[], start: number, out: string[]): number {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const indent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]!);
    if (m && m[1]!.length === indent && /\d/.test(m[2]!) === ordered) {
      items.push(inline(m[3]!));
      i++;
      continue;
    }
    if (m && m[1]!.length > indent && items.length) {
      const sub: string[] = [];
      i = list(lines, i, sub);
      items[items.length - 1] += sub.join('');
      continue;
    }
    // continuation line of the previous item
    if (!m && items.length && lines[i]!.trim() && /^\s+/.test(lines[i]!)) { items[items.length - 1] += `<br>${inline(lines[i]!.trim())}`; i++; continue; }
    break;
  }
  const tag = ordered ? 'ol' : 'ul';
  const startAttr = ordered && parseInt(first[2]!, 10) !== 1 ? ` start="${parseInt(first[2]!, 10)}"` : '';
  out.push(`<${tag}${startAttr}>${items.map((x) => `<li>${x}</li>`).join('')}</${tag}>`);
  return i;
}
