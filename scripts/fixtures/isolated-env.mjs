// Isolated environment for tests that start a real daemon or host runtime.
// Every path the daemon derives from the home directory (~/.blackhole/*,
// ~/.agents/skills) is redirected into a throwaway directory, and a free
// loopback port replaces the production default, so a test can never open
// the user's real database, skills, keys or the daemon serving this session.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const PRODUCTION_PORT = 7306;

export async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { port } = address;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Create an isolated daemon environment.
 * @param {{ name?: string, baseDir?: string, port?: number, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ home: string, dataDir: string, dbPath: string, port: number, env: NodeJS.ProcessEnv, cleanup: () => void }>}
 */
export async function createIsolatedEnv(options = {}) {
  const realHome = os.homedir();
  const port = options.port ?? await freeLoopbackPort();
  assert.notEqual(port, PRODUCTION_PORT, 'isolated tests must not use the production port');
  const base = options.baseDir ?? os.tmpdir();
  assert.ok(!isInside(base, path.join(realHome, '.blackhole')), 'isolated home must not live in the real ~/.blackhole');
  const home = fs.mkdtempSync(path.join(base, `bh-${options.name ?? 'isolated'}-`));
  const dataDir = path.join(home, '.blackhole');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'blackhole.db');

  const env = {
    ...(options.env ?? process.env),
    HOME: home,
    USERPROFILE: home,
    BLACKHOLE_DB: dbPath,
    BLACKHOLE_PORT: String(port),
    BLACKHOLE_TUNNEL: 'off',
    BLACKHOLE_SEMANTIC: 'off',
    BLACKHOLE_SEMANTIC_KEY_FILE: path.join(dataDir, 'semantic-key'),
    BLACKHOLE_PROXY_CONFIG: path.join(dataDir, 'mcp-proxies.yaml'),
    BLACKHOLE_SKILLS_DIR: '',
    // Never touch the user's real OS credential store from tests (plan 6.11).
    BLACKHOLE_ACCOUNT_SECRETS: 'memory',
    BLACKHOLE_ACCOUNT_OFFLINE: '1',
  };
  delete env.BLACKHOLE_PUBLIC_URL;
  delete env.BLACKHOLE_TUNNEL_NAME;
  delete env.BLACKHOLE_CLOUDFLARED;

  return {
    home,
    dataDir,
    dbPath,
    port,
    env,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
