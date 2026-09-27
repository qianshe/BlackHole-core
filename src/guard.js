import path from 'node:path';

/**
 * Runtime permission policy with a HUMAN-REVIEW model (the real control).
 *
 * Threat model: the caller (a web AI) is untrusted, but the operator is a human
 * sitting at the machine running this daemon. Instead of isolating the shell in
 * a container (which would prevent it from operating the local project at all),
 * we let it run on the HOST and gate anything that crosses the boundary behind a
 * local, out-of-band approval the human answers in the daemon's terminal.
 *
 * Modes (env BH_MODE, default: review):
 *   review    : (default) benign, workspace-scoped commands run automatically;
 *               commands that reach OUTSIDE the workspace, or are destructive /
 *               system-level / privileged / persisting, require human approval.
 *   read-only : allow reads/search/tests; DENY writes & mutations outright (no prompt).
 *   auto      : no gating (same as danger-full-access). Only for a fully trusted caller.
 *
 * Filesystem/network classifier is best-effort; the human approver is the real
 * boundary, so erring toward "review" on ambiguous commands is the safe default.
 */

const REVIEW = 'review';
const READ_ONLY = 'read-only';
const AUTO = 'auto';

// Destructive / system-mutating.
const DESTRUCTIVE = [
  /\bRemove-Item\b/i, /\bdel\b/i, /\brd\b/i, /\brmdir\b/i, /\brm\b/i, /\bdeltree\b/i,
  /\bformat\b/i, /\bdiskpart\b/i, /\bdiskpart\b/i, /\bClear-Content\b/i, /\bClear-RecycleBin\b/i,
  /\bStop-Process\b/i, /\btaskkill\b/i, /\bshutdown\b/i, /\bRestart-Computer\b/i, /\bStop-Service\b/i,
  /\breg(\.exe)?\s+(add|delete|import)\b/i, /\bschtasks\b/i, /\bsc(\.exe)?\s+(create|delete|config|stop)\b/i,
  /\bgit\s+(reset|clean|push\s+--force|filter-branch)\b/i,
];

// Privilege / persistence (survives or escalates).
const PRIVILEGE = [
  /\bSet-MpPreference\b/i, /\bNew-Service\b/i, /\bNew-ScheduledTask/i, /\bNew-ScheduledTaskAction/i,
  /\bRegister-ScheduledTask\b/i, /\bnet\s+(localgroup|user)\b/i, /\bicacls\b/i, /\bcacls\b/i,
  /\btakeown\b/i, /\bNew-ItemProperty\b.*HKLM/i, /\bSet-ItemProperty\b.*HKLM/i, /\bHKLM\b/i,
  /\brunas\b/i, /\b-Verb\s+RunAs\b/i,
];

// Global installers (mutate the machine, not just the workspace).
const SYS_INSTALL = [/\bchoco\b/i, /\bwinget\b/i, /\bnpm\s+(install|i|-i|-g)\b.*\s-g\b/i, /\bpipx?\s+install\b.*--(user|system)/i];

function anyHit(list, cmd) {
  return list.find((re) => re.test(cmd));
}

// Heuristic: does the command reference paths OUTSIDE the workspace root?
function outsidePaths(cmd, rootLower) {
  const found = [];
  // Strip URI schemes FIRST: `https://x`, `blackhole://rules` etc. contain
  // letter+"://" runs that must not be mistaken for drive-letter paths
  // (e.g. the "e:/" inside "blackhole://"). Paths embedded in query strings
  // survive the strip and are still caught below.
  const stripped = cmd.replace(/[A-Za-z][A-Za-z0-9+.\-]*:\/\//g, ' ');
  const win = /[A-Za-z]:[\\/][^\s"'`;)|\]}<>,]*/g;
  let m;
  while ((m = win.exec(stripped))) {
    const p = m[0].replace(/[.,;:'"]+$/, '');
    let np;
    try { np = path.resolve(p).toLowerCase(); } catch { continue; }
    if (np !== rootLower && !np.startsWith(rootLower + path.sep)) found.push(p);
  }
  // Home / user-profile / explicit traversal-up references.
  if (/(~(?=$|[\\/])|\$env:USERPROFILE|\$env:HOME|\$env:APPDATA|\$env:LOCALAPPDATA|\$HOME\b)/i.test(cmd)) found.push('~');
  return [...new Set(found)];
}

// Shell commands that mutate files (used to gate read-only).
const FS_MUTATE = [
  /\bOut-File\b/i, /\bSet-Content\b/i, /\bAdd-Content\b/i, /\bNew-Item\b/i, /\bMove-Item\b/i,
  /\bCopy-Item\b/i, /\bRename-Item\b/i, /\bTee-Object\b/i, /\bni\b\s+-/i, /\bmv\b\s/i, /\bcp\b\s/i,
  />\s*\S/, />>\s*\S/,
];

export function createPolicy(mode = REVIEW, { workspacePath } = {}) {
  const ALIAS = { guarded: REVIEW, 'workspace-write': REVIEW, trusted: AUTO, 'danger-full-access': AUTO };
  const resolved = ALIAS[mode] ?? mode;
  const m = [REVIEW, READ_ONLY, AUTO].includes(resolved) ? resolved : REVIEW;
  const rootLower = workspacePath ? path.resolve(workspacePath).toLowerCase() : null;

  return {
    mode: m,

    /**
     * Classify a shell command.
     * @returns {{action:'allow'|'deny'|'review', category?:string, reason?:string}}
     */
    evaluateShell(command) {
      if (m === AUTO) return { action: 'allow' };

      if (m === READ_ONLY) {
        const bad = anyHit([...DESTRUCTIVE, ...PRIVILEGE, ...SYS_INSTALL, ...FS_MUTATE], command);
        if (bad) return { action: 'deny', reason: 'read-only mode: mutations disabled' };
        return { action: 'allow' };
      }

      // REVIEW mode.
      if (rootLower) {
        const out = outsidePaths(command, rootLower);
        if (out.length) return { action: 'review', category: 'outside-workspace', reason: `references path(s) outside workspace: ${out.slice(0, 3).join(', ')}` };
      }
      const priv = anyHit(PRIVILEGE, command);
      if (priv) return { action: 'review', category: 'privilege', reason: `privilege/persistence command (${priv.source})` };
      const des = anyHit(DESTRUCTIVE, command);
      if (des) return { action: 'review', category: 'destructive', reason: `destructive command (${des.source})` };
      const inst = anyHit(SYS_INSTALL, command);
      if (inst) return { action: 'review', category: 'system-install', reason: `machine-level installer (${inst.source})` };

      return { action: 'allow' };
    },

    /** Editor mutation (create/str_replace/insert). Editor is already path-guarded to the workspace. */
    evaluateEditorWrite() {
      if (m === READ_ONLY) return { action: 'deny', reason: 'read-only mode: file writes disabled' };
      return { action: 'allow' };
    },
  };
}
