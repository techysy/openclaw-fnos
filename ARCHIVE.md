# 归档说明（2026-11-20）

**本项目已归档。** 飞牛官方 `trim.openclaw` 已恢复更新（当前 **2026.8.35-6**，自带数据迁移），
官方应用成为唯一推荐入口。本仓库保留作为技术记录，不再维护。

---

## 为什么会有这个项目

2026-11 初，官方 `trim.openclaw` 的「检查更新」把 OpenClaw 升到了 `2026.10.8`，
但磁盘上的 agent 数据库还是 schema v21。新版运行时有一道硬门槛：

```js
// openclaw/dist/openclaw-agent-db-schema-read-*.mjs
if (userVersion < 25 && !isNewUnownedDatabase)
    throw new SqliteSchemaMismatchError(...)
```

Gateway 在 `database-readiness` 阶段直接退出，端口从未监听，fnOS 显示"无法启动"。
官方给的出路是手动 `openclaw doctor --fix`，但那条命令要求**没有写者持有数据库**，
而且一旦失败，服务就是停着的——对普通用户来说等于死局。

本项目就是为了填这个坑：把迁移做进启动流程，备份、迁移、校验、失败回滚一条龙。

---

## 最终形态

仓库里这份（`1.0.0`）是**完全自研**的面板——Node 24 + 原生 JS，约 2000 行，
不含任何第三方面板代码，MIT 许可。

```
浏览器 ── fnOS 统一网关 ── app.sock ──┬── 面板 API + 静态 UI（Node 24）
                                      └── /console/* 代理 ── OpenClaw Gateway（127.0.0.1:36420）
```

### 关键设计决策（都有实际代价作为依据）

| 决策 | 原因 |
|---|---|
| **Node 24，不用 Bun** | Bun 没有 `node:sqlite`（schema 自愈要进程内读版本号）；且 Bun 在部分 fnOS 挂载点读不到注入的环境变量 |
| **端口 36420** | 官方用 36412，两者可同机共存 |
| **`HOME` / `BUN_CACHE_DIR` / `XDG_CACHE_HOME` 指向数据目录** | fnOS 服务账号没有真实家目录，缓存写入失败会让面板莫名退出 |
| **schema 下限从运行时动态探测** | 硬编码 `25` 在旧运行时（floor=17）上会误判需要迁移，doctor 失败后误回滚，直接起不来 |
| **迁移前快照 db + WAL + SHM** | 只备份 `.sqlite` 而 WAL 还在，还原出来是坏库 |
| **按 schema 版本判定迁移成败，不看 doctor 退出码** | doctor 会因为缺 API Key、渠道未配置等无关问题返回非零 |

---

## 踩过的坑（按发现顺序）

这部分是项目最有价值的内容，记录清楚免得后人重踩。

### 1. `models.providers.<id>.models` 必须是**数组**

```json
// 错：整个配置非法，Gateway 拒绝启动
"models": { "CodeBuddy": { "id": "CodeBuddy" } }
// 对
"models": [{ "id": "CodeBuddy", "name": "CodeBuddy" }]
```

报错是 `expected array, received object`，但提示出现在 preflight 里，容易被当成别的问题。

### 2. OpenClaw 有**两套**模型配置，缺一个控制台就看不到

| 配置 | 作用 |
|---|---|
| `models.providers.<id>.models` | 定义 provider 有哪些模型 |
| `agents.defaults.models` | **控制台下拉的白名单** |

只写前者，控制台永远只显示旧的那几个。官方面板保存时会同步两者
（`buildSyncedAllowlist`），但用 CLI 直接改配置就漏了。

### 3. `normalizeProviderInput` 只认 `modelId`，不认 `id`

官方保存函数里：

```js
const modelId = typeof item?.modelId === "string" ? item.modelId.trim() : "";
if (!modelId) continue;   // 静默丢弃
```

