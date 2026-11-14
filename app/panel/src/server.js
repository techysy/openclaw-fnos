/**
 * openclaw-fnos panel HTTP API + gateway console proxy.
 *
 * Transport: a unix socket (MONITOR_SOCKET_PATH) that the fnOS unified
 * gateway forwards /app/openclaw-fnos/* to. Plain TCP on loopback is also
 * supported for local debugging.
 *
 * The gateway's Control UI is mounted under `${BASE_PATH}/console` and
 * proxied through this same socket (HTTP + WebSocket), so the desktop tile
 * reaches both the panel and the chat console without exposing the gateway
 * port to the LAN.
 */

import http from 'node:http';
import net from 'node:net';
import { existsSync, mkdirSync, rmSync, readFileSync, appendFileSync } from 'node:fs';
import { normalize, join, dirname } from 'node:path';
import {
  APP_NAME,
  BASE_PATH,
  CONSOLE_SUB,
  CONSOLE_BASE,
  PINNED_VERSION,
  TENROUTER,
  FRY,
  PATHS,
  ensureDirs,
} from './config.js';
import {
  status as gatewayStatus,
  startGateway,
  stopGateway,
  restartGateway,
  installedVersion,
  logTail,
  gatewayPort,
  isListening,
} from './gateway.js';
import { healAgentSchema, schemaFloor } from './heal.js';
import { checkLatestVersion, setupAndStart } from './install.js';
import {
  readConfig,
  listProviders,
  upsertProvider,
  removeProvider,
  listChannels,
  updateChannel,
  removeChannel,
  seed10Router,
  findKeyForBaseUrl,
  ensureGatewayDefaults,
  normalizeProviderModels,
  gatewayToken,
} from './config-store.js';
import { fryStatus, setupFeishu } from './fry.js';

const SOCKET_PATH = process.env.MONITOR_SOCKET_PATH || '';
const TCP_PORT = Number(process.env.PANEL_PORT || 0);
const DIAG_LOG = process.env.PANEL_DIAG_LOG || '';
const STATIC_DIR = process.env.STATIC_DIR || join(dirname(import.meta.dirname), 'ui');

function diag(msg) {
  if (!DIAG_LOG) return;
  try { appendFileSync(DIAG_LOG, `${new Date().toISOString()} ${msg}\n`); } catch {}
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers ?? {}) },
  });
}

async function readJson(req) {
  try { return await req.json(); } catch { return {}; }
}

/* ---------------- gateway console proxy ---------------- */

// The browser Origin is the NAS address (varies per deployment: IP, port,
// domain, tailnet) and cannot be pinned in config. Present the gateway's
// own loopback origin instead -- this proxy is the only ingress. Forwarded
// client headers are dropped so the gateway attributes requests as
// direct-local rather than rejecting unattributable proxy traffic (403).
function proxyHeaders(incoming) {
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    const key = k.toLowerCase();
    if (key === 'host' || key === 'origin' || key.startsWith('x-forwarded-') || key === 'x-real-ip') continue;
    out[k] = v;
  }
  out.host = `127.0.0.1:${gatewayPort()}`;
  out.origin = `http://127.0.0.1:${gatewayPort()}`;
  return out;
}

async function proxyToGateway(req, url) {
  if (!(await isListening())) {
    return json({ error: 'Gateway 未运行。请先在「概览」页启动服务。' }, { status: 502 });
  }
  const target = `http://127.0.0.1:${gatewayPort()}${url.pathname}${url.search}`;
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: proxyHeaders(Object.fromEntries(req.headers)),
      body: hasBody ? req.body : undefined,
      duplex: hasBody ? 'half' : undefined,
      redirect: 'manual',
    });
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  } catch (err) {
    return json({ error: `控制台代理失败: ${err.message}` }, { status: 502 });
  }
}

/* ---------------- SSE helper ---------------- */

function sseResponse(handler) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const emit = (message) => {
        if (closed) return;
        const text = String(message).replace(/\r?\n/g, ' ');
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ message: text })}\n\n`));
      };
      const finish = (summary) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, ...summary })}\n\n`));
        closed = true;
        controller.close();
      };
      try {
        await handler(emit, finish);
      } catch (err) {
        finish({ ok: false, error: err?.message ?? String(err) });
      }
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

/* ---------------- router ---------------- */

