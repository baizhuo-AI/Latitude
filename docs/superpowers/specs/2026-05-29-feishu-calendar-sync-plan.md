I have everything I need. Below is the unified plan, returned directly as my response.

---

# Daybreak 飞书/Lark 日历同步 — 统一实施计划

> 由四片(认证脚手架 / 数据层 / 同步引擎 / UI 与双向)合并去重、按真实依赖重排而成。
> 所有路径为绝对路径,行号锚点基于当前 HEAD。每个任务保留原片的文件锚点与契约。

---

## 0. 合并时解决的跨片冲突(必须先读,否则会按各片各写出两套不兼容的东西)

四片独立分析,在三个地方给出了**不一致**的契约。统一计划在此钉死,后续任务一律以这里为准:

### 冲突 1 — 表的列名各片不一(最大冲突)
数据层片、同步引擎片、UI 片各自给了一套 `calendar_events` 列名(`remote_id` vs `remote_event_id` vs `master_event_id`/`recurrence_master_id`…)。**统一裁决:采用下表的规范列名(取三片超集,字段语义不丢)。** 见 Phase 1 的 T1.1 DDL,这是唯一权威。任何 Rust/TS 代码读写都按这套列名,**不允许再各写各的**。

### 冲突 2 — 同步事件用哪个频道名
三片都写了"改 `App.tsx:67-80` 的 `daybreak://data-changed` 监听"。**实际代码有两条链路**(已读 `src/App.tsx:67-93`、`src/lib/syncBus.ts:15`、`src-tauri/src/lib.rs:46`):
- Rust 写库后 `app.emit("daybreak://data-changed", topic)`(lib.rs:46),主窗在 `App.tsx:71` 监听。
- 主窗收到后再 `emitSync(topic)`(App.tsx:76)→ 走 `syncBus` 的 `"daybreak-sync"` 频道(syncBus.ts:15)广播给浮窗。

**统一裁决:两条链路都保留,日历的 topic 字符串统一为 `"calendar_events"`**,在两个 payload 里都用这个字符串。各片说的"改 daybreak://data-changed"指的是 App.tsx:73-75 的 if/else 分支,不是改 EVENT_NAME 常量。

### 冲突 3 — Rust 模块叫什么、command 命名
认证片把所有 command 放 `feishu::commands`,同步引擎片放 `feishu::engine`,UI 片调的 command 名又略有出入(`feishu_connect` vs `feishu_start_auth`+`feishu_set_credentials`)。**统一裁决:**
- Rust 模块统一在 `src-tauri/src/feishu/` 下,内部按职责分文件(见下方"模块落点")。
- **command 命名统一为认证片的拆分式**:`feishu_set_credentials` / `feishu_start_auth` / `feishu_disconnect` / `feishu_status` / `feishu_sync_now` / `feishu_flush_queue`。UI 片里写的 `feishu_connect`(一个 command 同时收凭证又跑 OAuth)**作废**,改为"先 `feishu_set_credentials` 再 `feishu_start_auth`"两步。`feishu_connection_info` 合并进 `feishu_status`(同一个 command 返回连接态 + 同步态聚合)。

### 冲突 4 — OAuth 完成怎么通知前端
认证片用事件 `feishu-auth-event`,UI 片纠结 command resolve 还是事件 `feishu://auth-done`。**统一裁决:用事件 `feishu-auth-event`**(payload `{ phase: "waiting_browser"|"exchanging"|"success"|"error", region, message? }`),`feishu_start_auth` 命令本身后台 spawn 立即返回,结果靠事件推。前端设 3 分钟超时兜底。

### 统一的 Rust 模块落点(`src-tauri/src/feishu/`)
```
mod.rs        — 模块导出 + Region(host/api_base/序列化) + 公共类型
config.rs     — 非敏感配置(app_id/connected/expires_at)落盘 JSON
keychain.rs   — 凭证 + token 存系统钥匙串(keyring)
oauth.rs      — PKCE / 授权 URL / 换 token / 刷新(纯逻辑+HTTP)
callback.rs   — 固定端口 localhost 回调监听
client.rs     — 出站 HTTP 客户端 + 429 退避 + 鉴权头注入
token_store.rs— (=认证片 keychain.rs 的同步引擎视角;合并进 keychain.rs,不另起)
normalize.rs  — 时区归一 + 重复事件去重 + 远端→行映射
db.rs         — 同步相关表的 sqlx 读写(复用 mcp/db.rs 的 connect)
sync.rs       — 同步核心(列表→日程→token 事务推进)
engine.rs     — 后台 tokio 调度 + flush 队列 + 各 Tauri command
commands.rs   — Tauri command 薄封装层(set_credentials/start_auth/disconnect/status)
```
> 认证片的 `keychain.rs` 与同步引擎片的 `token.rs` 是同一个东西,**合并为 `keychain.rs`**,service 名统一 `com.daybreak.desktop.feishu`,account key = `{region}:{kind}`,kind ∈ `app_secret|access_token|refresh_token`。

---

## 全局硬约束(贯穿所有相位)

1. **表只在前端 `src/lib/db.ts` 建**。Rust 侧 `create_if_missing(false)`(mcp/db.rs:13),绝不建表。Rust 在空库上跑会 `no such table` —— 这是时序依赖,验收要覆盖"先起一次 app 建表,再让 Rust 跑"。
2. **凭证一律进 keychain**,不进 localStorage、不进明文文件。前端 secret 输入框只写不回显。`mcp/connect.rs:11` 的明文 `mcp_token.txt` 是**反例**,不要沿用、也不要动它(那是 MCP 密钥,与飞书无关)。
3. **所有前端写路径** = 写库 → 更内存 store → `emitSync("calendar_events")`。**Rust 写路径**额外 `notify("calendar_events")`。真相源永远是 SQLite。
4. **`scheduled_date`/`scheduled_time` 格式被 `src/lib/calendar.ts:100` `parseScheduledTime` 钉死**:`scheduled_time` 须匹配 `^\d{1,2}:\d{2}-\d{1,2}:\d{2}$` 且 `endMin>startMin`、均 <1440;全天事件 `scheduled_time` 为 null。归一产物必须能被它解析。
5. **reqwest 0.13 无 TLS 后端**(rmcp 间接引入,lock 已锁 0.13.3 但没带任何 TLS feature)。直连 HTTPS 必须显式开 `rustls-tls`,否则运行期才暴露"no TLS backend"。

---

# Phase 0 — 认证与脚手架

> 目标:飞书/Lark OAuth(授权码+PKCE)登录、凭证与 token 存 keychain、Tauri 暴露 set_credentials/start_auth/disconnect/status 能跑通。不含任何日历 API 拉取、表结构、calendarStore。

### 有序任务

**P0-1 — 加 Cargo 依赖** `[改 src-tauri/Cargo.toml:15 起]`
追加(契约):
```toml
reqwest = { version = "0.13", default-features = false, features = ["json", "rustls-tls", "gzip"] }
keyring = { version = "3", features = ["apple-native"] }
sha2 = "0.10"
base64 = "0.22"
url = "2.5"
chrono-tz = "0.10"     # Phase 2 才用,这里一起装省一次编译
open = "5"             # Rust 侧拉起浏览器,绕开 Tauri opener 插件与 capability
```
并改 `tokio`(行 27)追加 `"time"` 特性(后台 interval/退避 sleep 需要)。
关键决策:TLS 选 `rustls-tls`(不依赖系统 OpenSSL,macOS 打包干净);`default-features=false` 避免重复拉默认 native-tls;keyring 3.x feature 是 `apple-native`(不是 2.x 的 `platform-macos`);reqwest 沿用 lock 已锁 0.13.3 不降版。
依赖:无(地基)。

