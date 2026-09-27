import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/**
 * Persistent PowerShell shell. One long-lived `pwsh` process keeps cwd and
 * environment across calls (mirrors DSH minimal `pwsh`). Commands are delimited
 * by a random sentinel so we can slice output and detect completion.
 */
/**
 * Minimal environment for the sandboxed shell. NEVER pass process.env through —
 * that would leak every secret/token on the host to a remote caller. We forward
 * only what a shell needs to function, plus BH_* config the shell may need.
 */
function minimalEnv(extra = {}) {
  const keys = ['PATH', 'PATHEXT', 'SystemRoot', 'ComSpec', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG', 'PSModulePath'];
  const env = {};
  for (const k of keys) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.PATH = env.PATH || '';
  // PowerShell command discovery REQUIRES PATHEXT (probe-verified: without it,
  // `node` is unresolvable even with a correct PATH). Default to the Windows
  // standard list when the parent env has none (e.g. some MSYS contexts).
  env.PATHEXT = env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';
  if (process.platform === 'win32') {
    env.PATH = toWindowsPathList(env.PATH);
    if (env.HOME) env.HOME = msysToWindows(env.HOME) || env.HOME;
  }
  return { ...env, ...extra };
}

/** "/f/x/y" -> "F:\\x\\y"; null when not an MSYS drive path. */
function msysToWindows(entry) {
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(entry);
  return m ? `${m[1]}:\\${m[2].replace(/\//g, '\\')}` : null;
}

/**
 * When the daemon is started from Git Bash/MSYS, PATH arrives MSYS-formatted
 * ("/f/x:/usr/bin:...", colon-separated). A Windows child cannot use that, so
 * real toolchains (node, npm, git in real dirs) silently vanish from the shell.
 * Convert drive-letter entries to Windows form; drop MSYS-internal dirs
 * (/usr/bin, /bin, /mingw64/bin, ...) — the host pwsh should resolve real
 * Windows toolchains, not bash internals. Unrecognized formats pass through.
 */
function toWindowsPathList(raw) {
  if (!raw) return raw;
  const looksMsys = !raw.includes(';') && /(^|:)\//.test(raw);
  if (!looksMsys) return raw;
  const out = [];
  for (const entry of raw.split(':')) {
    const win = entry && msysToWindows(entry);
    if (win) out.push(win);
  }
  return out.length ? out.join(';') : raw;
}

export class PersistentShell {
  constructor({ cwd, timeoutMs = 300000 }) {
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.proc = null;
    this.buffer = '';
    this.stderr = '';
    this._waiter = null;
    this._chain = Promise.resolve();
  }

  _alive() {
    return this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  _spawn() {
    return spawn(
      'pwsh',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'],
      { cwd: this.cwd, env: minimalEnv(), windowsHide: true }
    );
  }

  _ensure() {
    if (this._alive()) return;
    this.buffer = '';
    this.stderr = '';
    this.proc = this._spawn();
    this.proc.stdout.on('data', (d) => this._onData(d.toString()));
    this.proc.stderr.on('data', (d) => { this.stderr += d.toString(); });
    this.proc.on('exit', () => { this.proc = null; this._failWaiter(new Error('shell process exited')); });
    this.proc.on('error', () => { this.proc = null; this._failWaiter(new Error('shell process error')); });
  }

  _failWaiter(err) {
    if (this._waiter) {
      const w = this._waiter;
      this._waiter = null;
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  _onData(chunk) {
    this.buffer += chunk;
    const w = this._waiter;
    if (!w) return;
    const idx = this.buffer.indexOf(w.marker);
    if (idx === -1) return;
    const body = this.buffer.slice(0, idx);
    let tail = this.buffer.slice(idx + w.marker.length);
    const nl = tail.indexOf('\n');
    if (nl === -1 && !tail.includes('\r')) return; // exit code line not complete yet
    const codeLine = (nl === -1 ? tail : tail.slice(0, nl)).trim();
    this.buffer = nl === -1 ? '' : tail.slice(nl + 1);
    const exit = codeLine === '' ? null : parseInt(codeLine, 10);
    const out = body.replace(/\r/g, '');
    const err = this.stderr.replace(/\r/g, '');
    this.stderr = '';
    const waiter = this._waiter;
    this._waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve({ stdout: out, stderr: err, exitCode: Number.isNaN(exit) ? 0 : exit });
  }

  /** Serialize runs so the shared buffer/marker are never interleaved. */
  run(command, timeoutMs) {
    this._chain = this._chain.then(() => this._runOne(command, timeoutMs ?? this.timeoutMs));
    return this._chain.catch((e) => ({ stdout: '', stderr: String(e?.message || e), exitCode: -1, error: true }));
  }

  _runOne(command, timeoutMs) {
    return new Promise((resolve, reject) => {
      this._ensure();
      const marker = `<<<BH_END_${randomBytes(6).toString('hex')}>>>`;
      // Echo the exit code on the line right after the sentinel.
      const line = `${command}\nWrite-Host "${marker}$LASTEXITCODE"\n`;
      const timer = setTimeout(() => {
        if (this._waiter && this._waiter.marker === marker) {
          this._waiter = null;
          // Reset the shell so a hung command does not poison later runs.
          this.kill();
          reject(new Error(`timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this._waiter = { marker, resolve, reject, timer };
      this.proc.stdin.write(line);
    });
  }

  kill() {
    if (this.proc) {
      try { this.proc.kill(); } catch { /* ignore */ }
      this.proc = null;
    }
    this.buffer = '';
    this.stderr = '';
  }
}
