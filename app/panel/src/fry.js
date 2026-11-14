/**
 * openclaw-fnos: claw-fry-cards Feishu channel integration.
 *
 * claw-fry-cards (https://github.com/techysy/claw-fry-cards) is the
 * maintained Feishu channel plugin for OpenClaw 2026.10.x with CardKit v2.0
 * streaming cards. It REPLACES the official @openclaw/feishu channel, which
 * is frozen (last updated 2026-07-16) and fails to load on 2.0 gateways.
 *
 * Two host behaviors must be handled, both learned the hard way:
 *   1. The OpenClaw host may AUTO-INSTALL and enable the official `feishu`
 *      plugin after upgrades, which then fights claw-fry-cards for the same
 *      channel. We disable it (`plugins disable feishu`).
 *   2. NEVER `plugins uninstall feishu --force` here: that command also
 *      deletes channels.feishu (appId/appSecret/group policy) -- the very
 *      config claw-fry-cards runs on.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { FRY, OPENCLAW_BIN, openclawEnv, openclawSpawnCwd } from './config.js';
import { updateConfig, readConfig } from './config-store.js';
import { restartGateway } from './gateway.js';

function runCli(args, onLine) {
  return new Promise((resolve) => {
    if (!existsSync(OPENCLAW_BIN)) {
      onLine('未找到 openclaw 可执行文件，请先安装 OpenClaw。');
      resolve(1);
      return;
    }
    const child = spawn(OPENCLAW_BIN, args, {
      cwd: openclawSpawnCwd(),
      env: openclawEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const collect = (chunk) => {
      const text = chunk.toString();
      out += text;
      for (const line of text.split('\n')) if (line.trim()) onLine(line.trim());
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => { onLine(`CLI 启动失败: ${err.message}`); resolve(1); });
    child.on('close', (code) => resolve({ code, out }));
  });
}

/** State of both plugins + channel config, for the UI. */
export async function fryStatus() {
  const cfg = readConfig();
  const entries = cfg?.plugins?.entries ?? {};
  const feishuCfg = cfg?.channels?.feishu ?? null;
  return {
    channelConfigured: Boolean(feishuCfg?.appId && feishuCfg?.appSecret),
    appId: feishuCfg?.appId || '',
    channelEnabled: feishuCfg ? feishuCfg.enabled !== false : false,
    fryEntry: entries[FRY.pluginId] ?? null,
    officialEntry: entries[FRY.officialPluginId] ?? null,
    homepage: FRY.homepage,
  };
}

/**
 * One-click Feishu setup: install claw-fry-cards, keep the official plugin
 * disabled, write channels.feishu, enable the plugin entry, restart.
 * Streams progress lines through `emit`.
 */
export async function setupFeishu(
  { appId, appSecret, domain = 'feishu', requireMention = true, restart = true },
  emit,
) {
  if (!appId || !appSecret) {
    emit('请填写 App ID 与 App Secret。');
    return { ok: false, error: '缺少 appId / appSecret' };
  }

  emit(`正在安装通道插件 ${FRY.packageSpec} …`);
  const install = await runCli(
    ['plugins', 'install', FRY.packageSpec, '--force', '--accept-capabilities'],
    emit,
  );
  if (install.code !== 0) {
    emit(`插件安装失败（退出码 ${install.code}）。`);
    return { ok: false, error: `claw-fry-cards 安装失败（退出码 ${install.code}）` };
  }
  emit('插件安装完成。');

  // Merge channel config (same keys the official channel used; the plugin
  // reads channels.feishu unchanged).
  updateConfig((cfg) => {
    cfg.channels = cfg.channels && typeof cfg.channels === 'object' ? cfg.channels : {};
    cfg.channels.feishu = {
      ...(cfg.channels.feishu ?? {}),
      enabled: true,
      domain,
      connectionMode: 'websocket',
      appId,
      appSecret,
      dmPolicy: 'open',
      allowFrom: ['*'],
      groupPolicy: 'open',
      groupAllowFrom: ['*'],
      requireMention,
      streaming: { mode: 'partial' },
    };
    cfg.plugins = cfg.plugins && typeof cfg.plugins === 'object' ? cfg.plugins : {};
    cfg.plugins.entries = cfg.plugins.entries && typeof cfg.plugins.entries === 'object'
      ? cfg.plugins.entries : {};
    cfg.plugins.entries[FRY.pluginId] = {
      ...(cfg.plugins.entries[FRY.pluginId] ?? {}),
      enabled: true,
    };
    // The host may have auto-installed the official channel; disable (never
    // uninstall -- that would wipe channels.feishu) to avoid preemption.
    if (cfg.plugins.entries[FRY.officialPluginId]) {
      cfg.plugins.entries[FRY.officialPluginId] = {
        ...cfg.plugins.entries[FRY.officialPluginId],
        enabled: false,
      };
    }
  });
  emit(`channels.feishu 与 plugins.entries.${FRY.pluginId} 配置已写入。`);

  const cfg = readConfig();
  if (cfg?.plugins?.entries?.[FRY.officialPluginId]?.enabled !== false
    && cfg?.plugins?.entries?.[FRY.officialPluginId]) {
    await runCli(['plugins', 'disable', FRY.officialPluginId], emit);
  }

  if (restart) {
    emit('正在重启 Gateway 使插件生效…');
    const result = await restartGateway({ onLog: (m) => emit(m) });
    if (!result.ok) return { ok: false, error: result.error, gatewayLog: result.gatewayLog };
    emit('Gateway 已重启，飞书通道（🍤 虾条卡片）就绪。');
  } else {
    emit('请重启 Gateway 使插件生效。');
  }
  return { ok: true };
}
