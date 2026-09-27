import os from 'node:os';
import path from 'node:path';
import type { PermissionMode } from '../config.js';

/**
 * Heuristic command risk classes. These are audit-and-confirmation aids,
 * not a security boundary; the workspace path checks and the event log are.
 */
/**
 * Risk severity levels. The level decides the approval card's visual weight
 * (tag + in-command highlight + header tint all derive from it): the more
 * irreversible a mistake, the louder it reads.
 */
export type RiskLevel = 'critical' | 'warn' | 'info';

/** One high-risk pattern with the operator-facing label shown on approvals. */
interface RiskPattern {
  re: RegExp;
  /** Short Chinese label rendered as the approval tag. */
  label: string;
  /** Severity: critical = irreversible destruction, warn = big but recoverable
   *  blast radius, info = ordinary mutation (often noise-level). */
  level: RiskLevel;
}

const HIGH_RISK_PATTERNS: RiskPattern[] = [
  // ── critical：不可逆破坏（误操作无法撤回） ──
  { re: /\brm\b/, label: '文件删除', level: 'critical' },
  { re: /\b(rmdir|del|rd|erase|shred)\b/, label: '文件删除', level: 'critical' },
  { re: /\bdd\b|\bmkfs|\bformat\b/, label: '磁盘写入', level: 'critical' },
  { re: /\bdrop\s+(table|database)\b/i, label: '数据库删除', level: 'critical' },
  { re: /\b(sudo|runas)\b/, label: '提权执行', level: 'critical' },
  // PowerShell destructives (the `pwsh` tool runs real PowerShell on Windows)
  { re: /\bRemove-Item\b/i, label: '文件删除', level: 'critical' },
  { re: /\bClear-Content\b/i, label: '内容清空', level: 'critical' },
  // ── warn：影响大但可回退/可重建 ──
  { re: /\bgit\s+(push|reset|clean|rebase|revert|filter-branch)\b/, label: 'git 历史操作', level: 'warn' },
  { re: /\b(npm|pnpm|yarn|bun|pip3?|cargo|gem|dotnet|conda)\s+(publish|install|add|remove|uninstall|link|unlink)\b/, label: '包管理变更', level: 'warn' },
  { re: /\b(curl|wget)\b[^|\n]*\|\s*(ba|z|da)?sh\b/, label: '管道执行', level: 'warn' },
  { re: /\b(curl|wget)\b[^|\n]*\|\s*powershell\b/, label: '管道执行', level: 'warn' },
  { re: /\bkill\b|\btaskkill\b|\bshutdown\b|\breboot\b|\bpkill\b/, label: '进程终止', level: 'warn' },
  { re: /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm|network\s+rm)\b/, label: '容器删除', level: 'warn' },
  { re: /\b(Invoke-Expression|iex)\b/i, label: '动态执行', level: 'warn' },
  { re: /\bSet-ExecutionPolicy\b/i, label: '执行策略修改', level: 'warn' },
  // ── info：常规变更（通常只是该确认一下） ──
  { re: /\bmv\b|\bmove\b/, label: '移动/重命名', level: 'info' },
  { re: /\bchmod\b|\bchown\b|\bicacls\b|\battrib\b/, label: '权限修改', level: 'info' },
  // file-redirect writes; excludes fd redirects like `2>`, comparisons like `=>`/`>=`
  { re: /(?<![\w=/>-])>{1,2}(?!=)\s*\S/, label: '重定向写入', level: 'info' },
  { re: /\btee\b/, label: '重定向写入', level: 'info' },
  { re: /\bsed\b[^|\n;&]*\s-i\b/, label: '原地编辑', level: 'info' },
];

