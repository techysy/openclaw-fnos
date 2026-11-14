/**
 * openclaw-fnos: managed OpenClaw gateway lifecycle.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync } from 'node:fs';
import { PATHS, OPENCLAW_BIN, GATEWAY_PORT, openclawEnv, openclawSpawnCwd } from './config.js';
import { healAgentSchema } from './heal.js';

const START_TIMEOUT_MS = 90_000;
const STOP_GRACE_MS = 15_000;

function readPid() {
  try {
    const pid = Number(readFileSync(PATHS.pidFile, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

export function isInstalled() {
  return existsSync(OPENCLAW_BIN);
}

export function currentPid() {
  const pid = readPid();
  if (pid && isAlive(pid)) return pid;
  if (pid) { try { unlinkSync(PATHS.pidFile); } catch {} }
  return null;
}

export function gatewayPort() {
  return Number(process.env.OPENCLAW_GATEWAY_PORT || GATEWAY_PORT);
}

/** Any HTTP response means the socket is accepting connections (the root
 *  path may legitimately 404 when a basePath is configured). */
export async function isListening(port = gatewayPort()) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    await res.body?.cancel?.();
    return true;
  } catch {
    return false;
  }
}

export function readVersion() {
  try { return JSON.parse(readFileSync(PATHS.versionFile, 'utf8')); } catch { return { version: null }; }
}

export function writeVersion(version) {
  writeFileSync(PATHS.versionFile, JSON.stringify({ version, installedAt: new Date().toISOString() }, null, 2));
}

export function installedVersion() {
  return readVersion().version;
}

export function logTail(maxLines = 200) {
  try {
    const lines = readFileSync(PATHS.gatewayLog, 'utf8').split('\n');
    return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
  } catch {
    return '';
  }
}

export function status() {
  const pid = currentPid();
  return { running: Boolean(pid), pid, port: gatewayPort(), installed: isInstalled(), version: installedVersion() };
}

let lastExit = null;
function spawnGateway() {
  const fd = openSync(PATHS.gatewayLog, 'a');
  const child = spawn(
    OPENCLAW_BIN,
    ['gateway', 'run', '--port', String(gatewayPort()), '--bind', 'loopback'],
    { cwd: openclawSpawnCwd(), env: openclawEnv(), detached: true, stdio: ['ignore', fd, fd] },
  );
  child.on('exit', (code, signal) => { lastExit = { code, signal }; });
  child.unref();
  writeFileSync(PATHS.pidFile, String(child.pid));
  return child.pid;
}

/**
 * Start the gateway. The schema self-heal must finish BEFORE the gateway
 * opens the database: a newer runtime refuses an older schema, so healing
 * after launch is useless.
 */
export async function startGateway({ onLog = () => {} } = {}) {
  const existing = currentPid();
  if (existing) {
    if (await isListening()) return { ok: true, pid: existing, alreadyRunning: true };
    await stopGateway();
  }

  if (!isInstalled()) {
    return { ok: false, error: 'OpenClaw 尚未安装，请先点击「安装 / 修复当前版本」。' };
  }

  // A gateway we do not own (e.g. the official package on the same port)
  // would make ours die with EADDRINUSE seconds later, buried in its log.
  if (await isListening()) {
    return {
      ok: false,
      error: `端口 ${gatewayPort()} 已被其他进程占用（可能是官方 trim.openclaw 的 Gateway）。请停止官方应用，或设置 OPENCLAW_GATEWAY_PORT。`,
    };
  }

  const heal = await healAgentSchema({ onLog });
  if (!heal.ok) return { ok: false, error: heal.error, log: heal.log };

  onLog('正在启动 Gateway…');
  lastExit = null;
  const pid = spawnGateway();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isListening()) {
      onLog(`Gateway 已就绪（pid ${pid}，端口 ${gatewayPort()}）`);
      return { ok: true, pid, log: heal.log };
    }
    if (!isAlive(pid)) {
      const why = lastExit ? `（退出码 ${lastExit.code ?? lastExit.signal}）` : '';
      onLog(`Gateway 进程已退出${why}`);
      return { ok: false, error: `Gateway 启动后立即退出${why}`, gatewayLog: logTail(80) };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  onLog('Gateway 启动超时。');
  return { ok: false, error: `Gateway 在 ${START_TIMEOUT_MS / 1000}s 内未开始监听端口。`, gatewayLog: logTail(80) };
}

export async function stopGateway() {
  const pid = currentPid();
  if (!pid) return { ok: true, alreadyStopped: true };
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    try { unlinkSync(PATHS.pidFile); } catch {}
    return { ok: true, alreadyStopped: true };
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) { try { unlinkSync(PATHS.pidFile); } catch {} return { ok: true }; }
    await new Promise((r) => setTimeout(r, 500));
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
  try { unlinkSync(PATHS.pidFile); } catch {}
  return { ok: true, forced: true };
}

export async function restartGateway(options) {
  await stopGateway();
  return startGateway(options);
}