**P0-2 — Region 配置模型** `[新建 src-tauri/src/feishu/config.rs]`
契约:`enum Region { Feishu, Lark }`(serde lowercase,仿 cli_agent/mod.rs:55 CliKind);`Region::host()` → `open.feishu.cn`/`open.larksuite.com`;`Region::api_base()` → `https://{host}/open-apis`;`RegionConfig { app_id, connected, token_expires_at, last_error }`;`FeishuConfig { active_region, feishu, lark }`;`load(config_dir)`/`save(config_dir, cfg)` 落盘 `feishu_config.json`(放 `app_config_dir`,与 `daybreak.db` 同目录,定位仿 connect.rs:38-43)。
关键决策:敏感/非敏感分家——`app_id`(公开)、`connected`、`expires_at` 走明文 JSON;`app_secret`、token 走 keychain。域名只在 `Region` 上定义一处,杜绝硬编码散落。
依赖:P0-1。

**P0-3 — keychain 封装** `[新建 src-tauri/src/feishu/keychain.rs]`
契约:`const KEYRING_SERVICE = "com.daybreak.desktop.feishu"`;`enum Secret { AppSecret, AccessToken, RefreshToken }`;`set_secret/get_secret/delete_secret/clear_region(region)`。account key = `format!("{region}:{kind}")`。`get_secret` 把 keyring 的 `NoEntry` 转成 `Ok(None)`(上层靠"有没有 token"判连接态,不能让"没存过"变报错)。形态仿 connect.rs:11 的幂等存取,但后端换 keyring 且不自动生成。同时给同步引擎用的聚合读:`load_credentials(region) -> Option<Credentials{app_id,app_secret,access_token,refresh_token}>`。
依赖:P0-1、P0-2。

**P0-4 — OAuth core** `[新建 src-tauri/src/feishu/oauth.rs]`
契约:`Pkce{verifier,challenge}`、`gen_pkce()`(challenge=b64url_nopad(sha256(verifier)),method S256)、`gen_state()`;`build_authorize_url(region, app_id, redirect_uri, scopes, state, challenge)`(端点 `authen/v1/authorize`,带 6 个 query);`TokenSet{access_token, refresh_token, expires_in, refresh_token_expires_in}`;`exchange_code(...)`、`refresh(...)`(端点 `authen/v2/oauth/token`);`const SCOPES = &["calendar:calendar:readonly", "offline_access"]`。
关键决策:`offline_access` 必带(否则拿不到 refresh_token);强制带 `client_secret`(无免密公开客户端);refresh 响应也含**新的** refresh_token,飞书 refresh_token 一次性,必须落库覆盖旧值(覆盖动作在 command 层);`expires_in` 转绝对时间戳的动作放调用方,本函数保持纯;授权 v1、换/刷新 v2 版本号不一致是对的,别"统一"。
依赖:P0-1、P0-2。

**P0-5 — localhost 回调监听** `[新建 src-tauri/src/feishu/callback.rs]`
契约:`const CALLBACK_PORT: u16 = 42801`(避开 MCP 的 42800,mcp/mod.rs:18);`redirect_uri()` → `http://127.0.0.1:42801/feishu/callback`;`Callback{code,state}`;`wait_for_callback(expected_state) -> Result<Callback>`,内部校验回调 state == expected_state(防 CSRF),带 5 分钟超时,回调页返回友好 HTML。
关键决策:端口硬编码(redirect_uri 要在飞书后台预注册,不能动态端口),这个常量值要写进给用户的配置说明,逐字一致;裸 TcpListener 实现即可(只处理一个 GET)。
依赖:P0-1。

**P0-6 — Tauri commands(认证)** `[新建 src-tauri/src/feishu/commands.rs]`
契约:`feishu_set_credentials(app, region, app_id, app_secret)`(app_id 落 config,app_secret 落 keychain);`feishu_start_auth(app, region)`(async + 后台 spawn:gen pkce+state → 起回调监听 → `open` 拉起授权 URL → 等回调 → exchange_code → token 存 keychain + connected/expires_at 写 config → 全程 emit `feishu-auth-event`);`feishu_disconnect(app, region)`(clear_region + config 复位);`feishu_status(app) -> FeishuStatus`(聚合每 region 的 has_app_id/has_secret/connected/token_expires_at/last_error,**Phase 2 起额外聚合 sync_state**)。
关键决策:浏览器用 `open` crate(Rust 侧),绕开 Tauri opener 插件与 capability(default.json 零改动);refresh_token 落盘用"两段提交"近似事务——先写 keychain access+refresh、全部成功再写 config,任一步失败回滚已写项并写 `last_error`(token 在 keychain 不是 SQLite,没有 DB 事务,这是等价语义);失败原因落 `config.last_error` 供设置页显示。
依赖:P0-3、P0-4、P0-5。

**P0-7 — 注册模块 + commands** `[新建 src-tauri/src/feishu/mod.rs;改 src-tauri/src/lib.rs:6、:51-55]`
`mod.rs` 导出各子模块 + `pub use config::Region`。`lib.rs:6` 加 `pub mod feishu;`。`generate_handler!`(lib.rs:51-55)追加(**用定义模块全路径**,遵守 mcp/mod.rs:9-11 的 macro 隐藏项规则,不能 `pub use` 后写短名):
```rust
feishu::commands::feishu_set_credentials,
feishu::commands::feishu_start_auth,
feishu::commands::feishu_disconnect,
feishu::commands::feishu_status,
```
关键决策:本相位**不在 `setup()` spawn 任何飞书后台任务**(被动触发,用户点连接才动)。后台同步调度是 Phase 2 的事。
依赖:P0-6。

**P0-8 — 前端配置模型(轻)** `[改 src/lib/settings.ts]`
契约:`type FeishuRegion = "feishu"|"lark"`;`interface FeishuPrefs { activeRegion: FeishuRegion|null }`。在 `SettingsState` 加 `feishu`、`defaults()` 加 `{activeRegion:null}`、`readStored()` 加合并分支、`SettingsStore` 加 `setFeishuRegion`(实现仿 `setChatBackend` 行 184-187 的 set+persist)。
关键决策:前端 store 故意"轻",只记 region 偏好;secret/token/连接状态**绝不进 localStorage**(落实 settings.ts:13 的 TODO),真实状态每次现拉 `feishu_status`。
依赖:仅契约依赖 P0-2 的 `feishu`/`lark` 命名,可与 Rust 并行。

**P0-9 — SettingsPage 连接 UI(最小骨架)** `[改 src/pages/SettingsPage.tsx,仿 McpAccessSection 行 326-380 + 挂载行 131-137]`
新增 `FeishuConnectSection`:region 切换(`SegmentControl` 行 223)、app_id+app_secret 输入(密文切显,仿 `ProviderKeyEditor` 行 518-598)、连接/断开/状态显示、redirect_uri 提示(把 `42801/feishu/callback` 列出供逐字复制,仿"复制命令"交互行 363-374)、监听 `feishu-auth-event` 显示进度(`listen`,仿 App.tsx:67-93)。
关键决策(⚠️ 来自 UI 片风险 3):secret 输入**不接 settings store**,仅组件本地 state,点连接时直接 `invoke("feishu_set_credentials")` 交 Rust 存 keychain,前端不持久化 secret;secret 只写不回显(显示 `hasSecret` 布尔)。
依赖:P0-6、P0-8。

### Phase 0 验收标准
- `cargo build` 通过,`cargo tree -i reqwest` 只一个版本且带 rustls-tls,`cargo tree -i keyring` 是 v3.x apple-native。
- 纯本地状态机闭环:`feishu_set_credentials` → `feishu_status` 的 has_app_id/has_secret 变 true → `feishu_disconnect` → connected 变 false + keychain 三项被清。
- localStorage `daybreak.settings` 键里只有 `activeRegion`,无任何 secret/token。
- **端到端(需真实凭证+人工)**:UI 点连接 → 浏览器弹授权页 → 同意 → 回调页显示成功 → `feishu_status.connected==true` 且钥匙串有 token。此步无法自动化。

