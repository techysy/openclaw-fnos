/**
 * openclaw-fnos: read/modify openclaw.json.
 *
 * Every write goes through updateConfig (merge + atomic rename). Two rules:
 *   - never drop keys we do not understand (OpenClaw adds them per release)
 *   - a truncated config makes the gateway refuse to boot; write atomically
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PATHS, TENROUTER, CONSOLE_BASE, GATEWAY_PORT } from './config.js';

export function readConfig() {
  try {
    return JSON.parse(readFileSync(PATHS.configPath, 'utf8'));
  } catch {
    return {};
  }
}

export function configExists() {
  return existsSync(PATHS.configPath);
}

function writeAtomic(cfg) {
  mkdirSync(dirname(PATHS.configPath), { recursive: true });
  const tmp = `${PATHS.configPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  renameSync(tmp, PATHS.configPath);
}

export function updateConfig(mutator) {
  const cfg = readConfig();
  const result = mutator(cfg);
  writeAtomic(cfg);
  return result ?? cfg;
}

/**
 * Seed the keys the gateway needs to boot, without clobbering operator
 * values. Each of these corresponds to a real failure mode observed in the
 * field:
 *   gateway.mode missing          -> "Gateway start blocked"
 *   trustedProxies missing        -> 403 proxy_attribution_required
 *   controlUi.basePath mismatch   -> blank window (assets 404 under prefix)
 *   allowedOrigins missing        -> "浏览器来源不被允许"
 *   device auth on                -> pairing page demanding SSH approval
 *   auth.token missing            -> dashboard cannot auto-authenticate
 */
export function ensureGatewayDefaults() {
  const seeded = [];
  updateConfig((cfg) => {
    cfg.gateway = cfg.gateway && typeof cfg.gateway === 'object' ? cfg.gateway : {};
    const g = cfg.gateway;
    if (!g.mode) { g.mode = 'local'; seeded.push('mode'); }
    if (!g.bind) { g.bind = 'loopback'; seeded.push('bind'); }
    if (g.port !== GATEWAY_PORT) { g.port = GATEWAY_PORT; seeded.push(`port=${GATEWAY_PORT}`); }
    if (!Array.isArray(g.trustedProxies) || g.trustedProxies.length === 0) {
      g.trustedProxies = ['127.0.0.1', '::1'];
      seeded.push('trustedProxies');
    }
    g.controlUi = g.controlUi && typeof g.controlUi === 'object' ? g.controlUi : {};
    if (!g.controlUi.enabled) { g.controlUi.enabled = true; seeded.push('controlUi.enabled'); }
    if (g.controlUi.basePath !== CONSOLE_BASE) {
      g.controlUi.basePath = CONSOLE_BASE;
      seeded.push(`controlUi.basePath=${CONSOLE_BASE}`);
    }
    if (!Array.isArray(g.controlUi.allowedOrigins) || g.controlUi.allowedOrigins.length === 0) {
      // The NAS origin varies (IP / port / domain / tailnet); the gateway is
      // loopback-only and reachable through this panel's authenticated proxy.
      g.controlUi.allowedOrigins = ['*'];
      seeded.push('controlUi.allowedOrigins');
    }
    if (!g.controlUi.dangerouslyDisableDeviceAuth) {
      g.controlUi.dangerouslyDisableDeviceAuth = true;
      seeded.push('controlUi.dangerouslyDisableDeviceAuth');
    }
    g.auth = g.auth && typeof g.auth === 'object' ? g.auth : {};
    if (typeof g.auth.token !== 'string' || !g.auth.token) {
      g.auth.token = randomUUID().replace(/-/g, '');
      seeded.push('auth.token');
    }
  });
  return seeded;
}

/**
 * Migrate models.providers.<id>.models from object to ARRAY form.
 * OpenClaw's schema requires an array; an object makes the whole config
 * invalid and the gateway refuses to boot ("expected array, received
 * object"). Earlier panel versions wrote the object form.
 */
export function normalizeProviderModels() {
  let migrated = 0;
  updateConfig((cfg) => {
    const providers = cfg?.models?.providers;
    if (!providers || typeof providers !== 'object') return;
    for (const [id, value] of Object.entries(providers)) {
      if (value && typeof value === 'object' && value.models && !Array.isArray(value.models)) {
        value.models = Object.entries(value.models).map(([mid, m]) => ({
          id: mid,
          name: (m && typeof m === 'object' && m.name) || mid,
        }));
        migrated++;
      }
    }
  });
  return migrated;
}