/** Extra mutation patterns on top of HIGH_RISK, applied in read-only mode. */
const READ_ONLY_EXTRA_PATTERNS: RegExp[] = [
  /\btouch\b/,
  /\bmkdir\b/,
  /\bcp\b|\bcopy\b|\bxcopy\b|\brobocopy\b/,
  /\bgit\s+(commit|add|stash|tag|branch|switch|merge|cherry-pick|apply|am|checkout|restore)\b/,
  /\b(npm|pnpm|yarn|bun|pip3?|cargo|gem|dotnet|conda)\b/,
  /\btruncate\b/,
];

/** Test-runner entry points stay usable in read-only mode ("读取、搜索和测试"). */
const READ_ONLY_RUN_ALLOW: RegExp[] = [
  /\b(npm|pnpm|yarn|bun)\s+(test|run)\b/,
  /\b(vitest|jest|mocha|pytest|pytest-3|go\s+test|cargo\s+test|mvn|gradle)\b/,
];

export interface CommandPathContext {
  /** Absolute session workspace root; anything resolving outside it is flagged. */
  workspaceRoot: string;
  /** Tracked shell cwd; relative paths and `..` traversal resolve against it. */
  cwd?: string;
  /**
   * M4.6 writableDirs：operator 在会话上额外授予的内核写目录。命中这些目录的
   * 路径按"内侧"处理——不再弹越界确认（Windows ACL 侧有对应授权，两层一致）。
   */
  extraWritableDirs?: readonly string[];
}

export type RiskDecision = 'allow' | 'confirm' | 'deny';

/** Why a command needs confirmation; the unit an approval scope remembers. */
export type RiskCategory = 'high-risk' | 'out-of-workspace';

/*
 * Out-of-workspace path detection — textual and heuristic on purpose. It is
 * the approval gate, not the security boundary (the editor's realpath fence
 * and the event log remain that). It errs toward asking: the worst case is
 * the operator confirming a benign command.
 */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]*/gi;