### 颗粒度
中等偏大(9 个任务,但多数是纯逻辑 + 可单测,真正卡人工的只有端到端那一下)。Phase 0 是四相位里"可独立无凭证落地"比例最高的。

---

# Phase 1 — 数据层

> 目标:三张核心表 + 变更队列表的 schema、TS 类型与 Row 转换、归一函数骨架、CRUD、新 Zustand store、SyncTopic 扩展、App.tsx 接线、Rust 侧 sqlx 仓储底座。
> **跨片前置关系**:数据层表结构是同步引擎(Phase 2)和双向(Phase 4)的前置,所以排在认证之后、同步之前。变更队列表(`calendar_change_queue`)虽是双向用,但 DDL 一次性在这里建齐,避免后续再动 schema。

### 有序任务

**P1-1 — 四张表 schema** `[改 src/lib/db.ts SCHEMA_V1(行 19-106 末尾追加)+ migrate()(行 120-137)]`

**这是冲突 1 的权威裁决。规范列名如下(三片超集):**

```sql
-- 同步来的日历事件(独立实体,不混 todos)
CREATE TABLE IF NOT EXISTS calendar_events (
  id                  TEXT PRIMARY KEY,        -- 本地 id，前缀 'ce'
  region              TEXT NOT NULL,           -- 'feishu' | 'lark'
  calendar_id         TEXT NOT NULL,           -- 远端日历 id
  remote_event_id     TEXT NOT NULL,           -- 远端 event_id(母事件 id)
  title               TEXT NOT NULL DEFAULT '',
  description         TEXT,
  location            TEXT,
  is_all_day          INTEGER NOT NULL DEFAULT 0,
  start_ts            INTEGER,                 -- 定时事件原始 UTC 秒;全天为 NULL
  end_ts              INTEGER,
  timezone            TEXT,                    -- IANA(定时事件归一用)
  scheduled_date      TEXT,                    -- 归一产物 'YYYY-MM-DD'(本地);喂日历视图
  scheduled_time      TEXT,                    -- 归一产物 'HH:MM-HH:MM';全天为 NULL
  status              TEXT NOT NULL DEFAULT 'confirmed', -- 'confirmed' | 'cancelled'(软删)
  is_recurring_instance INTEGER NOT NULL DEFAULT 0,
  recurrence_master_id  TEXT,                  -- 重复事件母 id(去重键的一半);非重复为 NULL
  instance_start_iso    TEXT,                  -- 实例原始起始时间(去重键的另一半)
  calendar_name       TEXT,                    -- 来源标签显示用
  is_writable         INTEGER NOT NULL DEFAULT 0, -- 逐日历探测结果冗余到事件行
  local_draft         INTEGER NOT NULL DEFAULT 0, -- 冲突降级:本地未推送草稿
  etag                TEXT,                    -- 远端版本号,冲突三态判定用
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cal_events_sched_date ON calendar_events(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_cal_events_calendar ON calendar_events(calendar_id);
CREATE INDEX IF NOT EXISTS idx_cal_events_status ON calendar_events(status);

-- 远端 event ↔ 本地 id 映射 + 去重唯一键
CREATE TABLE IF NOT EXISTS event_map (
  id              TEXT PRIMARY KEY,            -- 前缀 'em'
  region          TEXT NOT NULL,
  calendar_id     TEXT NOT NULL,
  remote_event_id TEXT NOT NULL,
  dedup_key       TEXT NOT NULL,               -- 重复实例: master_id + ':' + instance_start_iso;否则 = remote_event_id
  local_id        TEXT NOT NULL,               -- → calendar_events.id
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (region, calendar_id, dedup_key) -- 核心:同一(区域,日历,去重键)唯一 → 去重
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_map_local ON event_map(local_id);

-- 每日历一行的增量同步游标;列表级游标复用保留行 calendar_id='__list__'
CREATE TABLE IF NOT EXISTS sync_state (
  region          TEXT NOT NULL,
  calendar_id     TEXT NOT NULL,               -- 业务日历 id 或 '__list__'(列表游标)
  sync_token      TEXT,                        -- 增量游标;NULL=还没全量过
  last_synced_at  TEXT,
  status          TEXT NOT NULL DEFAULT 'idle', -- 'idle' | 'syncing' | 'error'
  last_error      TEXT,
  is_writable     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (region, calendar_id)
);

-- 日历元信息(发现增删 + 可写探测的权威来源)
CREATE TABLE IF NOT EXISTS calendar_meta (
  region          TEXT NOT NULL,
  calendar_id     TEXT NOT NULL,
  summary         TEXT,                        -- 日历名
  cal_type        TEXT,                        -- 'primary'|'shared'|...(判可写)
  access_role     TEXT,                        -- 'owner'|'writer'|'reader'(判可写)
  is_deleted      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (region, calendar_id)
);

-- 本地变更队列(Phase 4 写回用,DDL 一次性在此建齐)
CREATE TABLE IF NOT EXISTS calendar_change_queue (
  id              TEXT PRIMARY KEY,
  op              TEXT NOT NULL,               -- 'create'|'update'|'delete'
  local_id        TEXT NOT NULL,
  calendar_id     TEXT NOT NULL,
  remote_event_id TEXT,                        -- update/delete 必填
  payload_json    TEXT NOT NULL,
  base_etag       TEXT,                        -- 入队时持有的 etag(冲突基线)
  state           TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'sending'|'done'|'conflict'|'failed'
  retry_count     INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_change_queue_state ON calendar_change_queue(state);
```
> 合并决策记录:① 列名采用 UI 片的 `remote_event_id`/`recurrence_master_id`/`instance_start_iso`(因 UI 片直接消费,命名最贴前端)+ 数据片的 `start_ts/end_ts/timezone`(保留原始时间供重新归一)。② 去重键 `dedup_key` 用同步引擎片的拼接定义。③ 列表级游标用数据片的 `__list__` 保留行方案,**不另开表**;但日历元信息独立成 `calendar_meta`(同步引擎片方案,因为可写探测需要 type/role 字段,塞 sync_state 不合适)。④ `migrate()` 末尾留"日历表加列追加在此"注释块,仿 getColumns 范式(db.ts:112)。

依赖:无(本相位起点,但整体排在 Phase 0 后)。**适合 TDD**:对 in-memory sqlite 跑 `SCHEMA_V1.split(";")` 每条不报错;唯一索引生效(重复插同 `(region,calendar_id,dedup_key)` 抛 UNIQUE 冲突)。

**P1-2 — TS 类型 + Row 转换 + 归一函数骨架** `[改 src/lib/db.ts 末尾,仿 rowToGoal 行 305-336]`
契约:`type CalRegion`、`type CalEventStatus`;`interface CalendarEvent`(camelCase 全字段,见各片,以 P1-1 列名为准)、`interface SyncStateRecord`;`rowToCalendarEvent(row)`(`is_*===1`→bool)、`rowToSyncState`;**纯函数归一** `normalizeEventTiming({isAllDay,startTs,endTs,startDate?,timezone})` → `{scheduledDate?, scheduledTime?}`(全天直接取 date 不偏移;定时由 UTC+timezone 折算本地)。
依赖:P1-1。**强 TDD 任务**:见下方 TDD 节。

**P1-3 — CRUD 函数(前端)** `[改 src/lib/db.ts,仿 dbListGoals/dbUpsertReflection 行 338-379/562]`
契约:`dbListCalendarEvents(opts?)`(默认过滤 `status!='cancelled'`)、`dbUpsertCalendarEvent(e)`(`ON CONFLICT(region,calendar_id,dedup_key)` 维护 event_map,返回 local_id)、`dbBulkUpsertCalendarEvents`(走 P1-5 的 `dbTx`)、`dbSoftDeleteCalendarEvent`、`dbFindLocalId`、`dbGetSyncState`/`dbListSyncStates`/`dbUpsertSyncState`/`dbSetSyncStatus`。复合主键 upsert 用 `INSERT...ON CONFLICT DO UPDATE`。
依赖:P1-2、P1-5。

