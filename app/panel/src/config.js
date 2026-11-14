/**
 * openclaw-fnos: shared configuration.
 *
 * One managed OpenClaw instance lives under OPENCLAW_DATA_DIR:
 *
 *   <root>/openclaw         package install (node_modules)
 *   <root>/home/.openclaw   OpenClaw state + config (the ONLY config writer
 *                           is this panel; the gateway reads what we write)
 *   <root>/runtime          pid files
 *   <root>/logs             gateway log
 *   <root>/backups          pre-migration snapshots
 *
 * Runtime: Node 24. Deliberately not Bun -- Bun lacks node:sqlite (needed
 * by the schema self-heal) and fails to read injected env on some fnOS
 * mounts. Bun is used only as a package manager CLI inside install.js.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const APP_NAME = 'openclaw-fnos';
export const DISPLAY_NAME = 'OpenClaw';

export const DATA_ROOT = process.env.OPENCLAW_DATA_DIR
  || join(homedir(), '.openclaw-fnos');

export const PATHS = {
  root: DATA_ROOT,
  installDir: join(DATA_ROOT, 'openclaw'),
  homeDir: join(DATA_ROOT, 'home'),
  runtimeDir: join(DATA_ROOT, 'runtime'),
  backupDir: join(DATA_ROOT, 'backups'),
  logDir: join(DATA_ROOT, 'logs'),
  stateDir: join(DATA_ROOT, 'state'),
  configPath: join(DATA_ROOT, 'home', '.openclaw', 'openclaw.json'),
  gatewayLog: join(DATA_ROOT, 'logs', 'gateway.log'),
  pidFile: join(DATA_ROOT, 'runtime', 'gateway.pid'),
  versionFile: join(DATA_ROOT, 'state', 'openclaw-version.json'),
};

export const OPENCLAW_BIN = join(PATHS.installDir, 'node_modules', '.bin', 'openclaw');
export const BUN_BIN = process.env.OPENCLAW_BUN_BIN || '/var/apps/bunjs/target/bin/bun';

export const NPM_REGISTRY = process.env.OPENCLAW_NPM_REGISTRY || 'https://registry.npmmirror.com/';
export const PINNED_VERSION = process.env.OPENCLAW_VERSION || '2026.10.8';

/** Fallback agent-schema floor; the real floor is detected from the
 *  installed runtime (see heal.js detectSchemaFloor). */
export const MIN_AGENT_SCHEMA = Number(process.env.OPENCLAW_MIN_SCHEMA || 25);

/** Path the fnOS unified gateway forwards to this app's unix socket. */
export const BASE_PATH = process.env.BASE_PATH || `/app/${APP_NAME}`;
/** Sub-path under BASE_PATH where the gateway Control UI is proxied. */
export const CONSOLE_SUB = '/console';
export const CONSOLE_BASE = `${BASE_PATH}${CONSOLE_SUB}`;

/** Gateway port. 36420 avoids the official trim.openclaw package (36412). */
export const GATEWAY_PORT = Number(process.env.OPENCLAW_GATEWAY_PORT || 36420);

/** 10Router: default model provider seeded on first run. */
export const TENROUTER = {
  providerId: '10router',
  baseUrl: process.env.TENROUTER_BASE_URL || '',
  apiKey: process.env.TENROUTER_API_KEY || '',
  model: process.env.TENROUTER_MODEL || 'CodeBuddy',
};

/** claw-fry-cards: the maintained Feishu channel plugin (replaces the
 *  official @openclaw/feishu, which is frozen and breaks on 2026.10.x). */
export const FRY = {
  pluginId: 'claw-fry-cards',
  packageSpec: process.env.FRY_PACKAGE_SPEC || 'claw-fry-cards',
  /** The official channel plugin the host may auto-install; it must stay
   *  DISABLED (never uninstall -- that would delete channels.feishu). */
  officialPluginId: 'feishu',
  homepage: 'https://github.com/techysy/claw-fry-cards',
};

export function ensureDirs() {
  for (const dir of Object.values(PATHS)) {
    if (dir === PATHS.configPath || dir === PATHS.gatewayLog || dir === PATHS.pidFile || dir === PATHS.versionFile) continue;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  mkdirSync(join(PATHS.homeDir, '.openclaw'), { recursive: true });
}

/** Environment for every OpenClaw child process. */
export function openclawEnv() {
  return {
    ...process.env,
    HOME: PATHS.homeDir,
    OPENCLAW_STATE_DIR: join(PATHS.homeDir, '.openclaw'),
    OPENCLAW_DATA_DIR: DATA_ROOT,
    NO_COLOR: '1',
  };
}

export function openclawSpawnCwd() {
  return existsSync(PATHS.installDir) ? PATHS.installDir : DATA_ROOT;
}
