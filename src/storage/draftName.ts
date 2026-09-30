/**
 * The name a draft session gets from its first message: the first non-empty line, at most 60
 * characters. Shared by the session store (which applies it) and Courier (which shows it right away).
 */
export function draftName(firstMessage?: string | null): string | null {
  const line = firstMessage?.split('\n').map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}