**P1-4 — SyncTopic 扩展** `[改 src/lib/syncBus.ts:17]`
现状已确认是 6 个变量(todos/goals/conversations/reflections/activities/reminder)。加第 7 项 `"calendar_events"`。`emitSync`/`onSync` 泛化,改类型即可。
依赖:无(可与 P1-1 并行)。

**P1-5 — 事务封装 dbTx** `[改 src/lib/db.ts,放 getDb() 之后]`
**关键事实**(已读 plugin-sql d.ts):`@tauri-apps/plugin-sql` 的 `Database` 只有 `execute`/`select`,**没有 `transaction()`**。所以:
```ts
export async function dbTx(fn: (db: Database) => Promise<void>): Promise<void> {
  const db = await getDb();
  await db.execute("BEGIN");
  try { await fn(db); await db.execute("COMMIT"); }
  catch (e) { try { await db.execute("ROLLBACK"); } catch {} throw e; }
}
```
关键决策:前端"批量写 + token 推进同事务"靠这个落地(SQLite 非嵌套事务,fn 内不要再调 dbTx);Rust 那条路径用 sqlx 真事务(P1-7)。**适合 TDD**:mock getDb 记录 execute 序列,断言成功=BEGIN→fn→COMMIT、失败=BEGIN→ROLLBACK 且重抛。
依赖:无。

**P1-6 — calendarEventsStore** `[新建 src/lib/calendarEventsStore.ts,完整仿 activityStore/goalsStore]`
契约:`interface CalendarEventsStore { events; syncStates; loaded; hydrate(); upsertEvents(events); softDelete(localId); refreshSyncStates(); }`。`hydrate` try/catch 兜底(失败 set 空+loaded:true,仿 goalsStore.ts:31-39);写 mutation = 写库→set→`emitSync("calendar_events")`;不自持久化,纯内存缓存。
> 命名统一:四片出现过 `calendarStore` / `calendarEventsStore` / `useCalendarStore`。**统一用 `src/lib/calendarEventsStore.ts` 导出 `useCalendarEventsStore`**(UI 片命名,最明确)。Phase 2/3 里同步引擎片写的 `useCalendarStore` 一律改成这个名字。
依赖:P1-2、P1-3、P1-4、P1-5。

**P1-7 — Rust sqlx 仓储底座** `[新建 src-tauri/src/feishu/db.rs,复用 mcp/db.rs:13 的 connect]`
契约(全部接受 `&mut Transaction` 让 Phase 2 能把"写事件+推进 token"放进同一 `pool.begin()`):`upsert_event(tx, &CalendarEventInput) -> local_id`、`soft_delete_event(tx, region, cal_id, remote_id) -> bool`、`find_local_id(pool, ...)`、`advance_sync_token(tx, region, cal_id, new_token, last_sync)`、`set_sync_status(pool, ...)`、`get_sync_state(pool, ...)`、`set_calendar_writable(pool, region, cal_id, writable)`(同时落 sync_state 和该日历下 events)。读 SQL 用运行时 `sqlx::query(sql).bind(..)`(非宏,仿 server.rs:219/237)、`Row::get`(server.rs:54)。id 用 `gen_id("ce")/("em")`、时间用 `now_iso()`(server.rs:34/39)——**建议把这两个私有 fn 从 server.rs 提到共享 util 供 feishu 复用**(小重构,纳入本任务)。
关键决策:复用 `mcp/db.rs` 同款 `SqliteConnectOptions`(WAL+busy_timeout+`create_if_missing(false)`),绝不建表。
依赖:P1-1(表必须先建)。**可写 `#[cfg(test)]` 单测**(临时文件 sqlite + 手动建表),但事务原子性的端到端编排归 Phase 2。

**P1-8 — App.tsx 接线** `[改 src/App.tsx MainApp,三处]`
顶部 import `useCalendarEventsStore`。① 首屏 hydrate(加进 :62-64 effect)。② Rust notify 分支(:73-75 if/else)加 `else if (topic === "calendar_events") void useCalendarEventsStore.getState().hydrate();`。③ 跨窗口 onSync(:84-93)加 `onSync("calendar_events", ...)` + cleanup。
> 注:浮窗 `FloatingApp` 是否订阅日历同步由 UI 决定,本相位只接主窗 `MainApp`。
依赖:P1-4、P1-6。

### Phase 1 验收标准
- `await getDb()` 后 `sqlite_master` 含四张新表,`event_map` 有 `uq_event_map_local`,重复插同 dedup_key 抛 UNIQUE 冲突。
- 旧库(已有 todos 数据)升级后四张新表存在且旧数据不丢(`SELECT COUNT(*) FROM todos` 不变)。
- `tsc` 通过;`useCalendarEventsStore().loaded` 可读;localStorage 无任何日历数据(纯内存)。
- 时序验收:正常起一次 app(前端建表)→ Rust 仓储函数在该库上跑无 `no such table`。
- 链路验收(无需凭证):手动 INSERT 一条事件 + 手动 emit `daybreak://data-changed` payload `"calendar_events"` → 主窗 store 自动 hydrate;开浮窗,`upsertEvents` → 浮窗收 onSync 重 hydrate。

### 颗粒度
大(8 个任务,DDL + 双端类型对齐 + 仓储,是最"宽"的一相,但单点都不深)。

---

# Phase 2 — 只读全量 + 增量(核心可用版)

> 目标:出站 HTTP 客户端 + 同步引擎核心循环 + 时区/重复事件归一 + 后台触发 + `feishu_sync_now`,把真实飞书日历只读拉下来渲染。这是"核心可用版"——用户能看到飞书日程叠加在本地待办上。

### 有序任务

**P2-1 — 出站 HTTP 客户端 + 429 退避** `[新建 src-tauri/src/feishu/client.rs]`
契约:`FeishuClient{ http: reqwest::Client, region }`;`get_json(token, path, query) -> Result<Value, FeishuError>`(自动拼 `https://{host}/open-apis/{path}`、注入 `Authorization: Bearer`、处理 429 读 `Retry-After`/`X-Ogw-Ratelimit-Reset` 优先、指数退避兜底、飞书 body `code!=0` 转 Err);`backoff_delay(attempt, retry_after_header) -> Duration`(base=1s,factor=2,max_retries=5,cap=60s);`enum FeishuError { Http, RateLimited{retry_after}, Api{code,msg}, TokenExpired }`。
关键决策:退避优先采纳响应头建议值,重试耗尽前不抛 `RateLimited`;低并发不在 client 做信号量,由 engine 层保证"同一时刻一个同步任务、日历串行"。
依赖:P0-1(reqwest)。**适合 TDD**:`backoff_delay` 纯函数(递增且 ≤cap;给 header 返回约 N 秒);`Region::host/from_str` 双向映射。

**P2-2 — 时区归一 + 远端事件→行映射** `[新建 src-tauri/src/feishu/normalize.rs]`
契约:`RawTime{date?, timestamp?, timezone?}`;`NormalizedTime{scheduled_date, scheduled_time?, is_all_day, start_ts?, end_ts?}`;`normalize(start, end) -> NormalizedTime`;`map_event(region, calendar_id, is_writable, &Value) -> Option<MappedEvent>`(`MappedEvent{remote_event_id, dedup_key, title, status, time, master_event_id?, original_start_ts?, etag?}`)。
关键决策(写注释,**这是单测重灾区**):① **全天事件零偏移**——飞书全天 `start.date` 是 UTC+0 日历日,直接当本地 `scheduled_date`,绝不 `Utc→Local` 转,否则 UTC+8 用户看到日期前移一天。② 跨天定时事件——`parseScheduledTime` 无法表达跨天(要求 endMin>startMin 且 ≤1440),决策:`scheduled_time` 落起始日、end 截到 `23:59`,注释写明这是已知近似。③ 去重键:非重复 `dedup_key=remote_event_id`,重复实例 `dedup_key=master_id+":"+original_start_ts`。
依赖:P0-1(chrono-tz)。**强 TDD 任务**:见 TDD 节。

