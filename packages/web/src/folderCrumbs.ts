/** Breadcrumb paths are display-only; Core validates every navigated path. */
export interface FolderCrumb { label: string; path: string }

export function folderCrumbs(value: string): FolderCrumb[] {
  if (!value) return [];

  const unc = value.startsWith('\\\\') || value.startsWith('//');
  const windows = /^([A-Za-z]:)(?:[\\/]|$)/.exec(value);
  let root: string;
  let rest: string[];
  let sep: string;
  let label: string;

  if (unc) {
    sep = '\\';
    const parts = value.split(/[\\/]+/).filter(Boolean);
    if (parts.length < 2) return [{ label: value, path: value }];
    root = '\\\\' + parts[0] + '\\' + parts[1] + '\\';
    label = parts[0] + ' / ' + parts[1];
    rest = parts.slice(2);
  } else if (windows) {
    sep = '\\';
    const drive = windows[1]!;
    root = drive + '\\';
    label = drive;
    rest = value.slice(windows[0].length).split(/[\\/]+/).filter(Boolean);
  } else if (value.startsWith('/')) {
    sep = '/';
    root = '/';
    label = '/';
    rest = value.slice(1).split('/').filter(Boolean);
  } else {
    return [{ label: value, path: value }];
  }

  const crumbs = [{ label, path: root }];
  let current = root;
  for (const part of rest) {
    current += (current.endsWith(sep) ? '' : sep) + part;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}
