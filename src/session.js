import { randomBytes } from 'node:crypto';
import { PersistentShell } from './shell.js';
import { SandboxShell } from './shell-sandbox.js';
import { Editor } from './editor.js';
import { Workspace } from './workspace.js';
import { createPolicy } from './guard.js';

/**
 * Logical sessions (in-memory for the MVP pipeline; SQLite later). A session is
 * identified by a secret token embedded in the MCP URL path. Each session owns
 * its own Workspace, persistent shell and editor so state is isolated per URL.
 */
export class SessionStore {
  constructor({ defaultWorkspace, shellMode = 'host', policyMode = 'review', approval = null }) {
    this.defaultWorkspace = defaultWorkspace;
    this.shellMode = shellMode; // 'host' | 'docker' (docker = opt-in container isolation)
    this.policyMode = policyMode; // 'review' | 'read-only' | 'auto'
    this.approval = approval; // { ask({category, reason, command}) -> Promise<boolean> }
    this.byToken = new Map(); // token -> session
  }

  _makeShell(workspacePath) {
    if (this.shellMode === 'docker') {
      return new SandboxShell({ workspacePath });
    }
    return new PersistentShell({ cwd: workspacePath });
  }

  create({ token, workspacePath } = {}) {
    const t = token ?? randomBytes(16).toString('hex');
    const ws = new Workspace(workspacePath ?? this.defaultWorkspace);
    const session = {
      token: t,
      workspacePath: ws.root,
      workspace: ws,
      shellMode: this.shellMode,
      policy: createPolicy(this.policyMode, { workspacePath: ws.root }),
      approval: this.approval,
      shell: this._makeShell(ws.root),
      editor: new Editor(ws),
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    this.byToken.set(t, session);
    return session;
  }

  get(token) {
    const s = this.byToken.get(token);
    if (s) s.lastActiveAt = Date.now();
    return s;
  }

  revoke(token) {
    const s = this.byToken.get(token);
    if (s) { s.shell.kill(); this.byToken.delete(token); }
    return !!s;
  }
}
