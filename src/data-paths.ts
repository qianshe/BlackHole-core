import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export interface DataPaths {
  root: string;
  dataRootId: string;
  db: string;
  semanticKey: string;
  proxyConfig: string;
  runtimeState: string;
  logs: string;
  bin: string;
  /** One Manager store for all hosts using this user profile. */
  coreStore: string;
  /** Downloaded update packages, never a second session/configuration root. */
  updates: string;
  /** The existing account layout stays in the one user-data root. */
  accountRoot: string;
  accountSecrets: string;
  accountReceipts: string;
}

export interface ResolveDataPathsOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  coreStoreRoot?: string;
}

function canonicalForIdentity(value: string, platform: NodeJS.Platform): string {
  const normalized = path.normalize(path.resolve(value));
  return platform === 'win32' || platform === 'darwin' ? normalized.toLowerCase() : normalized;
}

function isWithin(candidate: string, parent: string, platform: NodeJS.Platform): boolean {
  const child = canonicalForIdentity(candidate, platform);
  const root = canonicalForIdentity(parent, platform);
  const relative = path.relative(root, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The sole user profile. Tests isolate by supplying a disposable HOME/USERPROFILE,
 * not by inventing a second data-layout policy for test/production packages. */
export function userDataRoot(options: Pick<ResolveDataPathsOptions, 'env' | 'homeDir' | 'platform'> = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? (platform === 'win32' ? env.USERPROFILE : env.HOME) ?? os.homedir();
  if (!home.trim() || !path.isAbsolute(home)) throw new Error('user_home_must_be_absolute');
  return path.join(path.resolve(home), '.blackhole');
}

export function dataRootIdentity(root: string, platform: NodeJS.Platform = process.platform): string {
  return createHash('sha256').update(`blackhole-data-root-v1\0${canonicalForIdentity(root, platform)}`, 'utf8').digest('hex');
}

function requireCanonicalOverride(env: NodeJS.ProcessEnv, key: string, expected: string, platform: NodeJS.Platform): void {
  const value = env[key]?.trim();
  if (value && (!path.isAbsolute(value) || canonicalForIdentity(value, platform) !== canonicalForIdentity(expected, platform))) {
    throw new Error(`noncanonical_storage_path:${key}`);
  }
}

/** Resolve one authoritative ~/.blackhole layout. Alternative data roots are
 * rejected, not imported, searched, silently redirected or used as fallbacks. */
export function resolveDataPaths(options: ResolveDataPathsOptions = {}): DataPaths {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const root = userDataRoot(options);
  requireCanonicalOverride(env, 'BLACKHOLE_HOME', root, platform);

  if (options.coreStoreRoot) {
    const versions = path.join(options.coreStoreRoot, 'versions');
    const staging = path.join(options.coreStoreRoot, 'staging');
    if (isWithin(root, versions, platform) || isWithin(root, staging, platform)) {
      throw new Error('data_root_inside_core_store');
    }
  }

  const db = path.join(root, 'blackhole.db');
  const coreStore = path.join(root, 'core');
  requireCanonicalOverride(env, 'BLACKHOLE_DB', db, platform);
  requireCanonicalOverride(env, 'BLACKHOLE_SHARED_BIN', path.join(root, 'bin'), platform);
  requireCanonicalOverride(env, 'BH_CORE_STORE', coreStore, platform);
  requireCanonicalOverride(env, 'BLACKHOLE_PROXY_CONFIG', path.join(root, 'mcp-proxies.yaml'), platform);
  requireCanonicalOverride(env, 'BLACKHOLE_SEMANTIC_KEY_FILE', path.join(root, 'semantic-key'), platform);
  const accountRoot = root;
  const dataRootId = dataRootIdentity(root, platform);

  return {
    root,
    dataRootId,
    db,
    semanticKey: path.join(root, 'semantic-key'),
    proxyConfig: path.join(root, 'mcp-proxies.yaml'),
    runtimeState: path.join(root, 'runtime-state'),
    logs: path.join(root, 'logs'),
    bin: path.join(root, 'bin'),
    coreStore,
    updates: path.join(root, 'updates'),
    accountRoot,
    accountSecrets: path.join(accountRoot, 'secrets'),
    accountReceipts: path.join(accountRoot, 'cloud-auth-v1'),
  };
}

/** All installed hosts use the SAME existing user profile and Manager store.
 * A release channel changes authentication/release trust, never data location. */
export function resolveHostDataEnvironment(options: {
  environment: 'test' | 'production'; env?: NodeJS.ProcessEnv;
  homeDir?: string; platform?: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const env = { ...(options.env ?? process.env) };
  const data = resolveDataPaths({ ...options, env });
  env.BLACKHOLE_HOME = data.root;
  env.BLACKHOLE_DB = data.db;
  // Keep one authoritative root; there is no separate shared-bin lookup.
  delete env.BLACKHOLE_SHARED_BIN;
  // Test is closed by default, but a trusted native host may opt into
  // manual-only channel starts. Explicit 'off' from a test runner or operator
  // is never overridden; login/heartbeat alone cannot open a tunnel.
  if (options.environment === 'test') env.BLACKHOLE_TUNNEL = env.BLACKHOLE_TUNNEL === 'manual' ? 'manual' : 'off';
  return env;
}