**P2-3 — 同步核心** `[新建 src-tauri/src/feishu/sync.rs;读写走 P1-7 的 db.rs]`
契约:`sync_calendar_list(client, pool, region, token) -> Vec<active_calendar_id>`(首次 page_token 翻页全量→之后 sync_token 增量;写 calendar_meta 增/改/删;列表 sync_token 推进与 calendar_meta 写入**同一事务**);`sync_one_calendar(client, pool, region, token, calendar_id) -> SyncStats`(sync_token 为空走全量+可见时间窗,否则增量;重复事件让服务端在窗内展开;每条 `map_event` → upsert event_map(ON CONFLICT 保持 local_id)→ upsert calendar_events → cancelled 软删;最后推进 sync_state.sync_token+last_synced_at;**全部在一个 `pool.begin()` 事务里 commit**)。
关键决策:① **token 推进与写库同一事务**(硬要求)——token SQL 与事件 upsert 在同一 `tx`。② **tombstone 防乱序回插**——增量乱序时(先 cancelled 后到旧 confirmed),用 `etag`/`updated_at` 比较,`WHERE excluded.updated_at >= calendar_events.updated_at` 才更新,cancelled 行保留(软删不删行)。③ **sync_token 失效处理**——捕获飞书"token 失效"错误码 → 清空该日历 sync_token 回退全量重拉(具体错误码联调时补,标需凭证)。
依赖:P1-1、P1-7、P2-1、P2-2。**适合 TDD**(mock client + in-memory sqlite + 手动建表):全量首拉 N 条→N 行+token 写;增量新增 1 条 cancelled→该行 status='cancelled' 不消失;**事务原子性**(中途注入错误→sync_token 未推进);**乱序**(先 cancelled 新 updated_at 再 confirmed 旧 updated_at→仍 cancelled);**去重**(同 dedup_key 两次→event_map 仍 1 行)。

**P2-4 — 后台调度 + token 刷新衔接 + flush + 各 command** `[新建 src-tauri/src/feishu/engine.rs;改 lib.rs setup() + invoke_handler]`
契约:`run_scheduler(db_path, notify)`(启动跑一次 + `tokio::time::interval` 定时 5min + 手动唤醒;整个 scheduler 单任务,region 串行、region 内日历串行);`sync_once(pool, notify)`(读凭证→sync_calendar_list→逐日历 sync_one_calendar→结束 `notify("calendar_events")`,单点失败只记 `sync_state.last_error` 不 panic);`#[tauri::command] feishu_sync_now(app) -> SyncSummary`。在 `lib.rs setup()`(行 32-49)spawn `feishu::engine::run_scheduler`,复用现成 notify 闭包(lib.rs:45-47);`invoke_handler`(lib.rs:51-55)加 `feishu::engine::feishu_sync_now`。
关键决策:① **refresh_token 跨存储折中**——`sync_one_calendar` 的 `tx.commit()` **成功之后**才 `keychain.set(refresh_token, new)`,中间不插 await/IO;commit 失败则不更新 token(下次用旧的重试)。keychain 与 SQLite 无法真同一事务,这是缩小窗口的近似(注释写明)。多存"上一个 refresh_token"做一次性回退。② client 返回 `TokenExpired` 时,engine 调 `oauth::refresh`(P0-4)拿新 token 对再重试本轮。③ 手动同步与定时撞上用 `tokio::sync::Mutex<()>` 串行化"同一时刻一轮"。
依赖:P0-3、P0-4、P1-7、P2-1、P2-3。**适合 TDD**:`sync_once` mock client+in-memory db 跑通;并发 Mutex 串行化;notify 用计数回调断言被调(仿 mcp::start 传计数回调范式)。

**P2-5 — CalendarPage 只读渲染 + 去重 + 来源/可写视觉区分** `[改 src/pages/CalendarPage.tsx]`
契约:接入 `useCalendarEventsStore`;`eventsByDate` useMemo(仿 todosByDate 行 81-90,**抽成纯函数 `dedupeEventsByDate` 放 calendar.ts 供单测**,去重键 `${recurrenceMasterId ?? id}|${instanceStartIso ?? ''}`);周视图 `DayColumn`(行 449-633)在 todo 卡之后追加 event 卡渲染,全天事件聚到顶部 all-day 行;月视图圆点区(行 419-438)叠加 event 圆点;新增**只读不可拖** `CalendarEventBlock`(仿 DraggableTaskBlock 行 635-685 但不用 useDraggable)+ `eventCardCls(ev)`(isWritable=false 灰虚线+锁图标,=true 蓝实线);来源标签显示 calendarName;i18n key `calendar.source`/`calendar.readonly`/`calendar.allDay`。
关键决策(UI 片风险 6):全天判定走 `isAllDay` 字段**不靠 parse 失败**,绝不喂给 `UnscheduledSidebar`(那只服务 todos)。
依赖:P1-6。**适合 TDD**:`dedupeEventsByDate` 纯函数(两条同 `(masterId, instanceStartIso)` → 输出一条)。

**P2-6 — SettingsPage 同步状态 + 手动同步** `[改 src/pages/SettingsPage.tsx FeishuConnectSection;新建 src/lib/calendarSync.ts]`
在 P0-9 骨架上补:同步状态/上次同步时间/错误(从 `feishu_status` 聚合的 sync_state 读)、手动同步按钮调 `feishu_sync_now`。`calendarSync.ts` 封装对 command 的薄 invoke + 类型(`FeishuConnectionInfo` 合并进 `feishu_status` 返回)。
依赖:P2-4、P0-9。

### Phase 2 验收标准
- **可单测部分全绿**:backoff、归一(≥2 时区)、map_event、dedupe、sync 核心的全量/增量/事务/乱序/去重(mock client)、sync_once 并发串行、notify 计数。
- 启动 app 看日志:scheduler 起来,无凭证时安静跳过不报错。
- **端到端(需真实凭证+人工)**:配好凭证后定时 tick 触发同步,DB 出现日历事件,日历页渲染(只读卡灰虚线+锁、可写卡蓝实线、全天卡顶部 all-day 行、来源标签);点"立即同步"返回 summary 并刷新;飞书侧删一个日程→增量同步→本地软删→视图消失;todos 卡片样式不受影响(回归);只读卡拖不动不触发 handleDragEnd。

### 颗粒度
最大(6 个任务但每个都重:HTTP+退避、归一、事务化同步引擎、调度、双端渲染)。这相是整个功能的核心工作量集中区。

---

# Phase 3 — 准实时长连接(先 POC)

> 目标:在"定时轮询可用"的基础上,POC 验证飞书是否提供可用的推送/长连接(webhook 事件订阅 / 长轮询),把"5min 定时"升级成"准实时"。**先 POC,不强求投产**——飞书的事件订阅需要公网回调地址或 WebSocket 长连接,桌面端能否用、用哪种,要先验证清楚再决定是否纳入。

> 说明:四片原计划**都没有这一相**(都止于定时轮询)。这是合并时按用户要求新增的探索相,因此任务以"调研 + POC"颗粒度给出,不写死契约。

### 有序任务