async function route(req) {
  const url = new URL(req.url);
  let path = url.pathname;
  if (path === BASE_PATH) path = '/';
  else if (path.startsWith(`${BASE_PATH}/`)) path = path.slice(BASE_PATH.length);
  const method = req.method.toUpperCase();
  diag(`${method} ${url.pathname}`);

  // console proxy (HTTP part; WebSocket is handled at the socket level)
  if (path === CONSOLE_SUB || path.startsWith(`${CONSOLE_SUB}/`) || path.startsWith(`${CONSOLE_SUB}?`)) {
    return proxyToGateway(req, url);
  }

  if (path === '/api/health') {
    return json({ status: 'ok', transport: SOCKET_PATH ? 'unix' : 'tcp', app: APP_NAME });
  }

  if (path === '/api/meta') {
    return json({
      app: APP_NAME,
      basePath: BASE_PATH,
      pinnedVersion: PINNED_VERSION,
      schemaFloor: schemaFloor(),
      consoleUrl: `${CONSOLE_BASE}/`,
      gatewayToken: gatewayToken(),
      tenrouter: { baseUrl: TENROUTER.baseUrl, model: TENROUTER.model, hasKey: Boolean(TENROUTER.apiKey) },
      fry: { pluginId: FRY.pluginId, homepage: FRY.homepage },
    });
  }

  if (path === '/api/gateway' && method === 'GET') {
    return json(gatewayStatus());
  }

  if (path === '/api/logs') {
    const lines = Number(url.searchParams.get('lines') || 200);
    return json({ log: logTail(Math.min(Math.max(lines, 10), 2000)) });
  }

  if (path === '/api/gateway/start' && method === 'POST') {
    const log = [];
    const result = await startGateway({ onLog: (m) => log.push(m) });
    if (!result.ok) {
      diag(`start failed: ${result.error}`);
      if (result.gatewayLog) diag(`gateway log tail: ${result.gatewayLog.split('\n').slice(-25).join(' ⏎ ')}`);
    }
    return json({ ...result, log: log.join('\n'), gatewayLog: result.gatewayLog ?? null });
  }

  if (path === '/api/gateway/stop' && method === 'POST') return json(await stopGateway());

  if (path === '/api/gateway/restart' && method === 'POST') {
    const log = [];
    const result = await restartGateway({ onLog: (m) => log.push(m) });
    return json({ ...result, log: log.join('\n'), gatewayLog: result.gatewayLog ?? null });
  }

  if (path === '/api/gateway/heal' && method === 'POST') {
    const log = [];
    const result = await healAgentSchema({ onLog: (m) => log.push(m) });
    return json({ ...result, log: result.log || log.join('\n') });
  }

  /* ---------------- install / update ---------------- */

  if (path === '/api/install/check' && method === 'GET') {
    const d = await checkLatestVersion();
    return json({ ...d, current: installedVersion() });
  }

  if (path === '/api/install/run' && method === 'POST') {
    const body = await readJson(req);
    const version = body.version || PINNED_VERSION;
    return sseResponse(async (emit, finish) => {
      emit(`准备安装 openclaw@${version}`);
      const result = await setupAndStart(version, emit);
      finish({ ok: Boolean(result.ok), error: result.error ?? null, version });
    });
  }

  /* ---------------- models ---------------- */

  if (path === '/api/models' && method === 'GET') {
    return json({ providers: listProviders(), defaultModel: readConfig()?.agents?.defaults?.model ?? null });
  }

  if (path === '/api/models/providers' && method === 'POST') {
    const body = await readJson(req);
    try {
      return json({ ok: true, ...upsertProvider(body) });
    } catch (err) {
      return json({ error: err.message }, { status: 400 });
    }
  }

  if (path === '/api/models/providers/seed' && method === 'POST') {
    const r = seed10Router({ force: true });
    diag(`seed10router -> ${JSON.stringify(r)}`);
    return json({ ok: true, ...r });
  }

  const providerMatch = path.match(/^\/api\/models\/providers\/([^/]+)$/);
  if (providerMatch && method === 'DELETE') {
    return json({ ok: true, ...removeProvider(decodeURIComponent(providerMatch[1])) });
  }

  // Pull models from any OpenAI-compatible baseUrl; the stored key for the
  // same baseUrl is attached automatically (the UI never round-trips a
  // secret, so discovery would otherwise always 401).
  if (path === '/api/models/discover' && method === 'POST') {
    const body = await readJson(req);
    const baseUrl = String(body.baseUrl || '').trim();
    if (!baseUrl) return json({ error: 'baseUrl 不能为空' }, { status: 400 });
    const apiKey = String(body.apiKey || '') || findKeyForBaseUrl(baseUrl);
    try {
      const headers = { Accept: 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      const text = await res.text();
      if (!res.ok) return json({ error: `HTTP ${res.status}: ${text.slice(0, 200)}` }, { status: 502 });
      const data = JSON.parse(text);
      const list = (data?.data ?? data ?? []).map((m) => ({
        id: m?.id ?? String(m),
        contextWindow: m?.context_length ?? m?.context_window ?? null,
      }));
      return json({ models: list.map((m) => m.id), details: list, count: list.length, usedStoredKey: Boolean(apiKey && !body.apiKey) });
    } catch (err) {
      return json({ error: err.message }, { status: 502 });
    }
  }

  /* ---------------- channels ---------------- */

  if (path === '/api/channels' && method === 'GET') {
    return json({ channels: listChannels(), feishu: await fryStatus() });
  }

  const channelMatch = path.match(/^\/api\/channels\/([^/]+)$/);
  if (channelMatch && method === 'POST') {
    const id = decodeURIComponent(channelMatch[1]);
    return json({ ok: true, ...updateChannel(id, await readJson(req)) });
  }
  if (channelMatch && method === 'DELETE') {
    return json({ ok: true, ...removeChannel(decodeURIComponent(channelMatch[1])) });
  }

  // Feishu one-click: install claw-fry-cards + config + restart (SSE).
  if (path === '/api/channels/feishu/setup' && method === 'POST') {
    const body = await readJson(req);
    return sseResponse(async (emit, finish) => {
      const result = await setupFeishu(body, emit);
      finish({ ok: result.ok, error: result.error ?? null });
    });
  }

  /* ---------------- device pairing (fallback if auth is re-enabled) ------ */

  if (path === '/api/devices/pending' && method === 'POST') {
    const { OPENCLAW_BIN, openclawEnv, openclawSpawnCwd } = await import('./config.js');
    const proc = (await import('node:child_process')).spawn(
      OPENCLAW_BIN, ['devices', 'list', '--json'],
      { cwd: openclawSpawnCwd(), env: openclawEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    proc.stdout.on('data', (c) => { out += c; });
    const code = await new Promise((resolve) => { proc.on('close', resolve); proc.on('error', () => resolve(1)); });
    let devices = [];
    try { const j = JSON.parse(out); devices = j?.devices ?? j ?? []; } catch {}
    return json({ ok: code === 0, devices });
  }

  if (path === '/api/devices/approve' && method === 'POST') {
    const body = await readJson(req);
    const requestId = String(body.requestId || '').trim();
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(requestId)) return json({ error: 'requestId 格式不正确' }, { status: 400 });
    const { OPENCLAW_BIN, openclawEnv, openclawSpawnCwd } = await import('./config.js');
    const proc = (await import('node:child_process')).spawn(
      OPENCLAW_BIN, ['devices', 'approve', requestId],
      { cwd: openclawSpawnCwd(), env: openclawEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', (c) => { out += c; });
    const code = await new Promise((resolve) => { proc.on('close', resolve); proc.on('error', () => resolve(1)); });
    diag(`devices approve ${requestId}: exit=${code} out=${out.slice(0, 200)}`);
    return json({ ok: code === 0, exitCode: code, output: out.slice(0, 2000) });
  }

  return json({ error: 'not found', path }, { status: 404 });
}

/* ---------------- static ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(path) {
  let rel = path === '/' ? '/index.html' : path;
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(STATIC_DIR, safe);
  if (!filePath.startsWith(STATIC_DIR)) return null;
  if (!existsSync(filePath)) return null;
  const headers = {
    'cache-control': safe === '/index.html' ? 'no-cache' : 'public, max-age=86400',
  };
  const dot = safe.lastIndexOf('.');
  headers['content-type'] = MIME[safe.slice(dot).toLowerCase()] || 'application/octet-stream';
  return new Response(readFileSync(filePath), { headers });
}

/* ---------------- server ---------------- */

export function startPanel() {
  ensureDirs();

  // Boot-time config hygiene, in this order:
  //   normalize legacy provider shapes -> seed required gateway keys ->
  //   seed 10Router once. All three are idempotent no-ops when clean.
  try {
    const migrated = normalizeProviderModels();
    if (migrated > 0) diag(`normalized ${migrated} provider models object(s) to array`);
    const seededKeys = ensureGatewayDefaults();
    if (seededKeys.length) diag(`gateway config seeded: ${seededKeys.join(', ')}`);
    const seed = seed10Router();
    diag(seed.changed ? 'seeded 10Router' : `10Router not seeded: ${seed.reason ?? 'already present'}`);
  } catch (err) {
    diag(`config bootstrap failed: ${err.message}`);
  }

  const handler = async (req) => {
    try {
      const response = await route(req);
      if (response.status === 404) {
        const url = new URL(req.url);
        let path = url.pathname;
        if (path === BASE_PATH) path = '/';
        else if (path.startsWith(`${BASE_PATH}/`)) path = path.slice(BASE_PATH.length);
        const asset = serveStatic(path);
        if (asset) return asset;
      }
      return response;
    } catch (err) {
      diag(`unhandled error: ${err.stack || err.message}`);
      return json({ error: err?.message ?? String(err) }, { status: 500 });
    }
  };

  const server = http.createServer(async (nodeReq, nodeRes) => {
    const req = await toFetchRequest(nodeReq);
    const res = await handler(req);
    await writeFetchResponse(nodeRes, res);
  });

  // WebSocket relay for the console (the Control UI opens a WS under its
  // basePath; without this the UI renders but never connects).
  server.on('upgrade', (nodeReq, clientSocket, head) => {
    let path = nodeReq.url || '';
    const qAt = path.indexOf('?');
    if (qAt >= 0) path = path.slice(0, qAt);
    if (path === BASE_PATH) path = '/';
    else if (path.startsWith(`${BASE_PATH}/`)) path = path.slice(BASE_PATH.length);
    if (path !== CONSOLE_SUB && !path.startsWith(`${CONSOLE_SUB}/`)) {
      clientSocket.destroy();
      return;
    }
    const up = net.connect({ host: '127.0.0.1', port: gatewayPort() }, () => {
      const lines = [`GET ${nodeReq.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(nodeReq.headers)) {
        const key = k.toLowerCase();
        if (key === 'host' || key === 'origin' || key.startsWith('x-forwarded-') || key === 'x-real-ip') continue;
        lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      }
      lines.push(`host: 127.0.0.1:${gatewayPort()}`);
      lines.push(`origin: http://127.0.0.1:${gatewayPort()}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head && head.length) up.write(head);
      up.pipe(clientSocket);
      clientSocket.pipe(up);
    });
    const bail = () => { try { clientSocket.destroy(); } catch {} try { up.destroy(); } catch {} };
    up.on('error', bail);
    clientSocket.on('error', bail);
  });

  if (SOCKET_PATH) {
    try { rmSync(SOCKET_PATH, { force: true }); } catch {}
    mkdirSync(dirname(SOCKET_PATH), { recursive: true });
    server.listen(SOCKET_PATH, () => diag(`panel listening on unix socket ${SOCKET_PATH}`));
  } else {
    const port = TCP_PORT || 36413;
    server.listen(port, '127.0.0.1', () => diag(`panel listening on http://127.0.0.1:${port}`));
  }
  server.on('error', (err) => {
    diag(`server error: ${err.message}`);
    console.error('[panel] server error', err);
    process.exit(1);
  });

  return server;
}

function toFetchRequest(nodeReq) {
  const url = `http://127.0.0.1${nodeReq.url}`;
  const method = nodeReq.method || 'GET';
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Promise((resolve) => {
    if (!hasBody) return resolve(new Request(url, { method, headers }));
    const chunks = [];
    nodeReq.on('data', (c) => chunks.push(c));
    nodeReq.on('end', () => resolve(new Request(url, { method, headers, body: Buffer.concat(chunks) })));
  });
}

async function writeFetchResponse(nodeRes, res) {
  nodeRes.writeHead(res.status, Object.fromEntries(res.headers));
  if (!res.body) return nodeRes.end();
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      nodeRes.write(Buffer.from(value));
    }
  } catch {
    // Client went away mid-stream (common with SSE); nothing to report.
  } finally {
    nodeRes.end();
  }
}