// Runtime-resolved variable paths — the target is unknowable from the text,
// so they conservatively count as outside. Windows spellings ($env:X\…,
// %X%\…) AND Unix spellings ($X/…, ${X}/…) — the $env: form must come first
// so its longer match wins. A variable WITHOUT a following separator is a
// value reference ($PATH), never a path.
const ENV_PATH_RE = /(?:\$env:[A-Za-z_][A-Za-z0-9_]*|%[^%\s]+%|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*)(?=[\\/])/g;
// The token WITH its whole path tail — every alternative must END in the
// separator and then consume the ENTIRE remaining path run (a variable's
// target is unknowable anyway). Eating the full tail (not one segment) is
// what prevents leftovers: a half-stripped `$env:TEMP\foo` leaving `\bar`
// behind would be misread by ROOTED_RE as a drive-root path.
const ENV_PATH_WITH_SEP_RE = /(?:\$env:[A-Za-z_][A-Za-z0-9_]*|%[^%\s]+%|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*)(?:[\\/][^\s"'|;<>()`\[\]{}]*)+/g;
// Variables that always resolve inside the sandbox's writable set — VALID ON
// win32 ONLY: there the sandboxed shell rewrites TEMP/TMP to its per-session
// private temp dir (kernel-granted), so a variable path under them is
// contained by the ACL layer, not the text gate. On Mac/Linux the shell is
// plain (no kernel confinement, no TEMP rewrite), so these variables point at
// the REAL system temp and must keep confirming like every other variable.
// TMPDIR is the Unix spelling of the same idea (it joins the allowlist once
// a Unix kernel sandbox lands; until then it stays gated).
const SANDBOX_SAFE_ENV_VARS = new Set(['TEMP', 'TMP', 'TMPDIR']);

/** Whether an env-var path token resolves somewhere the sandbox already confines. */
function isSandboxSafeEnvPath(token: string): boolean {
  if (process.platform !== 'win32') return false;
  // $env:X / ${X} / $X supply capture group 1; %X% supplies group 2 (the cmd
  // spelling of the same variable, so %TEMP%\x is allowed like $env:TEMP\x).
  const m = /^(?:\$env:|\$\{|\$)([A-Za-z_][A-Za-z0-9_]*)\}?|^%([^%\s]+)%/.exec(token);
  const name = m ? (m[1] ?? m[2] ?? '') : '';
  return name !== '' && SANDBOX_SAFE_ENV_VARS.has(name.toUpperCase());
}

const DRIVE_RE = /(?<![A-Za-z0-9:])([A-Za-z]:[\\/][^\s"'|;<>()`\[\]{}]*)/g;            // C:\x, C:/x
const UNC_RE = /(\\\\[^\\\s"'|;<>()`\[\]{}][^\s"'|;<>()`\[\]{}]*)/g;                     // \\server\share (not a bare \\\ regex arg)
const MSYS_RE = /(?<![\w.~])(\/(?:[^/\s"'|;<>()`\[\]{}]+\/)+[^/\s"'|;<>()`\[\]{}]*)/g; // /c/x, /a/b (2+ segments: cmd flags like /q never match)
const TILDE_RE = /(?<![\w])(~(?:[\\/][^\s"'|;<>()`\[\]{}]*)?)/g;                        // ~, ~\x — home is always outside
const ROOTED_RE = /(?<![\w.:\\])(\\[^\s"'|;<>()`\[\]{}][^\s"'|;<>()`\[\]{}]*)/g;                    // \x — root of the cwd drive; 2+ chars: a lone `\` or `\\` is a regex/escape artifact, never a path
const DOT_RE = /(?<![\w.])(\.{1,2}(?:[\\/][^\s"'|;<>()`\[\]{}]*)?)(?![.\w])/g;          // ./x, .\x, .., ..\x, ../x

/** Lift every match's captured token out of the text (so later sweeps with
 * overlapping shapes can't rematch tails) and collect it. */
function sweep(text: string, re: RegExp, out: string[]): string {
  return text.replace(re, (_m: string, tok: string) => {
    out.push(tok);
    return ' ';
  });
}

/** True when abs resolves INSIDE one of the operator-granted extra dirs. */
function insideExtraDir(abs: string, extraDirs?: readonly string[]): boolean {
  if (!extraDirs || extraDirs.length === 0) return false;
  const fold = (x: string): string => (process.platform === 'win32' ? x.toLowerCase() : x);
  const absF = fold(abs);
  return extraDirs.some((dir) => {
    const rel = path.relative(fold(dir), absF);
    return rel === '' || (!path.isAbsolute(rel) && !rel.startsWith(`..${path.sep}`));
  });
}

function resolvesOutside(raw: string, root: string, cwd: string, extraDirs?: readonly string[]): boolean {
  let p = raw;
  if (p.startsWith('~')) {
    p = path.join(os.homedir(), p.slice(1));
  } else {
    // MSYS/GNU spellings: /c/... and /mnt/c/... → C:...
    const m = /^\/mnt\/([A-Za-z])(?=\/)/i.exec(p) ?? /^\/([A-Za-z])(?=\/)/.exec(p);
    const drive = m?.[1];
    const head = m?.[0];
    if (drive && head) p = `${drive.toUpperCase()}:${p.slice(head.length)}`;
  }
  // Forward-slash drive paths (D:/x) must be normalized to backslashes first:
  // on Windows path.resolve() does not treat "D:/x" as absolute, so it gets
  // joined onto the cwd and EVERY in-workspace absolute path reads as outside.
  if (process.platform === 'win32' && /^[a-zA-Z]:\//.test(p)) p = p.replace(/\//g, '\\');
  const fold = (x: string): string => (process.platform === 'win32' ? x.toLowerCase() : x);
  const abs = path.resolve(cwd, p);
  if (insideExtraDir(abs, extraDirs)) return false;
  const rel = path.relative(fold(root), fold(abs));
  return rel !== '' && (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`));
}

/**
 * True when the command text contains a path-like token that resolves outside
 * the workspace root, or whose target cannot be proven inside (env-var paths).
 * Pure text + path algebra: no fs access, no TOCTOU, no blocking. Variable
 * paths under the sandbox-managed temp variables (TEMP/TMP/TMPDIR) are
 * contained by the kernel layer and do NOT count as outside.
 */
function referencesOutsidePath(command: string, ctx: CommandPathContext): boolean {
  const root = path.resolve(ctx.workspaceRoot);
  const cwd = ctx.cwd ? path.resolve(ctx.cwd) : root;
  const extraDirs = ctx.extraWritableDirs?.map((d) => path.resolve(d));
  let text = command.replace(URL_RE, ' ');
  // env-var tokens are collected via matchAll: ENV_PATH_RE has no capture
  // group, so a replace()-callback's second argument would be the OFFSET,
  // not the token (sweep() assumes capturing regexes). The text strip uses
  // the separator-consuming twin so no lone `\` survives for ROOTED_RE.
  const envTokens = [...text.matchAll(ENV_PATH_RE)].map((m) => m[0]);
  text = text.replace(ENV_PATH_WITH_SEP_RE, ' ');
  if (envTokens.some((t) => !isSandboxSafeEnvPath(t))) return true;
  const tokens: string[] = [];
  text = sweep(text, DRIVE_RE, tokens);
  text = sweep(text, UNC_RE, tokens);
  text = sweep(text, MSYS_RE, tokens);
  text = sweep(text, TILDE_RE, tokens);
  text = sweep(text, ROOTED_RE, tokens);
  text = sweep(text, DOT_RE, tokens);
  return tokens.some((t) => !insideExtraDir(path.resolve(cwd, t), extraDirs) && resolvesOutside(t, root, cwd));
}

/** One matched risk span: what the label says, where in the command text. */
export interface RiskMatch {
  label: string;
  /** Severity-derived UI tone: red = critical, yellow = warn, blue = info. */
  tone: 'red' | 'yellow' | 'blue';
  /** Severity of the matched pattern (out-of-workspace paths report `warn`). */
  level: RiskLevel;
  /** [start, end) character offsets into the command text. */
  range: [number, number];
}

const TONE_OF: Record<RiskLevel, RiskMatch['tone']> = { critical: 'red', warn: 'yellow', info: 'blue' };

/**
 * Every risk hit with its span, for the approval card: the tag row plus the
 * in-command highlight. The sweep() token collection order mirrors text order,
 * so spans stay sorted. Out-of-workspace is inherently `warn` (where, not how
 * destructive); tag and highlight share the tone derived from the level.
 */
export function riskMatches(command: string, ctx?: CommandPathContext): RiskMatch[] {
  const out: RiskMatch[] = [];
  for (const p of HIGH_RISK_PATTERNS) {
    const m = p.re.exec(command);
    if (m) out.push({ label: p.label, level: p.level, tone: TONE_OF[p.level], range: [m.index, m.index + m[0].length] });
  }
  if (ctx) {
    const root = path.resolve(ctx.workspaceRoot);
    const cwd = ctx.cwd ? path.resolve(ctx.cwd) : root;
    const extraDirs: string[] = (ctx.extraWritableDirs ?? []).map((d) => path.resolve(d));
    let text = command.replace(URL_RE, ' ');
    const envTokens = [...text.matchAll(ENV_PATH_RE)].map((m) => m[0]);
    text = text.replace(ENV_PATH_WITH_SEP_RE, ' ');
    // an uncontained variable path (e.g. $env:APPDATA\…) IS the highlight; the
    // sandbox-safe ones (TEMP/TMP) are invisible to the card
    const uncontained = envTokens.filter((t) => !isSandboxSafeEnvPath(t));
    for (const tok of uncontained) {
      const idx = command.indexOf(tok);
      if (idx >= 0) out.push({ label: '变量路径（运行时解析）', level: 'warn', tone: 'yellow', range: [idx, idx + tok.length] });
    }
    if (uncontained.length === 0) {
      const outside: string[] = [];
      for (const re of [DRIVE_RE, UNC_RE, MSYS_RE, TILDE_RE, ROOTED_RE, DOT_RE]) {
        const hits: string[] = [];
        text = sweep(text, re, hits);
        outside.push(...hits);
      }
      for (const tok of outside) {
        if (!resolvesOutside(tok, root, cwd)) continue;
        if (insideExtraDir(path.resolve(cwd, tok), extraDirs)) continue;
        const idx = command.indexOf(tok);
        if (idx >= 0) out.push({ label: '工作区外路径', level: 'warn', tone: 'yellow', range: [idx, idx + tok.length] });
      }
    }
  }
  return out;
}

/**
 * One approval-scope unit. Pattern risks authorize by their stable pattern
 * identity (label + level — the same label the approval card shows), so a
 * grant covers exactly what the operator saw. Path risks authorize by the
 * matched outside-path's PARENT directory: approving a write under D:\tmp
 * never un-asks one under C:\Windows, but the same directory later is fine.
 * `critical` patterns refuse 'always' (an irreversible op's no-ask window
 * must not survive a daemon restart).
 */
export interface ApprovalUnit {
  /** `pattern:${label}|${level}` or `path:${resolved parent dir}`. */
  key: string;
  /** Level of the matched pattern ('warn' for path units). */
  level: RiskLevel;
}

/** Derive the stable authorization units a command's matches decompose into. */
export function approvalUnits(matches: RiskMatch[], command: string): ApprovalUnit[] {
  const units: ApprovalUnit[] = [];
  for (const m of matches) {
    if (m.label === '工作区外路径' || m.label === '变量路径（运行时解析）') {
      // path-shaped risk: authorize the parent directory of the matched span
      const span = command.slice(m.range[0], m.range[1]);
      const dir = parentDirOf(span);
      if (dir) units.push({ key: `path:${dir.toLowerCase()}`, level: m.level });
      continue;
    }
    units.push({ key: `pattern:${m.label}|${m.level}`, level: m.level });
  }
  return units;
}

/** Best-effort parent directory of a path-shaped token (Windows and POSIX). */
function parentDirOf(token: string): string | undefined {
  const t = token.replace(/^['"]+|['"]+$/g, '').replace(/[\\/]+$/, '');
  const idx = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
  if (idx <= 0) return /^[a-z]:/i.test(t) || t.startsWith('\\\\') || t.startsWith('/') ? t : undefined;
  return t.slice(0, idx);
}

/**
 * Which confirmation reasons apply to the command: `high-risk` (destructive /
 * mutating pattern) and `out-of-workspace` (path resolving outside the root).
 * Empty = nothing to confirm. Approval scopes remember grants per category.
 */
export function riskCategories(command: string, ctx?: CommandPathContext): RiskCategory[] {
  const cats: RiskCategory[] = [];
  if (HIGH_RISK_PATTERNS.some((p) => p.re.test(command))) cats.push('high-risk');
  if (ctx && referencesOutsidePath(command, ctx)) cats.push('out-of-workspace');
  return cats;
}

export function assessCommand(mode: PermissionMode, command: string, ctx?: CommandPathContext): RiskDecision {
  if (mode === 'danger-full-access') return 'allow';
  const cats = riskCategories(command, ctx);
  if (mode === 'read-only') {
    // read-only has no confirmation flow, so out-of-workspace access is denied
    if (cats.length > 0) return 'deny';
    const mutating = READ_ONLY_EXTRA_PATTERNS.some((re) => re.test(command));
    const runningTests = READ_ONLY_RUN_ALLOW.some((re) => re.test(command));
    return mutating && !runningTests ? 'deny' : 'allow';
  }
  // workspace-write: nothing is outright denied; high-risk commands and
  // anything touching paths outside the workspace ask for confirmation
  return cats.length > 0 ? 'confirm' : 'allow';
}