**P3-1 — 调研飞书推送能力(纯文档,无代码)**
产出:飞书/Lark 日历是否支持事件订阅(`im`/`calendar` 事件回调)、长连接(WebSocket)、或仅长轮询;桌面端(无公网 IP)能否接收——大概率只能用**长连接 WebSocket**(飞书有 `wss` 长连接 SDK 模式),webhook 回调因需公网地址在桌面端不可行。明确结论:走哪条、需要什么 scope/权限、是否需要额外审批。
依赖:无(可在 Phase 2 进行中并行调研)。**这是纯调研,不需要凭证就能读文档得结论,但验证连通性需要凭证。**

**P3-2 — 长连接 POC(一次性验证程序,档位 2)** `[新建 src-tauri/examples/feishu_longconn_smoke.rs,仿 examples/mcp_smoke.rs]`
契约级目标:用真实 token 建立飞书长连接,收到一条日历变更事件就打印并退出。**不接入主流程**,只验证"能不能收到推送、推送 payload 长什么样"。
关键决策:POC 阶段绝不动 engine.rs;验证通过后才在 Phase 3 后续把"收到推送→触发一次 `sync_once`(增量)"接进 engine(推送只当"提前触发增量"的信号,不替代增量同步逻辑,避免重写一套解析)。
依赖:P2-4(engine 已能跑 sync_once)、P3-1 结论。**端到端需真实凭证 + 可能需企业级事件订阅 scope 审批。**

**P3-3 — 推送触发接入 engine(POC 通过后才做)** `[改 src-tauri/src/feishu/engine.rs]`
契约:`run_scheduler` 增加一路"长连接监听"task,收到日历事件 → 通过已有 Mutex 唤醒 `sync_once`(走增量)。失败/断连退回纯定时轮询(降级保底)。
关键决策:长连接是"加速器"不是"替代品"——断连、鉴权失效、企业未开订阅时,必须无缝退回 Phase 2 的定时轮询,用户无感。
依赖:P3-2 验证通过。

### Phase 3 验收标准
- P3-1 产出明确结论文档(走 WebSocket 还是退回轮询;需要哪些权限/审批)。
- POC(需凭证):`feishu_longconn_smoke` 能建连并打印至少一条真实日历变更事件。
- 若接入:飞书侧改一个日程,本地在数秒内(而非等 5min tick)刷新;断开网络→长连接断→自动退回定时轮询,恢复后重连。

### 颗粒度
小到中(主体是调研 + 一个 POC + 一段接入)。**风险高度集中在"飞书桌面端到底能不能准实时"这个未知数上**——所以先 POC,POC 不通就停在 Phase 2 的轮询,不强行投产。

---

# Phase 4 — 双向(写回)

> 目标:本地编辑可写事件 → 乐观更新 + 入变更队列 → 写回飞书(create/PATCH/DELETE)→ etag 三态冲突处理(默认远端为准、冲突保留本地草稿)→ 离线入队联网重放 → 重复事件仅改单次。

### 有序任务

**P4-1 — 逐日历 is_writable 探测(消费)** `[Rust 探测在 P2-3 sync_calendar_list 补;前端仅消费]`
契约:同步引擎拉日历列表时,按 `cal_type ∈ {primary,shared}` 且 `access_role ∈ {writer,owner}` 判定 is_writable,写 `calendar_meta` + 冗余到 `calendar_events.is_writable`(P1-7 的 `set_calendar_writable`)。前端只读 `event.isWritable` gate 编辑(P2-5 已用其分样式)。
依赖:P2-3。本片仅消费,无独立前端改动。

**P4-2 — 本地变更队列(前端读写)** `[改 src/lib/db.ts;新建 src/lib/calendarQueue.ts]`
表已在 P1-1 建齐(`calendar_change_queue`)。契约:`dbEnqueueChange`/`dbListPendingChanges`(state in pending,failed)/`dbUpdateChangeState`/`dbDeleteChange`;高层 `enqueueEventEdit(ev, op)`(组 payload + base_etag 取自 ev.etag + emitSync)。
关键决策:**前端写队列 + 触发,Rust 读队列执行写回**(token/HTTP 在 Rust,职责清晰)。队列表前后端共享同库(WAL 并发安全)。
依赖:P1-1、P1-2。**适合 TDD**:`enqueueEventEdit` 组 payload 纯逻辑(给 CalendarEvent+op → 期望 ChangeQueueItem 形状,含 base_etag)。

**P4-3 — 写回执行 + command** `[新建/改 src-tauri/src/feishu/engine.rs feishu_flush_queue;改 CalendarPage.tsx 编辑入口]`
契约:`#[tauri::command] feishu_flush_queue() -> FlushResult{pushed,conflicted,failed}`(Rust 读 queue pending,逐条 create POST/update PATCH/delete DELETE,每条带 base_etag 做冲突判定,成功更新 calendar_events+置 done,冲突置 conflict)。前端:可写事件卡支持拖拽改时段(event 卡 id 加 `event-` 前缀,`handleDragEnd` 行 134 按前缀分流 todo/event/unscheduled 三路),drop 后乐观更新+标 localDraft→`enqueueEventEdit(ev,"update")`→`feishu_flush_queue`→成功重 hydrate/冲突走 P4-4。首版只做拖拽改时段 + 删除两个 op。
关键决策(UI 片风险 1):**A5/B3 必须一起改 handleDragEnd**,只加渲染不改拖拽分流会让拖 event 误改 todo。(UI 片风险 5)`enqueueChange` 用 await 确保 plugin-sql execute 已 commit 再 invoke flush,避免 WAL 跨连接可见性窗口漏读。
依赖:P4-2、P2-5。

**P4-4 — etag 三态冲突 + 保留本地草稿** `[改 CalendarPage.tsx + calendarEventsStore.ts]`
契约:Rust 判冲突时把 queue 项置 `state='conflict'`,calendar_events 里**保留两份**——远端版覆盖主记录(local_draft=0)+ 本地草稿版(local_draft=1,单独一行)。前端:草稿卡橙色"冲突"badge,点击给"保留我的/用远端"二选一(保留我的→重新入队 update;用远端→删草稿行)。`ConflictBadge`、`resolveConflict(draft, choice)`。
关键决策(UI 片风险 4):**去重键必须预留 local_draft 维度**(键改为 `${master}|${instanceStart}|${localDraft?'d':'r'}`),否则 P2-5 的去重会把草稿吃掉,冲突静默丢失。三态比较核心在 Rust(持有远端 etag 与 base_etag)。
依赖:P4-3。**适合 TDD**:dedupe 函数对 localDraft 的处理(冲突时远端版+草稿版都保留不互相吃掉)。

**P4-5 — 离线入队 / 联网重放** `[改 src/lib/calendarSync.ts]`
契约:离线时 `enqueueEventEdit` 写库不依赖网络,flush 失败 Rust 置 failed+last_error 不丢;前端 `window.addEventListener("online")` 触发 `feishu_flush_queue`(作为冗余触发,engine 的网络恢复也会驱动)。
依赖:P4-2、P4-3。

**P4-6 — 重复事件仅改单次** `[改 CalendarPage.tsx 编辑入口 + calendarQueue.ts payload]`
契约:`recurrenceMasterId` 非空的实例,`enqueueEventEdit` payload 额外带 `{recurrenceMasterId, instanceStartIso, scope:"single"}`,让 Rust 决定如何调飞书"改单实例"API;UI 提示"仅修改此次日程",不提供"修改整个系列"。
依赖:P4-2、P2-5。**适合 TDD**:重复实例入队 payload 带 `scope:"single"`+母事件信息。

### Phase 4 验收标准
- 可单测部分:enqueueEventEdit payload、dedupe 对 localDraft、改单次 payload。
- 无凭证可测:乐观更新+入队+队列状态流转(mock flush 返回 done);只读卡拖不动不入队;断网编辑入队不丢。
- **端到端(需真实凭证+可写日历+人工)**:拖动可写事件→飞书端时间改;删除→飞书端消失;本地+远端同时改同一事件→出现草稿卡+冲突 badge→选"用远端"草稿消失/选"保留我的"重新推送;改重复会某一天→只那天变;断网编辑→恢复网络→自动 flush 清空队列。