从原始配置（用 `id` 字段）直接透传进去，会被静默过滤成空数组，
最终报 `provider must include at least one model`——而诊断日志显示
`survivors=2`，看起来完全正常。

### 4. 设备签名校验独立于 `dangerouslyDisableDeviceAuth`

那个开关只影响"是否需要人工批准新设备"，**不跳过已注册设备的签名校验**。
Gateway 数据重建后，浏览器缓存的密钥对就对不上了，日志里会看到：

```
[ws] closed before connect ... code=1008 reason=device signature invalid
```

设备每 14 秒重连一次，一直失败。解法是删掉设备记录 + 清浏览器站点数据。

### 5. X-Frame-Options 与 iframe 嵌入

OpenClaw 的 Control UI 默认 `X-Frame-Options: DENY` + `frame-ancestors 'none'`，
在 fnOS 的 iframe 窗口里表现为**空白页，且不报任何错**——因为浏览器直接拒绝渲染，
连子资源请求都不会发出。日志里只有一条请求，这是识别它的特征。

### 6. 静态资源文件名决定缓存命运

官方把入口 JS/CSS 做成内容哈希名，浏览器按 `immutable` 缓存一年。
改了文件内容但**没改名**，用户永远看到旧界面——除非手动强刷。
正确做法是改名（`index-ocf318.js` → `index-ocf323.js`）。

### 7. Bun 在特定挂载点读不到环境变量

```
/vol4/@appshare/...  → process.env.MONITOR_SOCKET_PATH 为 undefined
/vol4/@appcenter/... → 正常
/tmp                  → 正常
```

同一份代码、同样的调用方式。fnOS 应用都装在 `@appcenter`，生产不受影响，
但本地调试时踩到会浪费很久。

### 8. `$!` 在管道里不是目标进程

```bash
nohup cmd | tee -a log &     # $! 是 tee 的 PID
printf "%s" "$!" > pidfile   # stop 时杀错对象
```

导致多个面板实例叠加存活，旧实例占着 socket，用户连到的永远是旧代码。
后来 `stop_process` 加了按命令行特征的全量清扫兜底。

---

## 与官方包的关系

本项目后期采取过两种形态：

| 形态 | 说明 | 是否公开 |
|---|---|---|
| **1.0.0 自研面板**（本仓库） | 完全自写，无第三方代码 | ✅ MIT 公开 |
| 内嵌官方面板版（3.x） | 内置官方 React UI + server bundle，仅做前缀改名与自愈注入 | ❌ 未公开（属飞牛代码，仅本地使用） |

3.x 版本不进入仓库是刻意的：内置官方编译产物等于二次分发飞牛专有代码。
需要那块能力请直接用官方应用。

---

## 如果以后又遇到 "Gateway 无法启动"

排查顺序（这次是这么一步步定位的）：

```bash
# 1. 看真实退出原因（不是面板的概括）
tail -50 <data>/logs/gateway.log

# 2. 配置是否合法
openclaw config validate --json

# 3. 数据库 schema 版本 vs 运行时下限
sqlite3 <data>/home/.openclaw/agents/main/agent/openclaw-agent.sqlite 'PRAGMA user_version;'
grep -o 'userVersion < [0-9]*' <install>/node_modules/openclaw/dist/openclaw-agent-db-schema-read-*.mjs

# 4. schema 落后就迁移（先备份 db/wal/shm）
openclaw doctor --fix --non-interactive
```

第 1 步最关键。面板层看到的"启动失败"几乎从不是真实原因，
而日志里通常有一行明确的东西——schema 版本、EACCES、端口占用、或者配置结构错误。

---

## 致谢与声明

- OpenClaw 本身由上游维护，本项目只是集成层
- 与飞牛（TRIM）无隶属关系
- 代码 MIT；文档中的排障经验欢迎任意引用

项目归档是好事：**官方修好了，就不该再有第三方的临时方案存在。**
