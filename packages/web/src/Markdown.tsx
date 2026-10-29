// Rendered Markdown (markdown.ts output) plus Mermaid diagrams.
import { useLayoutEffect, useRef } from 'react';
import { renderDiagrams } from './diagrams';

export function Markdown({ html, className }: { html: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // Layout effect: cached diagrams are swapped in before paint, so updates do not flash the source.
  useLayoutEffect(() => { renderDiagrams(ref.current); }, [html]);
  return <div ref={ref} className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