### 颗粒度
中到大(6 个任务,冲突处理 + 拖拽分流是难点,其余是队列 CRUD 的常规活)。

---

## 任务依赖图(跨相位总览)

```
Phase 0 (认证) ──────────────────────────────────────────┐
 P0-1 deps ─┬─ P0-2 config ─┬─ P0-3 keychain ─┐           │ (keychain/oauth 被 Phase 2 engine 复用)
            │               └─ P0-4 oauth ─────┤           │
            └─ P0-5 callback ──────────────────┴─ P0-6 cmd ─ P0-7 注册
                                                            P0-8 settings(并行)─ P0-9 UI骨架
Phase 1 (数据层) ←── 认证完成后
 P1-1 schema ─┬─ P1-2 类型/归一骨架 ─ P1-3 CRUD ─┐
              │  P1-4 SyncTopic(并行) ─ P1-5 dbTx ─┼─ P1-6 store ─ P1-8 App接线
              └─ P1-7 Rust仓储(被 Phase 2 依赖)
Phase 2 (只读核心) ←── 数据层表结构 + 认证 token 就绪后
 P2-1 client ─┬─ P2-3 sync核心 ─ P2-4 engine+cmd ─ P2-6 settings状态
 P2-2 normalize┘                  P2-5 CalendarPage只读渲染(依赖 P1-6)
Phase 3 (准实时POC) ←── engine 能跑 sync_once 后
 P3-1 调研 ─ P3-2 POC ─ P3-3 接入(退回轮询保底)
Phase 4 (双向) ←── 只读渲染 + is_writable 探测就绪后
 P4-1 探测消费 ─ P4-2 队列 ─ P4-3 写回+cmd ─ P4-4 冲突 ─ P4-5 离线重放
                                              └─ P4-6 改单次
```

---

## 需要用户提供 / 人工的步骤清单

这些步骤卡在真实凭证、企业 scope 审批、或人在浏览器点同意,**Claude 无法自动完成**:

| # | 相位 | 卡点 | 需要用户给什么 |
|---|---|---|---|
| 1 | Phase 0 (P0-9 端到端) | 在飞书/Lark 开发者后台**创建自建应用**,拿 `app_id` + `app_secret` | 真实的 app_id、app_secret(飞书和 Lark 各一套,若两边都要) |
| 2 | Phase 0 (P0-5/P0-9) | 在开发者后台**注册 redirect_uri**,必须逐字 = `http://127.0.0.1:42801/feishu/callback` | 用户在后台填这串(Claude 给出确切值,用户复制粘贴) |
| 3 | Phase 0 (P0-4/P0-9) | 在开发者后台**申请并开通 scope**:`calendar:calendar:readonly` + `offline_access`(只读起步) | 用户在后台勾选 scope;**企业版可能需管理员审批**,审批时长不可控 |
| 4 | Phase 0 (P0-6 start_auth) | OAuth 授权:**人在浏览器点"同意授权"** | 用户本人操作浏览器(Claude 自动拉起浏览器,但点同意必须人来) |
| 5 | Phase 2 (P2-3 端到端) | 验证真实拉取(分页字段名、429 头名、sync_token 失效码、全天/定时字段结构) | 上述凭证就绪后,用户授权一次即可;Claude 联调时一次性扫这些真实字段 |
| 6 | Phase 3 (P3-1/P3-2) | **事件订阅 / 长连接能力**可能需额外 scope | 用户在后台开通日历事件订阅 scope;**企业版几乎必然要管理员审批** |
| 7 | Phase 4 (P4-1/P4-3) | **写权限 scope**:`calendar:calendar`(读写,去掉 readonly) | 用户在后台升级 scope 为可写;**需重新走一次授权(scope 变了)** + 可能重新审批 |
| 8 | Phase 4 (P4-3 端到端) | 验证写回:需要一个**用户有 writer/owner 权限的真实日历** | 用户确认哪个日历可写,用于测试写回 |
| 9 | Phase 4 (P4-4 端到端) | 制造真实冲突:本地改 + 飞书端同时改同一事件 | 用户在飞书 App 里手动改一个日程,配合本地改 |

> 关键提醒:**第 7 项(写权限)会让 Phase 4 必须重新授权一次**——只读和读写是不同 scope,从只读升级到读写,旧 token 不含写权限,要重新走 OAuth。建议在 Phase 0 就和用户确认"最终是否要写回",若是,Phase 0 的 SCOPES 可直接申请读写(但只读起步更稳,审批更容易过)。这是个产品取舍点,需要用户拍板。

---

## 第一刀从哪下(Claude 能立即动手、不依赖真实凭证、可写+可单测)

按"立即可独立落地"排序,推荐这个顺序起步——全部在 Phase 0/1,纯逻辑或纯本地,无需任何飞书凭证:

1. **P0-1 加 Cargo 依赖** — 一次性,`cargo build` 通过即验收。是后面 Rust 任务的地基,先把编译跑通(尤其验 reqwest TLS 不挂)。无凭证。

2. **P0-4 OAuth core 的纯逻辑部分**(`gen_pkce`/`gen_state`/`build_authorize_url`)— **纯函数,强可单测**:challenge==手算 b64url(sha256(verifier))、authorize URL 含全部 6 个 query 参数且 host 随 region 切换。`exchange_code`/`refresh` 写出来但端到端留人工。无凭证。

3. **P0-2 Region config + P0-3 keychain 封装** — keychain 用假字符串就能跑通 set/get/delete 集成测试(macOS 本机),验证存取与双 region 隔离。无真实凭证(假串即可)。

4. **P0-5 callback 监听** — **本地可单测**:起 `wait_for_callback("S")` + 另起 reqwest 请求 `127.0.0.1:42801/feishu/callback?code=abc&state=S`,断言拿到 Callback;state 不匹配返回 Err。无凭证。

5. **P1-1 schema + P1-2 类型/归一骨架** — DDL 一次落地;`normalizeEventTiming` 是**强可单测纯函数**(见下)。无凭证。

6. **P1-5 dbTx + P2-1 backoff_delay + P2-2 normalize/map_event** — 全是纯逻辑,可单测。其中 P2-2 的时区归一是整个功能最该先写测试再写实现的地方。

> 一句话:**先 P0-1(让 Rust 编译跑通)→ 再并行铺 P0-4 纯逻辑 / P0-5 回调 / P1-2+P2-2 归一**。这几件全是"写完就能单测验收"的,不用等用户给凭证,能立刻产出可验证的代码。

---

## 适合 TDD 的任务(有纯逻辑可单测,先写测试再写实现)

