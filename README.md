# openclaw-fnos

**OpenClaw for fnOS** — a community-built management panel for running
[OpenClaw](https://openclaw.ai) on fnOS NAS, with automatic database
migration, pinned releases, 10Router model discovery, and one-click
Feishu integration via [claw-fry-cards](https://github.com/techysy/claw-fry-cards).

100% self-written: no third-party panel code is embedded. ~2,000 lines of
plain Node 24 + vanilla JS, no build step, no dependencies beyond the fnOS
runtime apps (`nodejs_v24`, `bunjs`).

## Why this exists

The official fnOS OpenClaw package installs `openclaw@latest` from its
"check for updates" button. When 2026.10.8 shipped, gateways died on boot
with an opaque error, because newer runtimes refuse agent databases whose
schema is below their floor:

```js
// openclaw/dist/openclaw-agent-db-schema-read-*.mjs
if (userVersion < 25 && !isNewUnownedDatabase)
    throw new SqliteSchemaMismatchError(...)
```

The upstream fix (`openclaw doctor --fix`) has to run while no writer holds
the database — and when it fails, the service is simply down. This package
makes the migration part of the startup path, with a snapshot before and a
rollback on failure. Verified chain: **v21 → v25**.

## Features

| Area | What you get |
|---|---|
| **Schema self-healing** | Every start: detect floor from the installed runtime, snapshot agent DBs (db + WAL + SHM), run `doctor --fix`, re-verify by schema version (not exit code), roll back on failure. |
| **Pinned releases** | Fresh installs use the version declared in `app/panel/openclaw-version.env`. "Check update" queries the registry but never silently installs `latest`. |
| **Model providers** | OpenAI-compatible provider management; **拉取模型** fetches `/v1/models` and attaches the stored API key automatically. Ships with a 10Router preset (see `tenrouter.env.example`). |
| **Feishu one-click** | Installs `claw-fry-cards` (the maintained Feishu channel with CardKit v2.0 streaming cards), disables the frozen official `feishu` plugin **without uninstalling it** (uninstall would delete `channels.feishu`), writes config, restarts gateway. |
| **Console in the tile** | The gateway stays loopback-only; the panel proxies its Control UI (HTTP **and WebSocket**) through the fnOS app socket under `/app/openclaw-fnos/console/`. |
| **Honest failures** | Port conflicts, gateway exit codes and log tails surface in the UI instead of a spinner forever. |

## Architecture

```
Browser ── fnOS unified gateway ── app.sock (unix) ──┬── panel API + static UI (Node 24)
                                                     └── /console/* proxy ── OpenClaw gateway (127.0.0.1:36420)
```

* **Runtime is Node 24, not Bun.** Bun lacks `node:sqlite` (needed to read
  schema versions in-process) and fails to read injected env vars on some
  fnOS mounts. Bun is used only as the package-manager CLI for `bun add`.
* **Port 36420** by default so the official `trim.openclaw` package
  (36412) can coexist on the same NAS.
* Config writes are merge-based and atomic; unknown keys added by future
  OpenClaw releases are preserved.
* `HOME`, `BUN_CACHE_DIR`, `XDG_CACHE_HOME` point into the app data dir —
  fnOS service accounts have no real home directory, and Bun/Node caches
  otherwise fail in ways that kill the panel.

## Install

1. Build the fpk (or download a release):

   ```bash
   fnpack build          # requires fnpack from fnOS developer tools
   ```

2. In fnOS App Center → *Manual install* → pick `openclaw-fnos.fpk`.
3. Open the app → **安装 / 修复当前版本** (downloads pinned OpenClaw) →
   **启动服务**.
4. **打开控制台** for the chat UI, or configure Feishu in 消息渠道.

## Configuration

| File | Purpose |
|---|---|
| `app/panel/openclaw-version.env` | Pinned OpenClaw version for fresh installs. |
| `app/panel/tenrouter.env` | 10Router preset (copy from `.example`; gitignored — never commit real keys). |
| `OPENCLAW_GATEWAY_PORT` | Override gateway port (default 36420). |
| `OPENCLAW_NPM_REGISTRY` | Override npm mirror. |

When upgrading OpenClaw to a newer major, the schema floor is detected
automatically from the installed runtime (`userVersion < N` in the
admission check), so no constant needs editing.

## Notes on the Feishu integration

`claw-fry-cards` replaces the official `@openclaw/feishu` channel (frozen
2026-07, broken on 2.0 gateways). Two host behaviors are handled in code:

* OpenClaw may **auto-install the official plugin after host upgrades**,
  preempting the channel — the panel disables it (`plugins disable feishu`).
* The panel **never runs `plugins uninstall feishu --force`**: that command
  also deletes `channels.feishu` (appId/appSecret/group policy), the very
  config claw-fry-cards runs on.

## Development

```bash
# run the panel locally (TCP mode) against a scratch data dir
OPENCLAW_DATA_DIR=/tmp/ocf STATIC_DIR=$PWD/app/panel/ui \
PANEL_PORT=36413 BASE_PATH=/app/openclaw-fnos \
node app/panel/index.js
```

No dependencies to install; `node:sqlite` requires Node ≥ 22.5.

## Disclaimer

Community project, not affiliated with 飞牛 (TRIM) or the OpenClaw project.
OpenClaw's security and stability are upstream's responsibility. The app
runs as its own unprivileged user; data lives in
`/vol4/@apphome/openclaw-fnos/` and survives uninstall (delete it to wipe).

## License

MIT
