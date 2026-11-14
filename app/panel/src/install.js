/**
 * openclaw-fnos: OpenClaw install / update.
 *
 * Version policy: a fresh install uses PINNED_VERSION (known-good). "检查
 * 更新" queries the registry and shows the delta, but the default update
 * spec is STILL the pinned version unless the operator explicitly picks
 * latest -- an unpinned auto-upgrade is exactly how the official package
 * was broken (openclaw@latest + old database = gateway refuses to boot).
 */

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS, BUN_BIN, NPM_REGISTRY, PINNED_VERSION, OPENCLAW_BIN } from './config.js';
import { stopGateway, startGateway, writeVersion } from './gateway.js';

function run(cmd, args, opts, onLine) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '';
    const flush = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onLine(line);
    };
    child.stdout.on('data', flush);
    child.stderr.on('data', flush);
    child.on('error', (err) => { onLine(`进程启动失败: ${err.message}`); resolve(1); });
    child.on('close', (code) => {
      if (buffer.trim()) onLine(buffer.trim());
      resolve(code ?? 1);
    });
  });
}

export async function checkLatestVersion() {
  try {
    const url = `${NPM_REGISTRY.replace(/\/$/, '')}/openclaw/latest`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { ok: false, error: `注册表返回 HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, latest: data.version, pinned: PINNED_VERSION };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function installVersion(version, emit) {
  if (!existsSync(BUN_BIN)) {
    emit(`错误: 未找到 bun（${BUN_BIN}），无法安装 OpenClaw。`);
    return { ok: false, error: 'bun 不可用' };
  }
  await stopGateway();
  emit(`正在安装 openclaw@${version} …`);
  const code = await run(
    BUN_BIN,
    ['add', '--cwd', PATHS.installDir, '--registry', NPM_REGISTRY, `openclaw@${version}`],
    { cwd: PATHS.installDir },
    (line) => emit(line),
  );
  if (code !== 0) {
    emit(`安装失败（退出码 ${code}）`);
    return { ok: false, error: `bun add 失败，退出码 ${code}` };
  }
  if (!existsSync(OPENCLAW_BIN)) {
    emit(`安装后未找到可执行文件: ${OPENCLAW_BIN}`);
    return { ok: false, error: '安装后未找到 openclaw 可执行文件' };
  }
  writeVersion(version);
  emit(`已安装 openclaw@${version}`);
  return { ok: true, version };
}

/** Install (if needed) then start; the start runs schema self-healing. */
export async function setupAndStart(version, emit) {
  const install = await installVersion(version || PINNED_VERSION, emit);
  if (!install.ok) return install;
  emit('正在启动…');
  return startGateway({ onLog: (m) => emit(m) });
}

export async function uninstallPackage(emit) {
  await stopGateway();
  const target = join(PATHS.installDir, 'node_modules');
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    emit('已移除 OpenClaw 程序文件（用户数据保留）');
  } else {
    emit('未找到已安装的程序文件');
  }
  writeVersion(null);
  return { ok: true };
}