| 任务 | 纯逻辑点 | 关键断言 |
|---|---|---|
| **P0-4** OAuth PKCE/URL | `gen_pkce`、`build_authorize_url` | challenge == b64url_nopad(sha256(固定 verifier));URL 含 6 个 query + S256 + host 随 region 切;scope 正确编码;redirect_uri percent-encode |
| **P0-5** 回调 state 校验 | `wait_for_callback` | code/state 正确解出;state 不匹配 Err;超时 Err 不挂死;端口冲突明确报错不 panic |
| **P1-2** 时区归一(TS) | `normalizeEventTiming` | 全天 `{isAllDay:true,startDate:"2026-05-29"}`→`{scheduledDate:"2026-05-29",scheduledTime:undefined}`;**定时事件归一产物能被 `parseScheduledTime`(calendar.ts:100)往返解析回相同 startMin/endMin** |
| **P1-5** 事务封装 | `dbTx` | mock db 记录序列:成功=BEGIN→fn→COMMIT;失败=BEGIN→ROLLBACK 且重抛 |
| **P2-1** 429 退避 | `backoff_delay` | attempt 序列产出递增且 ≤cap;给 retry_after header 返回约 N 秒;Region::host/from_str 双向 |
| **P2-2** 时区归一(Rust)+映射 | `normalize`、`map_event` | **全天零偏移**(UTC+8 与 UTC-5 两个测试时区下日期都不漂);定时事件 Asia/Shanghai vs America/New_York 同一 UTC 秒得不同本地 HH:MM;产物匹配 parseScheduledTime 正则;**dedup_key 三态**(非重复=remote_event_id,重复=master+":"+original_start);cancelled 事件正确标 cancelled |
| **P2-3** sync_token 事务推进 | `sync_one_calendar`(mock client + in-memory db) | 全量 N 条→N 行+token 写;增量 cancelled→软删不消失;**事务原子性**(中途 Err→token 未推进、事件不写);**乱序**(先 cancelled 新 updated_at 再 confirmed 旧→仍 cancelled);**去重**(同 dedup_key 两次→event_map 仍 1 行) |
| **P2-4** 并发串行 | `sync_once` + Mutex | 两个 sync_once 并发不交错;notify("calendar_events") 被调(计数回调断言) |
| **P2-5/P4-4** 渲染去重 | `dedupeEventsByDate` | 同 `(masterId,instanceStartIso)` 两条→输出一条;**冲突时远端版+草稿版(local_draft 维度)都保留不互相吃掉** |
| **P4-2/P4-6** 队列 payload | `enqueueEventEdit` | base_etag 取自 ev.etag;重复实例 payload 带 `scope:"single"`+母事件信息 |
| **P0-7/P0-9 状态机** | OAuth 连接态 reducer `(state,event)=>nextState` | 合法转移正确;非法转移忽略(如 disconnected 收到 SYNC_DONE 不变) |

> 最该严格 TDD 的两个:**P2-2 时区归一**(全天零偏移极易写反,且只在非 UTC 时区暴露——测试必须强制覆盖 ≥2 时区)和 **P2-3 sync_token 事务推进**(事务原子性 + 乱序 tombstone 是数据正确性的命门,mock client 就能完整覆盖,不用等真实凭证)。

---

## 合并后仍存的最高优先级风险(前 6,跨相位)

1. **[实现] 表列名/store 命名合并不彻底** — 触发:某个任务没按本文档 §0 的权威列名/`useCalendarEventsStore` 命名写,各写各的。影响:Rust 写的列前端读不到,或两个 store 并存数据对不上。缓解:§0 的 DDL 是唯一权威,P1-1 落地后所有读写比对它;命名统一 `useCalendarEventsStore`。

2. **[实现] 时区全天零偏移写反** — 触发:对全天事件也做 Utc→Local。影响:UTC+8 用户所有全天事件早一天,且开发者本地若是 UTC+8 测则隐藏。缓解:P2-2 单测强制 ≥2 时区,全天走独立函数不复用定时路径。

3. **[实现] keychain 与 SQLite 无法真同一事务,refresh_token 可能丢** — 触发:commit 后、写 keychain 前进程崩溃,旧 refresh_token 已被飞书作废。影响:用户被迫重新授权(不丢数据)。缓解:commit 后立即同步写 keychain 中间不插 IO + 多存上一个 refresh_token 做一次性回退。固有张力,只能缩小窗口。

4. **[实现] 拖拽上下文 todo/event 串味** — 触发:event 卡用 useDraggable 但 id 不加前缀。影响:拖飞书日程误改本地待办。缓解:P4-3 event 卡 id 强制 `event-` 前缀,handleDragEnd 开头按前缀三路分流,渲染与拖拽分流必须一起改。

5. **[项目] 端到端全程卡真实凭证 + 人工授权 + 企业审批** — 触发:P0/P2/P3/P4 的真实行为(字段名、分页、429 头、sync_token 失效码、推送能力、写权限)只能拿到 token 后验。影响:单测全过但联调才暴露字段类 bug,Phase 4 写权限还要重新授权+可能重新审批。缓解:把可单测部分最大化(本文档 TDD 节);字段名集中在 normalize/sync 少数常量;用飞书文档样例构造 fixture;**Phase 0 就和用户确认最终是否要写回**(决定 scope 申请策略)。

6. **[产品] Phase 3 准实时在桌面端可能根本不可行** — 触发:飞书事件订阅需公网回调,桌面端只能赌 WebSocket 长连接可用且企业开了订阅 scope。影响:Phase 3 可能投入后发现走不通。缓解:P3-1 先纯调研出结论,P3-2 一次性 POC 验证,**不通就停在 Phase 2 轮询**(已是完整可用版),不强行投产;长连接接入时必须保留退回轮询的降级。

---

## 关键文件锚点速查(绝对路径)

**新建(Rust,统一在 `/Users/apple/Documents/project_management/src-tauri/src/feishu/`)**:`mod.rs`、`config.rs`、`keychain.rs`、`oauth.rs`、`callback.rs`、`client.rs`、`normalize.rs`、`db.rs`、`sync.rs`、`engine.rs`、`commands.rs`;`/Users/apple/Documents/project_management/src-tauri/examples/feishu_smoke.rs`(可选 TLS 冒烟)、`feishu_longconn_smoke.rs`(Phase 3 POC)。

**新建(前端)**:`/Users/apple/Documents/project_management/src/lib/calendarEventsStore.ts`、`/Users/apple/Documents/project_management/src/lib/calendarSync.ts`、`/Users/apple/Documents/project_management/src/lib/calendarQueue.ts`。

**修改**:
- `/Users/apple/Documents/project_management/src-tauri/Cargo.toml`(P0-1,行 15 起 + tokio 行 27)
- `/Users/apple/Documents/project_management/src-tauri/src/lib.rs`(P0-7 行 6/51-55;P2-4 setup 行 32-49 spawn scheduler + invoke_handler)
- `/Users/apple/Documents/project_management/src/lib/db.ts`(P1-1 SCHEMA_V1 行 19-106/migrate 行 120-137;P1-2/P1-3/P1-5;P4-2)
- `/Users/apple/Documents/project_management/src/lib/syncBus.ts`(P1-4,行 17 加 `"calendar_events"`)
- `/Users/apple/Documents/project_management/src/App.tsx`(P1-8,MainApp 行 62-93 三段)
- `/Users/apple/Documents/project_management/src/lib/settings.ts`(P0-8,四处)
- `/Users/apple/Documents/project_management/src/pages/SettingsPage.tsx`(P0-9/P2-6,仿 McpAccessSection 行 326-380 + 挂载 131-137)
- `/Users/apple/Documents/project_management/src/pages/CalendarPage.tsx`(P2-5/P4-3/P4-4,todosByDate 行 81-90、handleDragEnd 行 134、WeekView/DayColumn 行 449-633、MonthView 行 419-438)
- `/Users/apple/Documents/project_management/src/lib/calendar.ts`(P2-5 抽 `dedupeEventsByDate`)

**只读参考范式**:`src-tauri/src/mcp/{server,db,connect}.rs`(sqlx/notify/gen_id/now_iso/connect/明文反例)、`src-tauri/src/cli_agent/mod.rs:136-155`(后台 spawn+emit+command)、`src/lib/{activityStore,goalsStore}.ts`(store 范式)、`src/lib/calendar.ts:100`(parseScheduledTime,归一目标格式)。

**核查(大概率不改)**:`/Users/apple/Documents/project_management/src-tauri/capabilities/default.json` — Rust 侧 reqwest 出站 HTTP、localhost 监听、`open` 拉浏览器、自定义 command 均**不需要 capability**;唯一可能要改的是若改用 `tauri-plugin-opener` 从前端调(本计划不走,故零改动)。