/** Seed 10Router (OpenAI-compatible gateway) as default provider. */
export function seed10Router({ force = false } = {}) {
  if (!TENROUTER.baseUrl || !TENROUTER.apiKey) {
    return { changed: false, reason: 'no api key configured' };
  }
  let changed = false;
  updateConfig((cfg) => {
    cfg.models = cfg.models && typeof cfg.models === 'object' ? cfg.models : {};
    cfg.models.providers = cfg.models.providers && typeof cfg.models.providers === 'object'
      ? cfg.models.providers : {};
    if (cfg.models.providers[TENROUTER.providerId] && !force) return;
    cfg.models.providers[TENROUTER.providerId] = {
      baseUrl: TENROUTER.baseUrl,
      api: 'openai-completions',
      apiKey: TENROUTER.apiKey,
      // ARRAY form required by the OpenClaw config schema.
      models: [{ id: TENROUTER.model, name: `${TENROUTER.model} (10Router)` }],
    };
    cfg.agents = cfg.agents && typeof cfg.agents === 'object' ? cfg.agents : {};
    cfg.agents.defaults = cfg.agents.defaults && typeof cfg.agents.defaults === 'object'
      ? cfg.agents.defaults : {};
    if (!cfg.agents.defaults.model) {
      cfg.agents.defaults.model = `${TENROUTER.providerId}/${TENROUTER.model}`;
    }
    changed = true;
  });
  return { changed };
}

export function listProviders() {
  const cfg = readConfig();
  const providers = cfg.models?.providers ?? {};
  const defaultModel = cfg.agents?.defaults?.model ?? null;
  return Object.entries(providers).map(([id, value]) => ({
    id,
    baseUrl: value?.baseUrl ?? '',
    api: value?.api ?? 'openai-completions',
    hasKey: Boolean(value?.apiKey),
    models: Array.isArray(value?.models)
      ? value.models.map((m) => m?.id ?? String(m)).filter(Boolean)
      : Object.keys(value?.models ?? {}),
    isDefault: typeof defaultModel === 'string' && defaultModel.startsWith(`${id}/`),
  }));
}

/** Add or replace a provider; omitting apiKey on update keeps the stored one. */
export function upsertProvider({ id, baseUrl, api, apiKey, models = [], makeDefault = false }) {
  if (!id || typeof id !== 'string') throw new Error('provider id 不能为空');
  if (!baseUrl || typeof baseUrl !== 'string') throw new Error('baseUrl 不能为空');
  return updateConfig((cfg) => {
    cfg.models = cfg.models && typeof cfg.models === 'object' ? cfg.models : {};
    cfg.models.providers = cfg.models.providers && typeof cfg.models.providers === 'object'
      ? cfg.models.providers : {};
    const existing = cfg.models.providers[id] ?? {};
    const next = { ...existing, baseUrl, api: api || existing.api || 'openai-completions' };
    if (apiKey) next.apiKey = apiKey;
    const list = Array.isArray(existing.models) ? [...existing.models] : [];
    const seen = new Set(list.map((m) => m?.id));
    for (const m of models) {
      if (m && !seen.has(m)) { list.push({ id: m, name: m }); seen.add(m); }
    }
    next.models = list;
    cfg.models.providers[id] = next;
    if (makeDefault && list.length > 0) {
      cfg.agents = cfg.agents && typeof cfg.agents === 'object' ? cfg.agents : {};
      cfg.agents.defaults = cfg.agents.defaults && typeof cfg.agents.defaults === 'object'
        ? cfg.agents.defaults : {};
      cfg.agents.defaults.model = `${id}/${list[0].id}`;
    }
    return { id };
  });
}

export function removeProvider(id) {
  return updateConfig((cfg) => {
    const providers = cfg.models?.providers;
    if (!providers || typeof providers !== 'object') return { removed: false };
    const existed = Boolean(providers[id]);
    delete providers[id];
    return { removed: existed };
  });
}

/** Find the stored apiKey for a given baseUrl (model discovery without
 *  making the user retype the secret). */
export function findKeyForBaseUrl(baseUrl) {
  const cfg = readConfig();
  const want = String(baseUrl || '').replace(/\/$/, '');
  for (const value of Object.values(cfg?.models?.providers ?? {})) {
    if ((value?.baseUrl || '').replace(/\/$/, '') === want && value?.apiKey) return value.apiKey;
  }
  return '';
}

/* ---------------- channels ---------------- */

export function listChannels() {
  const cfg = readConfig();
  const channels = cfg.channels && typeof cfg.channels === 'object' ? cfg.channels : {};
  return Object.entries(channels).map(([id, value]) => ({
    id,
    enabled: value?.enabled !== false,
    fields: publicChannelFields(value),
  }));
}

function publicChannelFields(value) {
  const out = {};
  for (const [k, v] of Object.entries(value ?? {})) {
    if (/key|token|secret|password/i.test(k)) out[k] = v ? '******' : '';
    else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

export function updateChannel(id, patch) {
  return updateConfig((cfg) => {
    cfg.channels = cfg.channels && typeof cfg.channels === 'object' ? cfg.channels : {};
    cfg.channels[id] = { ...(cfg.channels[id] ?? {}), ...patch };
    return { id };
  });
}

export function removeChannel(id) {
  return updateConfig((cfg) => {
    if (!cfg.channels) return { removed: false };
    const existed = Boolean(cfg.channels[id]);
    delete cfg.channels[id];
    return { removed: existed };
  });
}

export function gatewayToken() {
  return readConfig()?.gateway?.auth?.token ?? null;
}
