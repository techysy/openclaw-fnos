/**
 * openclaw-fnos: agent-database schema self-healing.
 *
 * Why this exists: OpenClaw refuses to start the gateway when an agent
 * database's PRAGMA user_version is below the floor its runtime supports
 * (see openclaw/dist/openclaw-agent-db-schema-read-*.mjs:
 * `if (userVersion < 25 && !isNewUnownedDatabase) throw ...`). Upstream's
 * remedy is a manual `openclaw doctor --fix` while no writer holds the
 * database. Doing it here, before the gateway spawns, turns a hard "cannot
 * start" into a transparent upgrade; on failure we restore the snapshot so
 * data is never lost. Verified chain: v21 -> v25 on OpenClaw 2026.10.8.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PATHS, MIN_AGENT_SCHEMA, OPENCLAW_BIN, openclawEnv, openclawSpawnCwd } from './config.js';

/**
 * Read the schema floor from the installed runtime instead of hardcoding:
 * newer releases raise it, and a stale constant would let the gateway boot,
 * die on admission, and show the user an opaque "exited immediately".
 */
export function detectSchemaFloor() {
  const distDir = join(PATHS.installDir, 'node_modules', 'openclaw', 'dist');
  let names;
  try { names = readdirSync(distDir); } catch { return null; }
  for (const name of names) {
    if (!/^openclaw-agent-db-schema-read-.*\.mjs$/.test(name)) continue;
    try {
      const src = readFileSync(join(distDir, name), 'utf8');
      const m = src.match(/userVersion\s*<\s*(\d+)/);
      if (m) return Number(m[1]);
    } catch {}
  }
  return null;
}

export function schemaFloor() {
  return detectSchemaFloor() ?? MIN_AGENT_SCHEMA;
}

export function discoverAgentDatabases() {
  const agentsDir = join(PATHS.homeDir, '.openclaw', 'agents');
  if (!existsSync(agentsDir)) return [];
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'openclaw-agent.sqlite') found.push(full);
    }
  };
  walk(agentsDir);
  return found;
}

export function readSchemaVersion(dbPath) {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('PRAGMA user_version').get();
    db.close();
    return Number(row.user_version);
  } catch {
    return null;
  }
}

/** Copy db + WAL + SHM together: restoring only the .sqlite file while a
 *  WAL exists produces a corrupt restore. */
function snapshotDatabase(dbPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, join(destDir, `openclaw-agent${suffix}`));
  }
  return destDir;
}

function restoreDatabase(backupDir, dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    const src = join(backupDir, `openclaw-agent${suffix}`);
    if (existsSync(src)) copyFileSync(src, dbPath + suffix);
  }
}

export async function healAgentSchema({ onLog = () => {} } = {}) {
  const log = [];
  const say = (msg) => { log.push(msg); onLog(msg); };

  const floor = schemaFloor();
  const dbs = discoverAgentDatabases();
  if (dbs.length === 0) {
    say('未发现 agent 数据库（全新安装）。');
    return { ok: true, migrated: false, log: log.join('\n') };
  }

  const versions = dbs.map((db) => ({ db, version: readSchemaVersion(db) }));
  for (const { db, version } of versions) {
    say(`检测到 ${basename(dirname(dirname(db)))}: schema v${version ?? '未知'}（运行时要求 >= v${floor}）`);
  }
  const stale = versions.filter((v) => v.version !== null && v.version < floor);
  if (stale.length === 0) {
    say('所有数据库均满足运行时要求，无需迁移。');
    return { ok: true, migrated: false, log: log.join('\n') };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = join(PATHS.backupDir, `schema-${stamp}`);
  const snapshots = stale.map(({ db }) => ({
    db,
    dir: snapshotDatabase(db, join(backupRoot, basename(dirname(dirname(db))))),
  }));
  say(`已备份到 ${backupRoot}`);

  say('正在执行 openclaw doctor --fix（可能需要 1-2 分钟）…');
  const doctorOk = await runDoctor(say);

  // doctor exits nonzero on unrelated findings (missing API keys, channel
  // config), so the schema itself is the verdict, not the exit code.
  const failed = stale.filter(({ db }) => {
    const after = readSchemaVersion(db);
    return after === null || after < floor;
  });

  if (failed.length > 0) {
    say(`迁移未完成（doctor ${doctorOk ? '正常退出但版本未达标' : '失败'}），正在回滚…`);
    for (const snap of snapshots) {
      restoreDatabase(snap.dir, snap.db);
      say(`已还原 ${snap.db}`);
    }
    return {
      ok: false,
      migrated: false,
      log: log.join('\n'),
      error: `agent 数据库 schema 低于 v${floor} 且自动迁移失败，已回滚。备份保留在 ${backupRoot}`,
    };
  }

  for (const { db } of stale) {
    say(`迁移成功: ${basename(dirname(dirname(db)))} -> v${readSchemaVersion(db)}`);
  }
  return { ok: true, migrated: true, log: log.join('\n') };
}

function runDoctor(say) {
  return new Promise((resolve) => {
    if (!existsSync(OPENCLAW_BIN)) {
      say(`未找到 openclaw 可执行文件: ${OPENCLAW_BIN}`);
      resolve(false);
      return;
    }
    const child = spawn(OPENCLAW_BIN, ['doctor', '--fix', '--non-interactive'], {
      cwd: openclawSpawnCwd(),
      env: openclawEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk) => { output += chunk.toString(); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => {
      say(`doctor 启动失败: ${err.message}`);
      resolve(false);
    });
    child.on('close', (code) => {
      for (const line of output.trim().split('\n').slice(-15)) say(`  ${line}`);
      resolve(code === 0);
    });
  });
}
