# 附录:四片原始规划(综合前)

> 统一计划见 2026-05-29-feishu-calendar-sync-plan.md。此处保留各片原文供追溯。



---

# 片1:认证脚手架

The cargo cache listing came back empty (likely sandboxed home), but the lock file is authoritative: `reqwest 0.13.3` is what the workspace already resolves to via rmcp. I have enough to write a precise plan. Note one caveat I'll flag: reqwest 0.13 is unusually new — I'll instruct the developer to match the locked version and not fight the resolver.

I now have full context on all anchor files. Writing the implementation plan.

# Phase 0:认证与脚手架 — 实施任务清单

> 范围 = 让"飞书/Lark OAuth 授权码+PKCE 登录、凭证与 token 存 OS keychain、Tauri 暴露 start_auth/disconnect/status"这三件事能跑通。**不含**任何日历 API 拉取、表结构、store(那些属于后续片)。
> 只读分析产物,未改动任何文件。所有路径为绝对路径。

---

## 关键事实(读真实代码后确认,直接用,影响下面每个任务)

1. **reqwest 已在 `Cargo.lock`(0.13.3),但没带任何 TLS 后端。**
   `src-tauri/Cargo.toml:25` 的 `rmcp` 间接拉进了 `reqwest 0.13.3`,但只启用了 server/wasm 那套 feature,**lock 里没有 `rustls`、`native-tls`、`hyper-tls` 任何一个**。直接 `reqwest::get("https://open.feishu.cn/...")` 会因无 TLS 而失败。→ Task 1 必须显式开 TLS feature。这是本片最容易踩的坑。

2. **`reqwest 0.13` 版本号偏新且不寻常**(常见稳定版是 0.12.x)。既然 lock 已锁 0.13.3,Task 1 直接写 `reqwest = "0.13"` 与现有解析对齐,**不要降版**,否则与 rmcp 的间接依赖打架。

3. **`url 2.5`、`base64 0.22`、`sha2 0.10`、`rand 0.8`/`0.9` 都已在 lock**。PKCE 用得到的 `sha2`+`base64`+`rand` 全是现成传递依赖,显式声明即可,不会引入新编译负担。`rand 0.8` 已被 `Cargo.toml:35` 直接依赖。

4. **token 持久化的"反例"是 `src-tauri/src/mcp/connect.rs:11` 的 `load_or_create_token`**——明文写 `mcp_token.txt`。本片要做的 keychain 封装就是这个范式的"安全版替代",但**不要动 connect.rs**(那是 MCP 接入密钥,与飞书无关),只是照着它"读不到就生成/存,存在就返回"的形态,换成 keyring 后端,服务于飞书凭证。

5. **Tauri command 注册点 = `src-tauri/src/lib.rs:51-55` 的 `tauri::generate_handler!`**。现有已注册 `mcp::connect::mcp_connection_info`、`cli_agent::cli_agent_send`、`cli_agent::cli_agent_detect`。新 command 加在这个数组里。

6. **`#[tauri::command]` 必须用"定义模块完整路径"注册**(见 `mcp/mod.rs:9-11` 的注释:macro 生成的隐藏辅助项不随 `pub use` 重导出)。→ 新模块若是 `feishu::auth::feishu_start_auth`,在 `generate_handler!` 里就得写全 `feishu::auth::feishu_start_auth`,不能图省事 `pub use` 后写短名。

7. **后台异步任务 + Tauri 事件流的范式 = `cli_agent/mod.rs:136-155`**:`#[tauri::command] async fn` 里 `tauri::async_runtime::spawn` 起后台任务,用 `app.emit("事件名", payload)` 推前端。OAuth 回调监听(等用户在浏览器点同意)正好套这个壳。

8. **`AppHandle` 拿配置目录 = `connect.rs:38-43`**:`app.path().app_config_dir()`。keyring 不需要它(keyring 走系统钥匙串),但"非敏感配置"(region、连接状态、过期时间)需要落盘点位 → 见 Task 4 的决策。

9. **`capabilities/default.json` 目前没有任何"出站 HTTP / 起本地监听 / 命令执行"权限**。需要确认:Tauri 2 里**用 Rust 侧 reqwest 直接发 HTTP 不需要 capability**(capability 只管前端 JS 经 plugin 调的能力;Rust 原生代码不受 capability 沙箱限制)。→ Task 6 给结论:大概率**不用改 default.json**,但要逐条说清为什么,并列出唯一可能要动的场景。

---

## 任务依赖图

```
T1 (Cargo 依赖) ──┬─> T2 (keychain 封装)
                  ├─> T3 (配置模型 Rust 侧)
                  └─> T4 (OAuth core: PKCE/URL/换token/刷新)
T3 ──> T5 (localhost 回调监听)
T2,T4,T5 ──> T6 (Tauri commands: start_auth/disconnect/status)
T6 ──> T7 (lib.rs 注册)
(并行) T8 (settings.ts 前端配置模型) <- 仅契约依赖 T3
T6,T8 ──> T9 (SettingsPage 连接 UI) [可标为后续片,本片给最小契约]
T10 (capabilities 核查) 独立,随时可做
```

---

## Task 1 — 加 Cargo 依赖(reqwest + TLS + keyring + PKCE 工具)

**改哪个文件**
`src-tauri/Cargo.toml`,在 `[dependencies]`(第 15 行起)末尾追加。照搬现有写法(`chrono`/`uuid`/`rmcp` 都是 `名 = { version, features }` 形态)。

**要加的依赖(契约)**
```toml
# 飞书/Lark 出站 HTTPS。rmcp 已间接引入 reqwest 0.13 但未带 TLS 后端,
# 这里显式开 TLS,否则 https 请求直接失败。json 用于解析 token 响应。
reqwest = { version = "0.13", default-features = false, features = ["json", "rustls-tls"] }
# 凭证与 token 存系统钥匙串(macOS Keychain),替代明文落盘
keyring = { version = "3", features = ["apple-native"] }
# PKCE: code_verifier 随机 + code_challenge = base64url(sha256(verifier))
sha2 = "0.10"
base64 = "0.22"
url = "2.5"
# rand 已在(行 35),复用它生成 code_verifier / state
```

**关键决策点(要写进注释 / 交付说明)**
- **TLS 选 `rustls-tls` 而非 `native-tls`**:macOS 上 native-tls 走 Security.framework 没问题,但 rustls 不依赖系统 OpenSSL、跨平台一致、不引入 C 依赖。`default-features = false` 是为了**不重复拉一套 reqwest 默认 TLS**(默认是 native-tls),避免和未来跨平台冲突。
- **keyring `3.x` 的 feature 名是 `apple-native`**(2.x 时代叫 `platform-macos`;务必核对装上后 `cargo tree -i keyring` 的实际版本,3.x 把后端拆成了 `apple-native`/`sync-secret-service`/`windows-native`)。只在 macOS 跑 → 只开 `apple-native`。
- reqwest **沿用 lock 已锁的 0.13.3**,不要写 `0.12`。

**验收/测试点**
- `cd src-tauri && cargo build` 通过,无 "no TLS backend" / "feature not found" 报错。
- `cargo tree -i reqwest` 只出现一个 reqwest 版本(确认没分裂出两份)。
- `cargo tree -i keyring` 显示 `keyring v3.x` 且后端是 apple-native。
- **可单测**:写一个 `examples/feishu_smoke.rs`(仿 `examples/mcp_smoke.rs`),`reqwest::Client::new().get("https://open.feishu.cn").send().await` 能拿到 HTTP 响应(任意状态码都行,只验 TLS 握手通),证明出站 HTTPS 链路活着。

**依赖**:无(本片地基)。
**真实凭证/人工**:不需要。

---

## Task 2 — keychain 封装模块(凭证 + token 的安全存取)

**建哪个文件**
新建 `src-tauri/src/feishu/keychain.rs`(新建 `src-tauri/src/feishu/` 目录 + `mod.rs`,见 Task 7)。
**形态照搬**:`mcp/connect.rs:11-23` 的 `load_or_create_token`(读不到→处理,读到→返回)的"幂等存取"风格,但后端换成 keyring,且**不自动生成**(凭证由用户填,不能凭空造)。

**要新增的类型/函数(契约级)**
```rust
// keyring 的 service 名固定;account 名按 region + 字段类型区分,做到飞书/Lark 两套互不覆盖
const KEYRING_SERVICE: &str = "com.daybreak.desktop.feishu";

// 钥匙串里存的三类敏感物。region 进 account key,保证双平台隔离。
pub enum Secret {
    AppSecret,      // 用户填的应用密钥
    AccessToken,    // user_access_token
    RefreshToken,   // 刷新令牌(一次性,刷新后要立刻覆盖)
}

// account key = format!("{region}:{secret_kind}"),例 "feishu:app_secret"
fn entry(region: &Region, kind: Secret) -> Result<keyring::Entry, String>;

pub fn set_secret(region: &Region, kind: Secret, value: &str) -> Result<(), String>;
pub fn get_secret(region: &Region, kind: Secret) -> Result<Option<String>, String>; // 不存在返回 Ok(None)
pub fn delete_secret(region: &Region, kind: Secret) -> Result<(), String>;          // 不存在视作成功(幂等)
// 断开连接时一次性清掉某 region 的全部三项
pub fn clear_region(region: &Region) -> Result<(), String>;
```
> `Region` 类型来自 Task 3。

**关键决策**
- **service 固定 + account 用 `region:kind` 复合键**:飞书和 Lark 是两套独立凭证(已锁定决策 3),必须能各存一份,不能互相覆盖。
- **get 用 `Option` 而非 Result-as-missing**:keyring 的 `NoEntry` 错误要在这里转成 `Ok(None)`,上层 status 查询靠"有没有 token"判连接状态,不能让"没存过"变成报错。
- **app_secret 也进钥匙串**(已锁定决策 2:凭证与 token 一律 keychain),不进 localStorage、不进配置文件明文。

**验收/测试点**
- **可单测**(集成测试,macOS 上跑):`set_secret(feishu, AccessToken, "x")` → `get_secret` 返回 `Some("x")` → `delete_secret` → `get_secret` 返回 `None`。
- 钥匙串隔离:`set_secret(feishu, AppSecret, "a")` 与 `set_secret(lark, AppSecret, "b")` 互不影响。
- 手工:跑完测试后用"钥匙串访问.app"搜 `com.daybreak.desktop.feishu`,确认 token 是密文条目,不是明文文件。
- 反向确认:**不要**在任何 `.txt`/`localStorage`/SQLite 里看到 app_secret 或 token 明文。

**依赖**:Task 1(keyring)、Task 3(`Region` 类型)。
**真实凭证/人工**:不需要真实飞书凭证(可用假字符串测存取)。macOS 首次访问钥匙串可能弹系统授权框 → 属正常,需人点一次"始终允许"。

---

## Task 3 — 配置模型(Rust 侧):Region + 连接状态

**建哪个文件**
新建 `src-tauri/src/feishu/config.rs`。这是**非敏感配置**的家(敏感的全在 keychain)。

**要新增的类型/函数(契约级)**
```rust
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Region { Feishu, Lark }   // 仿 cli_agent/mod.rs:55 CliKind 的 serde lowercase 范式

impl Region {
    pub fn host(&self) -> &'static str {           // open.feishu.cn / open.larksuite.com
        match self { Region::Feishu => "open.feishu.cn", Region::Lark => "open.larksuite.com" }
    }
    pub fn api_base(&self) -> String { format!("https://{}/open-apis", self.host()) }
}

// 每个 region 一份非敏感配置(app_id 是公开标识,可明文落盘;app_secret 进 keychain 不在这)
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct RegionConfig {
    pub app_id: Option<String>,
    pub connected: bool,            // 是否已成功换到 token
    pub token_expires_at: Option<i64>, // access_token 过期时间戳(秒);刷新判断用
    pub last_error: Option<String>,
}

// 整个飞书功能的配置(两 region 各一份)。落盘到 app_config_dir/feishu_config.json
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct FeishuConfig {
    pub active_region: Option<Region>, // 用户当前选的区域
    pub feishu: RegionConfig,
    pub lark: RegionConfig,
}

// 读写非敏感配置(参照 connect.rs:38-43 用 app_config_dir 定位 + serde_json 读写)
pub fn load(config_dir: &Path) -> FeishuConfig;          // 读不到/解析失败 → Default
pub fn save(config_dir: &Path, cfg: &FeishuConfig) -> Result<(), String>;
```

**关键决策**
- **敏感/非敏感分家**:`app_id`(公开)、`connected`、`expires_at`、`last_error` 走明文 JSON 文件;`app_secret`、`access/refresh_token` 走 keychain(Task 2)。理由:keychain 不适合塞一堆非敏感状态(读写慢、还可能反复弹授权框),且过期时间这类要被 UI 频繁读。
- **`host()`/`api_base()` 收敛在 Region 上**:已锁定决策 3 说"切换域名,其余路径相同"。后续片(日历)直接调 `region.api_base()` 拼 URL,域名只在这一处定义,杜绝硬编码散落。
- 文件名 `feishu_config.json`,放 `app_config_dir`(与 `daybreak.db`、`mcp_token.txt` 同目录,见 `lib.rs:38-42`)。

**验收/测试点**
- **可单测**:`save` 后 `load` 往返一致;空文件 `load` 返回 `Default` 不 panic;`Region::Feishu.api_base() == "https://open.feishu.cn/open-apis"`。
- 序列化 round-trip:`serde_json::to_string` → `from_str` 字段不丢。

**依赖**:Task 1(serde 已在,无新依赖)。
**真实凭证/人工**:不需要。

---

## Task 4 — OAuth core:PKCE + 授权 URL + 换 token + 刷新

**建哪个文件**
新建 `src-tauri/src/feishu/oauth.rs`。纯逻辑 + HTTP,不碰 Tauri(便于单测)。

**要新增的类型/函数(契约级)**
```rust
// PKCE 一对。authorize 时带 challenge,换 token 时带 verifier
pub struct Pkce { pub verifier: String, pub challenge: String } // challenge = b64url_nopad(sha256(verifier))
pub fn gen_pkce() -> Pkce;          // verifier: 43-128 字符随机;method 固定 S256
pub fn gen_state() -> String;       // CSRF 防护随机串,回调时比对

// 拼授权页 URL(浏览器打开这个)。端点: https://{host}/open-apis/authen/v1/authorize
// 必带: client_id(=app_id), redirect_uri(固定 localhost), response_type=code,
//        scope(空格分隔), state, code_challenge, code_challenge_method=S256
pub fn build_authorize_url(
    region: &Region, app_id: &str, redirect_uri: &str,
    scopes: &[&str], state: &str, challenge: &str,
) -> String;

// 换 token: POST https://{host}/open-apis/authen/v2/oauth/token
// body(json): grant_type=authorization_code, client_id, client_secret, code,
//             redirect_uri, code_verifier
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: i64,            // 秒
    pub refresh_token_expires_in: Option<i64>,
}
pub async fn exchange_code(
    client: &reqwest::Client, region: &Region,
    app_id: &str, app_secret: &str, code: &str,
    redirect_uri: &str, code_verifier: &str,
) -> Result<TokenSet, String>;

// 刷新: 同端点, grant_type=refresh_token, client_id, client_secret, refresh_token
// 注意:飞书 refresh_token 一次性,响应里会带"新的" refresh_token,必须落库覆盖旧的
pub async fn refresh(
    client: &reqwest::Client, region: &Region,
    app_id: &str, app_secret: &str, refresh_token: &str,
) -> Result<TokenSet, String>;

// 本片固定的 scope 集合(只读起步,写权限留给后续片)
pub const SCOPES: &[&str] = &["calendar:calendar:readonly", "offline_access"];
```

**关键决策(写注释)**
- **`offline_access` 必带**(已锁定决策 2),否则拿不到 refresh_token。
- **强制带 `client_secret`**(已锁定决策 2:无免密钥公开客户端),`exchange_code`/`refresh` 签名里 `app_secret` 是必填参数,不给可选。
- **refresh 的响应也含新 refresh_token**:`TokenSet.refresh_token` 在 refresh 路径里同样要被取出并覆盖钥匙串里的旧值(实际覆盖动作在 Task 6,因为要和"写连接状态"同一步;本函数只负责把新值解析出来返回)。
- **`expires_in` 转成绝对时间戳**的动作放在调用方(Task 6),本函数只回相对秒数,保持纯。
- 授权端点用 v1(`authen/v1/authorize`),换/刷新用 v2(`authen/v2/oauth/token`)——这是飞书的现状,两个版本号不一致是对的,别"统一"。

**验收/测试点**
- **可单测(不需联网)**:
  - `gen_pkce()` 的 challenge == 手算 `base64url_nopad(sha256(verifier))`(用固定 verifier 断言)。
  - `build_authorize_url` 输出包含全部 6 个 query 参数、`code_challenge_method=S256`、host 随 region 切换(feishu vs larksuite)、scope 用 `%20`/`+` 正确编码、`redirect_uri` 正确 percent-encode。
  - `gen_state()` 每次不同、长度足够。
- **需联网+真实凭证(标人工)**:`exchange_code`/`refresh` 的端到端只能用真实 app + 真实 code 验,无法自动化(见硬约束)。本任务交付时这两函数标"已实现,端到端验证依赖 Task 6 的人工流程"。

**依赖**:Task 1(reqwest/sha2/base64/rand)、Task 3(Region)。
**真实凭证/人工**:`build_authorize_url`/PKCE 不需要;`exchange_code`/`refresh` 的真实验证**需要真实飞书应用凭证 + 人工在浏览器点同意**(明确标注)。

---

## Task 5 — 固定端口 localhost 回调监听(捕获授权 code)

**建哪个文件**
新建 `src-tauri/src/feishu/callback.rs`。

**背景约束**(已锁定决策 2):redirect_uri 必须预注册精确匹配、不支持自定义 scheme → 用**固定端口的 localhost HTTP** 接飞书重定向回来的 `?code=...&state=...`。

**要新增的常量/函数(契约级)**
```rust
// 固定端口 + 固定路径,必须和"飞书开发者后台预注册的 redirect_uri"逐字一致
pub const CALLBACK_PORT: u16 = 42801;   // 避开 MCP 的 42800(mcp/mod.rs:18)
pub fn redirect_uri() -> String { format!("http://127.0.0.1:{CALLBACK_PORT}/feishu/callback") }

// 起一次性 HTTP 监听,等浏览器重定向回来,拿到 code 后立刻关掉监听。
// 用 axum(已在依赖, Cargo.toml:26)或 tokio TcpListener 手撸极简响应均可。
// 带超时(如 5 分钟没等到回调就放弃),返回给浏览器一个"可以关闭此页"的 HTML。
pub struct Callback { pub code: String, pub state: String }
pub async fn wait_for_callback(expected_state: &str) -> Result<Callback, String>;
//  ^ 内部校验回调带回的 state == expected_state,不一致直接报错(防 CSRF/串号)
```

**关键决策(写注释)**
- **端口 42801 硬编码**(MCP 占了 42800):redirect_uri 要在飞书后台预注册,不能动态端口,所以必须固定。**这个常量值要写进给用户的配置说明**(用户在飞书后台填 redirect_uri 时要逐字抄)。
- **一次性监听 + 超时**:不长驻端口,拿到 code 即关;5 分钟超时兜底(用户没点同意/关了浏览器)。
- **state 校验在这里做**:`wait_for_callback` 收 `expected_state`,回调 state 对不上立即 Err。
- **回调页要回个友好 HTML**("授权成功,可关闭"),否则浏览器停在 raw 文本上,体验差。
- 用 axum 还是裸 TcpListener:**裸 TcpListener 更省**(只处理一个 GET、读 query、回固定 HTML),但 axum 已在依赖且团队熟。任选,建议裸 listener 减少耦合——这是档位 2/3 的实现细节,留给开发者。

**验收/测试点**
- **可单测(本地,不需飞书)**:起 `wait_for_callback("S")`,另起一个 reqwest 请求 `http://127.0.0.1:42801/feishu/callback?code=abc&state=S`,断言返回 `Callback{code:"abc", state:"S"}`。
- state 不匹配:请求带 `state=WRONG` → `wait_for_callback("S")` 返回 Err。
- 超时:不发请求,5 分钟(测试时可注入短超时)后返回 Err 而非永久挂起。
- 端口冲突:42801 被占时返回明确错误,不 panic。

**依赖**:Task 1(reqwest 测试用)、Task 3(无直接,但同模块)。
**真实凭证/人工**:单测不需要;真实跑(浏览器真重定向回来)依赖 Task 6 整合 + 人工点同意。

---

## Task 6 — Tauri commands:feishu_start_auth / feishu_disconnect / feishu_status / feishu_set_credentials

**建哪个文件**
新建 `src-tauri/src/feishu/commands.rs`。把 Task 2/3/4/5 串起来。**异步任务 + 事件流范式照搬 `cli_agent/mod.rs:136-155`**;`AppHandle` 取配置目录照搬 `connect.rs:38-43`。

**要新增的 Tauri command(契约级)**
```rust
// 用户先填凭证(app_id 落 config 明文, app_secret 落 keychain)
#[tauri::command]
pub fn feishu_set_credentials(app: AppHandle, region: Region, app_id: String, app_secret: String) -> Result<(), String>;

// 启动 OAuth:gen pkce+state → 起回调监听 → 用 opener 打开授权 URL →
//   (后台 spawn)等回调 → exchange_code → access/refresh 存 keychain + connected=true/expires_at 存 config →
//   全程通过 Tauri 事件 "feishu-auth-event" 推进度给前端(范式见 cli_agent emit)
#[tauri::command]
pub async fn feishu_start_auth(app: AppHandle, region: Region) -> Result<(), String>;

// 断开:清该 region keychain 三项(clear_region) + config.connected=false、清 expires_at/error
#[tauri::command]
pub fn feishu_disconnect(app: AppHandle, region: Region) -> Result<(), String>;

// 给设置页读状态:每 region 的 app_id 是否已填、是否 connected、token 是否快过期
#[derive(Serialize)]
pub struct FeishuStatus {
    pub active_region: Option<Region>,
    pub feishu: RegionStatus,
    pub lark: RegionStatus,
}
#[derive(Serialize)]
pub struct RegionStatus {
    pub has_app_id: bool,
    pub has_secret: bool,     // 查 keychain 是否有 app_secret
    pub connected: bool,
    pub token_expires_at: Option<i64>,
    pub last_error: Option<String>,
}
#[tauri::command]
pub fn feishu_status(app: AppHandle) -> Result<FeishuStatus, String>;

// 事件 payload(emit "feishu-auth-event"):
//   { phase: "waiting_browser" | "exchanging" | "success" | "error", region, message? }
```

**关键决策(写注释)**
- **打开浏览器**:用 `tauri-plugin-opener` 或 `open` crate。⚠️ 若用 opener 插件需在 `Cargo.toml` + `lib.rs` 注册插件 + 可能要 capability —— **这是唯一可能要碰 `default.json` 的点**(见 Task 10)。建议:Rust 侧用轻量 `open = "5"` crate 直接拉起默认浏览器,绕开 Tauri 插件与 capability,最省。在 Task 1 里就把 `open = "5"` 一起加(我没列进 Task 1 是因为它属于 command 层选型;若采纳此方案,补进 Task 1 依赖)。
- **refresh_token 落盘的"同一事务"**:已锁定决策 2 强调"新 refresh_token 在写库成功同一事务里持久化"。本片 token 存 keychain(非 SQLite),没有 DB 事务概念 → **本片的等价实现 = 先写 keychain 的 access+refresh,全部成功后再写 config 的 connected/expires_at;任一步失败则回滚已写项并报错**,保证不出现"token 更新了但状态没更"或反之。把这个"两段提交"语义写清楚。真正的 DB 事务约束属于后续日历同步片(refresh 与 sync_token 推进同事务)。
- **start_auth 是 async + 后台 spawn**:命令本身可立即返回(已起监听 + 已开浏览器),回调结果通过事件推;或 await 到拿 token 再返回。建议后台 spawn + 事件推(用户点同意可能要几十秒,不能阻塞 command 调用方)。
- **错误落 config.last_error**:失败时把原因写进 `RegionConfig.last_error`,设置页能显示"上次连接失败:xxx"。

**验收/测试点**
- `feishu_set_credentials` 后 `feishu_status` 的 `has_app_id`/`has_secret` 变 true。
- `feishu_disconnect` 后 `connected` 变 false、keychain 三项被清(`get_secret` 全 None)。
- **可单测的部分**:set_credentials → status → disconnect 的状态机(不碰真实 OAuth)。
- **需真实凭证+人工(标注)**:`feishu_start_auth` 端到端——需真实 app、真实 redirect_uri 已注册、人在浏览器点同意。验收方式:点连接 → 浏览器弹授权页 → 同意 → 回调页显示成功 → `feishu_status.connected==true` 且 keychain 有 token。**此步无法自动化,必须人工。**

**依赖**:Task 2、3、4、5。
**真实凭证/人工**:`start_auth` 端到端**必须真实凭证 + 人工浏览器操作**;其余 command 可纯本地测。

---

## Task 7 — 注册 feishu 模块 + 在 lib.rs 注册 commands

**改哪些文件**
1. 新建 `src-tauri/src/feishu/mod.rs`:
```rust
//! 飞书/Lark 日历集成 —— Phase 0:认证与脚手架。
pub mod keychain;
pub mod config;
pub mod oauth;
pub mod callback;
pub mod commands;
pub use config::Region;   // 类型可 pub use;但 command 注册仍走全路径(见下)
```
2. `src-tauri/src/lib.rs:6` 附近(`pub mod cli_agent;` 下一行)加 `pub mod feishu;`。
3. `src-tauri/src/lib.rs:51-55` 的 `generate_handler!` 数组追加(**用定义模块全路径**,遵守 `mcp/mod.rs:9-11` 的注释规则):
```rust
        .invoke_handler(tauri::generate_handler![
            mcp::connect::mcp_connection_info,
            cli_agent::cli_agent_send,
            cli_agent::cli_agent_detect,
            feishu::commands::feishu_set_credentials,
            feishu::commands::feishu_start_auth,
            feishu::commands::feishu_disconnect,
            feishu::commands::feishu_status,
        ])
```

**关键决策**
- **不在 `lib.rs` 的 `setup()`(行 32-50)里 spawn 任何飞书后台任务**——本片是被动触发(用户点连接才动),不像 MCP server 要常驻。日历的"启动即同步"是后续片的事。
- command 必须写 `feishu::commands::xxx` 全路径,**不能** `pub use` 成短名后注册(macro 隐藏项问题)。

**验收/测试点**
- `cargo build` 通过。
- 前端 `invoke("feishu_status")` 能拿到结构(即使未连接也返回全 false 的结构,不报 "command not found")。

**依赖**:Task 6(commands 已定义)。
**真实凭证/人工**:不需要。

---

## Task 8 — 前端配置模型(settings.ts)

**改哪个文件**
`src/lib/settings.ts`。**注意定位**:`settings.ts:13` 已有 "P3 上 Tauri keychain 后 API key 搬过去" 的 TODO —— 飞书的 app_secret/token **不进这个 localStorage store**(它们在 Rust keychain),前端只持有"非敏感的 UI 偏好"(当前选哪个 region),真实状态从 `feishu_status` command 拉。

**要新增的类型(契约级)**
```ts
export type FeishuRegion = "feishu" | "lark";

// 注意:这里只存 UI 偏好(用户上次选的 region);
// app_id/secret/token/连接状态都在 Rust 侧,前端用 invoke("feishu_status") 拉,不进 localStorage。
export interface FeishuPrefs {
  activeRegion: FeishuRegion | null;
}
```
在 `SettingsState`(行 49-60)加 `feishu: FeishuPrefs;`;`defaults()`(行 65)加 `feishu: { activeRegion: null }`;`readStored()`(行 106)加合并分支 `feishu: { ...def.feishu, ...(parsed.feishu ?? {}) }`;`SettingsStore` 接口(行 150)加 `setFeishuRegion: (r: FeishuRegion | null) => void;`,实现照搬 `setChatBackend`(行 184-187)的 `set + persist` 范式。

**关键决策**
- **前端 store 故意"轻"**:只记 region 偏好,杜绝把 secret/token 落 localStorage(否则又回到明文老路,违背已锁定决策 2)。settings.ts:13 那条 TODO 的精神这次要落实到位——敏感物全在 keychain。
- 连接状态(connected/expires)**不缓存进 store**,每次 UI 打开现拉 `feishu_status`,避免与 Rust 侧真相不一致。

**验收/测试点**
- TS 编译过;`useSettingsStore().feishu.activeRegion` 可读写并持久化到 localStorage。
- localStorage 里**只**有 `activeRegion`,**没有** app_secret/token 字段(人工查 `daybreak.settings` 键的 JSON)。

**依赖**:仅契约依赖 Task 3 的 `Region` 命名(保持 `feishu`/`lark` 一致),可与 Rust 并行开发。
**真实凭证/人工**:不需要。

---

## Task 9 — SettingsPage 连接 UI(本片给最小骨架,完整交互可标后续片)

**改哪个文件**
`src/pages/SettingsPage.tsx`。**位置**:仿 `McpAccessSection`(行 326-380)和它在主体里的 `<Section>` 挂载(行 131-137),新增一个"飞书/Lark 日历"Section + `FeishuConnectSection` 组件。`invoke` 已在文件顶部 import(行 23);状态拉取范式照搬 `McpAccessSection` 的 `useEffect`+`invoke`(行 331-340);后端检测范式可参考 `ChatBackendField`(行 736-811)。

**要新增的(契约级)**
```tsx
// 状态结构与 Rust FeishuStatus 对齐
interface FeishuStatus { activeRegion: "feishu"|"lark"|null; feishu: RegionStatus; lark: RegionStatus; }
interface RegionStatus { hasAppId: boolean; hasSecret: boolean; connected: boolean; tokenExpiresAt: number|null; lastError: string|null; }

function FeishuConnectSection() {
  // 1. region 切换(SegmentControl,复用行 223 现成组件): feishu / lark
  // 2. app_id + app_secret 输入(secret 用 password,照搬 ProviderKeyEditor 行 549-575 的 show/hide)
  //    → onBlur 调 invoke("feishu_set_credentials", { region, appId, appSecret })
  // 3. "连接"按钮 → invoke("feishu_start_auth", { region }) → listen("feishu-auth-event") 显示进度
  // 4. 显示连接状态(connected / 过期时间 / lastError),数据来自 invoke("feishu_status")
  // 5. "断开"按钮 → invoke("feishu_disconnect", { region })
  // 6. 提示文案:必须先在飞书开发者后台注册 redirect_uri = http://127.0.0.1:42801/feishu/callback(逐字)
}
```
监听事件用 `@tauri-apps/api/event` 的 `listen("feishu-auth-event", ...)`(App.tsx:67-93 有 onSync/listen 范式可参考)。

**关键决策**
- **redirect_uri 提示必须显眼**:用户在飞书后台填的 redirect_uri 要和 `callback.rs` 的 `42801/feishu/callback` 逐字一致,UI 上直接把这串列出来让用户复制(仿 McpAccessSection 的"复制命令"交互,行 363-374)。
- secret 输入框**只用于写入**(写完即调 set_credentials),**不回显**真实值(keychain 不给读回明文给 UI;显示 `hasSecret` 布尔即可)。
- 本片 UI 可只做到"能连/能断/能看状态",**精细的 loading/错误态/i18n 文案**可标"体验打磨属后续片"。

**验收/测试点**
- 切 region、填凭证、点连接、点断开四个动作都能正确 invoke 对应 command。
- `feishu-auth-event` 事件能驱动 UI 显示"等待浏览器授权 → 成功/失败"。
- **端到端验收需真实凭证+人工**(同 Task 6)。

**依赖**:Task 6(commands)、Task 8(前端 region 偏好)。
**真实凭证/人工**:UI 骨架不需要;走通连接流程**需真实凭证 + 人工**。

---

## Task 10 — capabilities/default.json 权限核查(大概率不改,但要出结论)

**核查文件**
`src-tauri/capabilities/default.json`(当前权限见行 6-22:core 窗口类 + notification + sql,**无 HTTP/shell/opener**)。

**要确认/产出的结论**
1. **Rust 侧 reqwest 出站 HTTP 不需要任何 capability** —— capability 沙箱只约束**前端 JS 经 Tauri plugin/core 调的能力**;`feishu/oauth.rs` 里的 reqwest 是 Rust 原生代码,不经 IPC,不受 capability 限制。→ **结论:出站 HTTP 不用改 default.json。** 这条要明确写出来,避免开发者误加 `http:default`(本项目根本没装 `tauri-plugin-http`)。
2. **localhost 回调监听(Task 5)同理** —— Rust 起 TcpListener/axum,不经前端 IPC,不需要 capability。
3. **唯一可能要改的点 = 打开浏览器的方式**:
   - 若 Task 6 选 **`open` crate(Rust 侧)** 拉起浏览器 → 不需要 capability、不需要插件。**推荐,default.json 零改动。**
   - 若改用 **`tauri-plugin-opener`** 且从**前端**调 `openUrl` → 需要装插件 + 在 default.json 加 `opener:allow-open-url`(或类似)+ 在 `lib.rs` 注册插件。**本片不建议走这条。**
4. 新增的 Tauri command(feishu_*)**不需要在 capability 里声明** —— 自定义 `#[tauri::command]` 默认即可被前端 invoke,capability 管的是内置 core/plugin 命令,不管自定义 command。

**验收/测试点**
- 若按推荐(Rust `open` crate):`default.json` **不改**,`feishu_start_auth` 仍能拉起浏览器、reqwest 仍能出站 —— 证明结论成立。
- 若发现实际跑起来 reqwest/监听被拦(理论上不会),才回头加权限,并记录具体被拦的是什么。

**依赖**:与 Task 6 选型耦合(打开浏览器方式);其余独立。
**真实凭证/人工**:不需要。

---

## 跨片边界(本片不做,只标依赖)

- **日历表结构**(calendar_events / event_map / sync_state)、**Zustand 新 store**、**新 SyncTopic "calendar_events"** → 依赖"数据层片",本片不碰 `src/lib/db.ts`、`src/lib/store.ts`、`syncBus.ts`。
- **拉日历/日程、增量 sync_token、429 退避、RRULE 展开** → 依赖"同步引擎片"。本片只保证它们能拿到 `region.api_base()`(Task 3)和"从 keychain 取 access_token + 必要时 refresh"(Task 4 的 `refresh` + Task 2 的 get/set)。
- **写回/冲突/变更队列** → 依赖"双向同步片"。
- **refresh 与 sync_token 推进的"同一 DB 事务"约束** → 本片 token 在 keychain,用"两段提交"近似(Task 6 决策);真正 DB 事务在同步片落地。

---

## 风险点(前 5)

1. **[实现] reqwest 无 TLS 后端** — 触发:不加 `rustls-tls` feature 直接编。影响:HTTPS 全挂,且报错信息隐晦(运行期才暴露)。缓解:Task 1 显式开 feature + Task 1 的 smoke 测试先验 TLS 握手,编译期/冒烟期就拦住。

2. **[实现] keyring 3.x feature 名错** — 触发:沿用 2.x 的 `platform-macos`。影响:编译失败或 keychain 后端为空(存取静默无效)。缓解:Task 1 锁 `apple-native`,装后 `cargo tree -i keyring` 核版本 + Task 2 集成测试验真实存取。

3. **[产品/项目] OAuth 端到端无法自测** — 触发:任何 start_auth/exchange/refresh 的真实验证。影响:本片"完成"的判定卡在人工。缓解:已在 Task 4/6/9 显式标"需真实凭证+人工";把可单测部分(PKCE、URL 构造、回调 state 校验、状态机)最大化,真实 OAuth 留一个清晰的人工验收清单。**这是硬约束,不是可消除的风险,只能隔离。**

4. **[实现] redirect_uri 不一致** — 触发:`callback.rs` 的端口/路径与飞书后台注册值差一个字符。影响:授权后回调 404/重定向失败,拿不到 code,且排查困难。缓解:Task 5 把 `redirect_uri()` 收敛成单一函数,Task 9 UI 直接展示这串供用户逐字复制到后台,文档同步标注。

5. **[实现] refresh_token 一次性丢失** — 触发:refresh 成功拿到新 refresh_token 但落 keychain 失败(或只更新了 access 没更 refresh)。影响:下次刷新用旧 token 失败 → 静默掉线,要重新走完整 OAuth。缓解:Task 6 的"两段提交"语义 + refresh 路径强制覆盖 keychain 里的 refresh_token,任一步失败回滚并写 `last_error`。

---

## 涉及文件清单(绝对路径)

**新建(Rust):**
- `/Users/apple/Documents/project_management/src-tauri/src/feishu/mod.rs`
- `/Users/apple/Documents/project_management/src-tauri/src/feishu/keychain.rs`
- `/Users/apple/Documents/project_management/src-tauri/src/feishu/config.rs`
- `/Users/apple/Documents/project_management/src-tauri/src/feishu/oauth.rs`
- `/Users/apple/Documents/project_management/src-tauri/src/feishu/callback.rs`
- `/Users/apple/Documents/project_management/src-tauri/src/feishu/commands.rs`
- `/Users/apple/Documents/project_management/src-tauri/examples/feishu_smoke.rs`(可选,验 TLS)

**修改:**
- `/Users/apple/Documents/project_management/src-tauri/Cargo.toml`(Task 1,`[dependencies]` 行 15 起追加)
- `/Users/apple/Documents/project_management/src-tauri/src/lib.rs`(Task 7,行 6 加 `pub mod feishu;`;行 51-55 `generate_handler!` 追加 4 个 command)
- `/Users/apple/Documents/project_management/src/lib/settings.ts`(Task 8,`SettingsState`/`defaults`/`readStored`/`SettingsStore` 四处)
- `/Users/apple/Documents/project_management/src/pages/SettingsPage.tsx`(Task 9,仿行 326-380 `McpAccessSection` 新增 `FeishuConnectSection` + 行 131-137 挂 `<Section>`)

**核查(大概率不改):**
- `/Users/apple/Documents/project_management/src-tauri/capabilities/default.json`(Task 10)

**不碰(后续片):**
- `src/lib/db.ts`、`src/lib/store.ts`、`src/lib/syncBus.ts`、`src-tauri/src/mcp/*`(尤其 `connect.rs` 不动)


---

# 片2:数据层

I now have all the contracts I need. One last check: confirm whether plugin-sql exposes a transaction API (it does NOT — it's just `execute`/`select`), and verify sqlx `transaction()` is available for the Rust side. I have enough from the Cargo features (sqlx 0.8 runtime-tokio sqlite) and server.rs patterns. Let me write the plan.

Based on my reading of the real code, here is the data-layer implementation plan.

---

# 数据层实施计划（Daybreak 飞书/Lark 日历同步）

> 范围:SQLite 三张表(`calendar_events` / `event_map` / `sync_state`)、TS 类型、新 Zustand store、SyncTopic 扩展、App.tsx 接线、Rust 侧 sqlx 访问。
> 只读分析产出,未改任何文件。下面每个任务给的"行号锚点"指向当前真实代码,照搬模式。

---

## 关键事实与约束(影响所有任务,先读)

- **plugin-sql 没有事务 API**:`@tauri-apps/plugin-sql` 的 `Database` 只暴露 `execute(sql, binds) → {rowsAffected, lastInsertId}` 和 `select(sql, binds)`(见 `node_modules/@tauri-apps/plugin-sql/dist-js/index.d.ts:88`)。**没有 `db.transaction()`**。所以方案里说的"token 推进与写库同一 DB 事务":
  - 前端这一侧只能用 `BEGIN`/`COMMIT`/`ROLLBACK` 裸 SQL 串手动包(`db.execute("BEGIN")` … `db.execute("COMMIT")`),且必须自己 try/catch 回滚。**这是个坑,本片任务 T6 给出封装函数 `dbTx()` 兜这个**。
  - Rust 侧 sqlx 有真事务(`pool.begin().await` → `tx.commit()`),由"同步引擎片"(下游 X 片)在写 `calendar_events` + 推进 `sync_state.sync_token` 时使用。本片 T8 给 Rust 仓储函数,但**事务编排归同步引擎片**,本片只保证函数签名能被纳入同一个 `&mut Transaction`。
- **Rust 不建表**:`mcp/db.rs:13` 是 `create_if_missing(false)`,`lib.rs:18` 注释明确"Schema 初始化在前端 db.ts,Rust 端不写迁移"。**三张新表必须且只能在 `src/lib/db.ts` 的 `SCHEMA_V1` + `migrate()` 里建**。Rust 侧若在前端建表前先跑,查表会报错——这是个时序依赖,T8 验收点要覆盖。
- **id 生成风格**:前端 `newTodoId()`(`store.ts:237`)= `t<ms>_<rand4>`;Rust `gen_id(prefix)`(`server.rs:39`)同风格。本片本地事件 id 用前缀 `ce`,map id 用 `em`。
- **ISO 时间戳**:前端 `new Date().toISOString()`,Rust `now_iso()`(`server.rs:34`,带毫秒+Z)。两边对齐,不要换格式。
- **归一目标格式**:同步下来的事件最终要能喂给日历视图。复用 `src/lib/calendar.ts`:`scheduledDate` = `"YYYY-MM-DD"`(`dateKey` 风格),`scheduledTime` = `"HH:MM-HH:MM"`(`parseScheduledTime` 反向,`calendar.ts:100`,正则 `^\d{1,2}:\d{2}-\d{1,2}:\d{2}$`,且 `endMin > startMin`)。**全天事件 `scheduledTime` 置 null**。这个归一转换函数本片 T3 给契约,但具体 IANA 时区→本地的换算逻辑细节归"同步引擎片"实现;本片只定义存储字段 + 转换函数签名。
- **测试**:已有 vitest(`package.json:11` `"test": "vitest run"`),范式见 `src/lib/calendar.test.ts`(纯函数 `describe/it/expect`)。本片可单测的点都是纯函数(row↔type 转换、归一函数),DB CRUD 不单测(依赖 Tauri runtime)。

---

## T1 — 三张表的 Schema(改 `src/lib/db.ts`)

**改哪**:`src/lib/db.ts` 的 `SCHEMA_V1` 模板字符串(当前 `19-106` 行),在末尾(`activity_log` 索引之后、反引号之前,约第 105 行)追加三张表的 `CREATE TABLE IF NOT EXISTS` + 索引。照搬现有每张表的写法(全 `TEXT`/`INTEGER`,时间戳用 `TEXT NOT NULL`,布尔用 `INTEGER NOT NULL DEFAULT 0`,见 `todos` 表 `20-35`)。

**要新增的表结构(字段级契约)**:

```sql
-- 同步下来的日历事件(独立实体,不塞 todos)
CREATE TABLE IF NOT EXISTS calendar_events (
  id              TEXT PRIMARY KEY,        -- 本地 id，前缀 'ce'（gen_id）
  region          TEXT NOT NULL,           -- 'feishu' | 'lark'
  calendar_id     TEXT NOT NULL,           -- 远端日历 id
  remote_id       TEXT NOT NULL,           -- 远端 event_id（母日程 id）
  recurrence_key  TEXT,                    -- 重复实例去重：母日程 id + 原始起始时间；非重复事件为 NULL
  summary         TEXT NOT NULL DEFAULT '',-- 标题
  description     TEXT,
  location        TEXT,
  is_all_day      INTEGER NOT NULL DEFAULT 0, -- 全天标志
  start_ts        TEXT,                    -- 定时事件：RFC3339/ISO（UTC）；全天为 NULL
  end_ts          TEXT,
  start_date      TEXT,                    -- 全天事件：'YYYY-MM-DD'（UTC+0）；定时为 NULL
  end_date        TEXT,
  timezone        TEXT,                    -- IANA 时区（定时事件归一用）
  scheduled_date  TEXT,                    -- 归一产物：'YYYY-MM-DD'（本地），喂日历视图
  scheduled_time  TEXT,                    -- 归一产物：'HH:MM-HH:MM'；全天为 NULL
  status          TEXT NOT NULL DEFAULT 'confirmed', -- 'confirmed' | 'cancelled'（远端删除）
  is_writable     INTEGER NOT NULL DEFAULT 0, -- 该事件所在日历是否可写（逐日历探测结果冗余到事件行）
  is_deleted      INTEGER NOT NULL DEFAULT 0, -- 软删（远端 cancelled → 1）
  etag            TEXT,                    -- 远端版本号，三态冲突判定用
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cal_events_region_cal ON calendar_events(region, calendar_id);
CREATE INDEX IF NOT EXISTS idx_cal_events_sched_date ON calendar_events(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_cal_events_status ON calendar_events(status);

-- 远端 event_id ↔ 本地 id 映射 + 去重唯一键
CREATE TABLE IF NOT EXISTS event_map (
  id              TEXT PRIMARY KEY,        -- 前缀 'em'
  region          TEXT NOT NULL,
  calendar_id     TEXT NOT NULL,
  remote_id       TEXT NOT NULL,           -- 远端 event_id
  local_id        TEXT NOT NULL,           -- → calendar_events.id
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
-- 核心:同一(区域,日历,远端事件)只允许一条映射 → 去重
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_map_remote
  ON event_map(region, calendar_id, remote_id);
CREATE INDEX IF NOT EXISTS idx_event_map_local ON event_map(local_id);

-- 每个日历一行:增量同步游标 + 状态
CREATE TABLE IF NOT EXISTS sync_state (
  region          TEXT NOT NULL,
  calendar_id     TEXT NOT NULL,
  sync_token      TEXT,                    -- 拉日程增量的游标；首次为 NULL（走 page_token 全量）
  last_sync       TEXT,                    -- 上次成功同步 ISO 时间
  status          TEXT NOT NULL DEFAULT 'idle', -- 'idle' | 'syncing' | 'error'
  last_error      TEXT,                    -- 最近一次错误信息（成功时清空）
  is_writable     INTEGER NOT NULL DEFAULT 0, -- 该日历可写探测结果
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (region, calendar_id)        -- 复合主键 = 每日历一行
);
```

> 说明(给开发者):
> - `calendar_events` 同时存 `start_ts/end_ts`(原始 UTC 时间)与 `scheduled_date/scheduled_time`(归一后给 UI),是为了"原始数据 + 视图数据"分离——重新归一(改时区显示)时不丢原始信息。
> - 日历列表本身的发现游标(发现日历增删的 sync_token)按方案是"列表级一个 token",**不进 sync_state(它是 per-calendar)**。建议单独存:复用 `sync_state` 用一个保留行 `(region, calendar_id='__list__')` 存列表游标,避免再开一张表。**这个取舍标在 T2 里,需 X 片确认**。

**验收/测试点**:
- `await getDb()` 后,`SELECT name FROM sqlite_master WHERE type='table'` 含三张新表;`PRAGMA index_list('event_map')` 含 `uq_event_map_remote`。
- 唯一索引生效:连插两条 `(region,calendar_id,remote_id)` 相同的 `event_map`,第二条抛错(UNIQUE constraint failed)。
- 非纯函数,**不进 vitest**;手动在 app 起来后用 devtools 验证,或写一次性脚本。

**依赖**:无(本片起点)。
**真实凭证/人工**:否。

---

## T2 — `migrate()` 兜底 + 列表游标存储决策(改 `src/lib/db.ts`)

**改哪**:`src/lib/db.ts` 的 `migrate()`(当前 `120-137`)。新库走 `SCHEMA_V1` 的 `IF NOT EXISTS` 自带新表,无需 ALTER;但要遵循现有范式:**所有新表也在 `migrate()` 的 V1 循环里被创建**(它就是 split `SCHEMA_V1` 逐句 execute,T1 加进 `SCHEMA_V1` 就自动覆盖)。本任务额外加的是"未来加列"的占位注释 + 列表游标行的初始化策略。

**要新增**:
- 不需要新函数。沿用 `getColumns(db, table)`(`db.ts:112`)范式,为未来给 `calendar_events` 加列预留:在 `migrate()` 末尾加注释块说明"日历表加列追加在此"。
- **列表游标决策**(二选一,建议选 A,**需 X 片拍板**):
  - **A(推荐,省一张表)**:列表发现游标存进 `sync_state` 的保留行 `calendar_id = '__list__'`。`migrate()` 不需特殊处理(按需 upsert)。
  - B:再开一张 `calendar_list_state(region PRIMARY KEY, list_sync_token, last_sync, ...)`。更干净但多一张表。

**验收/测试点**:旧库(已有 todos 数据的 daybreak.db)升级后,三张新表存在且旧数据不丢。手动验证(devtools 跑 `SELECT COUNT(*) FROM todos` 仍是原值,且三新表可查)。
**依赖**:T1。
**真实凭证/人工**:否。

---

## T3 — TS 类型 + Row↔Type 转换 + 归一函数契约(改 `src/lib/db.ts`)

**改哪**:`src/lib/db.ts`,在文件末尾新增一段 `/* ---------- Calendar Events ---------- */`,照搬 `Goal`/`GoalRow`/`rowToGoal`(`db.ts:305-336`)和 `safeJsonParseArray`(`db.ts:183`)的范式。

**要新增的类型(契约)**:

```ts
export type CalRegion = "feishu" | "lark";
export type CalEventStatus = "confirmed" | "cancelled";

export interface CalendarEvent {
  id: string;
  region: CalRegion;
  calendarId: string;
  remoteId: string;
  recurrenceKey?: string;
  summary: string;
  description?: string;
  location?: string;
  isAllDay: boolean;
  startTs?: string;        // 定时事件 UTC ISO
  endTs?: string;
  startDate?: string;      // 全天 'YYYY-MM-DD'
  endDate?: string;
  timezone?: string;       // IANA
  scheduledDate?: string;  // 归一 'YYYY-MM-DD'
  scheduledTime?: string;  // 归一 'HH:MM-HH:MM' | undefined（全天）
  status: CalEventStatus;
  isWritable: boolean;
  isDeleted: boolean;
  etag?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SyncStateRecord {
  region: CalRegion;
  calendarId: string;      // 业务日历 id 或 '__list__'（列表游标，若选方案 A）
  syncToken?: string;
  lastSync?: string;
  status: "idle" | "syncing" | "error";
  lastError?: string;
  isWritable: boolean;
  createdAt: string;
  updatedAt: string;
}
```

**要新增的函数(契约级签名,不写实现)**:

```ts
// Row 类型 + 转换（仿 rowToGoal）
interface CalendarEventRow { /* snake_case 全字段，is_* 为 number */ }
function rowToCalendarEvent(r: CalendarEventRow): CalendarEvent;  // is_all_day===1 → true 等
interface SyncStateRow { /* snake_case */ }
function rowToSyncState(r: SyncStateRow): SyncStateRecord;

// 归一函数(纯函数，可单测)——把远端原始时间字段折算成 scheduledDate/scheduledTime。
// 注意：本片只给签名 + 全天分支的简单实现；定时事件的 IANA 时区换算细节由「同步引擎片」补全。
//   - 全天: startDate 直接成 scheduledDate, scheduledTime=undefined
//   - 定时: 由 startTs/endTs(UTC) + timezone 折算到本地 → scheduledDate + 'HH:MM-HH:MM'
export function normalizeEventTiming(e: Pick<CalendarEvent,
  "isAllDay" | "startTs" | "endTs" | "startDate" | "endDate" | "timezone"
>): { scheduledDate?: string; scheduledTime?: string };
```

**验收/测试点**:
- **可单测**(`src/lib/calendar.test.ts` 同款,或新建 `src/lib/calendarEvents.test.ts`):
  - `normalizeEventTiming({ isAllDay:true, startDate:"2026-05-29" })` → `{ scheduledDate:"2026-05-29", scheduledTime: undefined }`。
  - 定时事件给一个固定 `startTs`/`endTs`/`timezone`,断言 `scheduledTime` 能被 `parseScheduledTime`(`calendar.ts:100`)成功解析回相同 `startMin/endMin`(往返一致性)。这是和 UI 渲染对齐的关键断言。
  - `rowToCalendarEvent` 把 `is_all_day:1` → `isAllDay:true`、`is_deleted:0` → `false`。
**依赖**:T1(字段对齐)。
**真实凭证/人工**:否(纯函数,用构造数据测)。

---

## T4 — `calendar_events` / `event_map` / `sync_state` 的 CRUD 函数(改 `src/lib/db.ts`)

**改哪**:紧接 T3,照搬 `dbListGoals`/`dbInsertGoal`/`dbUpdateGoalStatus`(`db.ts:338-379`)和 `dbUpsertReflection`(`db.ts:562`,"先删后插"upsert 范式)。

**要新增的函数(契约)**:

```ts
// 读：日历视图用，默认排除软删
export async function dbListCalendarEvents(opts?: {
  from?: string; to?: string;      // scheduledDate 范围过滤
  region?: CalRegion;
  includeDeleted?: boolean;
}): Promise<CalendarEvent[]>;

// upsert 单个事件 + 维护 event_map（按 region+calendar_id+remote_id 去重）。
// 返回 local_id（已存在则复用，新建则 gen 'ce'）。
export async function dbUpsertCalendarEvent(e: CalendarEvent): Promise<string>;

// 批量 upsert（一次同步拉回多条）——内部用 dbTx 包（见 T6）
export async function dbBulkUpsertCalendarEvents(events: CalendarEvent[]): Promise<void>;

// 软删（远端 cancelled）：status='cancelled', is_deleted=1
export async function dbSoftDeleteCalendarEvent(localId: string): Promise<void>;

// event_map 查询：远端 id → 本地 id（去重命中判定）
export async function dbFindLocalId(
  region: CalRegion, calendarId: string, remoteId: string
): Promise<string | null>;

// sync_state：每日历一行的读 / upsert / 推进 token / 置错
export async function dbGetSyncState(region: CalRegion, calendarId: string): Promise<SyncStateRecord | null>;
export async function dbListSyncStates(region?: CalRegion): Promise<SyncStateRecord[]>;
export async function dbUpsertSyncState(s: SyncStateRecord): Promise<void>;     // 复合主键 upsert
export async function dbSetSyncStatus(
  region: CalRegion, calendarId: string,
  status: SyncStateRecord["status"], lastError?: string | null
): Promise<void>;
```

> 实现提示(给开发者,非契约):
> - `dbUpsertCalendarEvent` 流程:先 `dbFindLocalId` → 命中则 `UPDATE calendar_events ... WHERE id=local_id` + bump `updated_at`;未命中则 `gen 'ce'` + `INSERT calendar_events` + `INSERT event_map`。
> - 复合主键 upsert 用 SQLite `INSERT ... ON CONFLICT(region,calendar_id) DO UPDATE SET ...`(plugin-sql 支持标准 SQLite 语法),比"先删后插"安全。`event_map` 的去重也可走 `ON CONFLICT(region,calendar_id,remote_id) DO UPDATE`。

**验收/测试点**:DB CRUD **不进 vitest**(需 Tauri runtime)。验收方式:
- 写一次性 devtools 脚本:`dbUpsertCalendarEvent` 同一 `remoteId` 调两次 → `SELECT COUNT(*) FROM calendar_events WHERE remote_id=?` 仍为 1(去重生效);`event_map` 也只有一行。
- `dbSoftDeleteCalendarEvent` 后 `dbListCalendarEvents()`(默认)不返回它,`includeDeleted:true` 返回。
**依赖**:T3、T6(批量函数依赖 `dbTx`)。
**真实凭证/人工**:否。

---

## T5 — 新 SyncTopic `"calendar_events"`(改 `src/lib/syncBus.ts`)

**改哪**:`src/lib/syncBus.ts:17` 的 `SyncTopic` 联合类型,加一项。

```ts
export type SyncTopic =
  | "todos"
  | "goals"
  | "conversations"
  | "reflections"
  | "activities"
  | "reminder"
  | "calendar_events";   // 新增
```

> 注意:topic 字符串 `"calendar_events"` 是前后端约定的同步频道名。Rust 侧 `notify("calendar_events")`(T8)和前端 `emitSync("calendar_events")` / App.tsx 的 `onSync("calendar_events", ...)`(T7)必须用**完全相同的字符串**,否则跨窗口/跨进程同步静默失效。`emitSync`/`onSync`(`syncBus.ts:32/46`)本身泛化,改类型即可,无需改逻辑。

**验收/测试点**:`tsc` 通过(联合类型扩展,编译期即验证)。改完 `emitSync("calendar_events")` 不报类型错。**不单测**。
**依赖**:无(可与 T1 并行)。
**真实凭证/人工**:否。

---

## T6 — Zustand `calendarStore` + 事务封装 `dbTx`(新建 `src/lib/calendarStore.ts`,改 `src/lib/db.ts`)

**(a) 事务封装 `dbTx`** — 改 `src/lib/db.ts`(放在 `getDb()` 之后,CRUD 之前):

plugin-sql 无事务 API,手动包:

```ts
/**
 * 手动事务:plugin-sql 不提供 transaction()，用裸 BEGIN/COMMIT/ROLLBACK 包一组写。
 * 失败时回滚并重抛。注意：SQLite 默认非嵌套事务，不要在 fn 内再调 dbTx。
 */
export async function dbTx(fn: (db: Database) => Promise<void>): Promise<void> {
  const db = await getDb();
  await db.execute("BEGIN");
  try {
    await fn(db);
    await db.execute("COMMIT");
  } catch (e) {
    try { await db.execute("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  }
}
```

> 关键决策:`dbBulkUpsertCalendarEvents`(T4)和"前端侧 token 推进 + 写事件"用这个包,保证半途失败不留脏数据。**前端的"token 推进与写库同事务"靠这个落地;Rust 那条路径用 sqlx 真事务(T8)**。

**(b) `calendarStore.ts`** — 新建,**完整仿 `activityStore.ts`**(它最干净:`hydrate` + mutations + `emitSync`,见 `activityStore.ts:32-62`):

```ts
import { create } from "zustand";
import {
  dbListCalendarEvents, dbBulkUpsertCalendarEvents, dbSoftDeleteCalendarEvent,
  dbListSyncStates, type CalendarEvent, type SyncStateRecord
} from "./db";
import { emitSync } from "./syncBus";

interface CalendarStore {
  events: CalendarEvent[];
  syncStates: SyncStateRecord[];
  loaded: boolean;
  hydrate: () => Promise<void>;                       // 读 events + sync_states 全量
  upsertEvents: (events: CalendarEvent[]) => Promise<void>;  // 写库 + 内存 + emitSync("calendar_events")
  softDelete: (localId: string) => Promise<void>;
  refreshSyncStates: () => Promise<void>;             // 只刷 sync_state（同步引擎更新状态后调）
}

export const useCalendarStore = create<CalendarStore>((set) => ({ /* 仿 activityStore */ }));
```

> 范式细节(照搬 `activityStore`):
> - `hydrate` try/catch 兜底,失败 set 空数组 + `loaded:true`(`activityStore.ts:36-44`)。
> - 每个写 mutation:先 `await db写` → `set(...)` 更内存 → `emitSync("calendar_events")`(`activityStore.ts:46-55`)。
> - **不自持久化**,纯内存缓存,真相源是 SQLite(全局约束)。

**验收/测试点**:
- `dbTx` **可半单测**:mock `getDb` 返回一个记录 execute 调用序列的假 db,断言成功路径调了 `BEGIN`→fn→`COMMIT`,失败路径调了 `BEGIN`→`ROLLBACK` 且重抛。
- store 本身不单测(依赖 db);验收靠 T7 接线后端到端看视图刷新。
**依赖**:T3、T4、T5。
**真实凭证/人工**:否。

---

## T7 — App.tsx 接线:hydrate + onSync + notify 三条链路(改 `src/App.tsx`)

**改哪**:`src/App.tsx` 的 `MainApp()`,三处都要动,**完全照搬 todos/goals/activities 的三段已有 effect**:

1. **首屏 hydrate**(仿 `App.tsx:60-64`):
   - 现在只 hydrate todos。加 `useCalendarStore` 的 hydrate。建议:`useEffect(() => { void useCalendarStore.getState().hydrate(); }, [])`(或加进现有 effect)。

2. **Rust notify 链路**(`App.tsx:67-80`,监听 `daybreak://data-changed`):
   - 在 if/else 链(`App.tsx:73-75`)加一支:
     ```ts
     else if (topic === "calendar_events") void useCalendarStore.getState().hydrate();
     ```
   - 末尾 `emitSync(topic)`(`App.tsx:76`)无需改,它把 Rust 通知再广播给浮窗。

3. **跨窗口 onSync 链路**(`App.tsx:84-93`):
   - 加:
     ```ts
     const offCal = onSync("calendar_events", () => void useCalendarStore.getState().hydrate());
     ```
   - cleanup 里加 `offCal()`(仿 `App.tsx:88-92`)。

> 注意:`App.tsx:13-15` 顶部要 `import { useCalendarStore } from "./lib/calendarStore";`。浮窗分支(`FloatingApp`)是否也要订阅日历同步,取决于浮窗 UI 是否展示日程——**这归 UI 片决定,本片只接主窗 `MainApp`**。

**验收/测试点**:端到端手动:
- 启动 app → `useCalendarStore.getState().loaded === true`(devtools)。
- 让 Rust 侧(或手动 invoke)写一条事件并 `notify("calendar_events")` → 主窗 store `events` 自动多一条(notify 链路通)。
- 开浮窗,主窗 `upsertEvents` → 浮窗收到 `onSync` 重 hydrate(跨窗口链路通)。
**不单测**(组件副作用 + Tauri event)。
**依赖**:T5、T6。
**真实凭证/人工**:否(可用假数据触发 notify 验证链路;真飞书数据是 X 片的事)。

---

## T8 — Rust 侧 sqlx 仓储:读写三表 + notify(新建 `src-tauri/src/sync/db.rs` 或扩 `mcp/server.rs` 复用层)

> 边界说明:本片只给"**Rust 怎么读写这三张表**"的仓储函数 + notify 范式。**OAuth、HTTP 拉取、增量同步编排、429 退避**全部归"同步引擎片(X 片)";本片产出的函数是它的存储底座。放哪个 module 由 X 片定,建议新建 `src-tauri/src/sync/` 与 `mcp` 平级,本片先给函数契约。

**改哪/建哪**:
- 复用连接范式:`src-tauri/src/mcp/db.rs:13` 的 `connect(db_path)`(WAL + busy_timeout + `create_if_missing(false)`)。同步引擎应**复用同一个 `connect`**(或同款 options)连 `daybreak.db`,**绝不自己建表**(表由前端 T1 建)。
- 读写 SQL 范式:`server.rs` 全程用运行时 `sqlx::query(sql).bind(..)`(**非 `query!` 宏**,无编译期 DB 校验,见 `server.rs:219/237/263`)。`Row::get::<T,_>("col")` 取列(`server.rs:54-65`)。`res.rows_affected()` 判命中(`server.rs:270`)。
- notify 范式:写成功后 `(self.notify)("calendar_events")`(仿 `server.rs:254`)。`Notifier` 类型已在 `server.rs:29` / 经 `mcp/mod.rs:21` 导出;同步引擎应接收同款 `Notifier` 回调(`lib.rs:45-47` 构造,emit `daybreak://data-changed`)。

**要新增的 Rust 函数(契约级签名)**:

```rust
// 事件 upsert（去重靠 event_map 唯一键）。注意全部接受 &mut Transaction，
// 让「同步引擎片」能把「写事件 + 推进 sync_token」放进同一个 pool.begin() 事务。
pub async fn upsert_event(
    tx: &mut sqlx::SqliteConnection,   // 或 &mut Transaction<'_, Sqlite>
    e: &CalendarEventInput,            // Rust 侧结构体，字段对齐 calendar_events
) -> Result<String, sqlx::Error>;      // 返回 local_id

pub async fn soft_delete_event(
    tx: &mut sqlx::SqliteConnection, region: &str, calendar_id: &str, remote_id: &str,
) -> Result<bool, sqlx::Error>;        // 远端 cancelled → status='cancelled', is_deleted=1

pub async fn find_local_id(
    pool: &SqlitePool, region: &str, calendar_id: &str, remote_id: &str,
) -> Result<Option<String>, sqlx::Error>;

// sync_state：推进 token 必须和写事件同事务（方案硬要求）
pub async fn advance_sync_token(
    tx: &mut sqlx::SqliteConnection,
    region: &str, calendar_id: &str, new_token: Option<&str>, last_sync: &str,
) -> Result<(), sqlx::Error>;

pub async fn set_sync_status(
    pool: &SqlitePool, region: &str, calendar_id: &str,
    status: &str, last_error: Option<&str>,
) -> Result<(), sqlx::Error>;

pub async fn get_sync_state(
    pool: &SqlitePool, region: &str, calendar_id: &str,
) -> Result<Option<SyncStateRow>, sqlx::Error>;

// 可写日历探测结果写回（is_writable 同时落 sync_state 和该日历下的 events）
pub async fn set_calendar_writable(
    pool: &SqlitePool, region: &str, calendar_id: &str, writable: bool,
) -> Result<(), sqlx::Error>;
```

> id 生成:Rust 侧复用 `server.rs:39` 的 `gen_id("ce")` / `gen_id("em")`(目前是 `server.rs` 私有 fn,建议提取到 `mcp/mod.rs` 或新 util 让 sync 片复用——**这个小重构归本片可选项,或标依赖**)。
> 时间戳:复用 `now_iso()`(`server.rs:34`)同款格式。

**验收/测试点**:
- **时序依赖必测**:前端首启建表(T1)**之后**Rust 才能读这三表;若 Rust 在空库(无表)上跑,`sqlx::query` 报 `no such table`。验收:先正常起一次 app(前端建表)→ 再让同步引擎跑 → 无 `no such table`。`connect` 的 `create_if_missing(false)`(`db.rs:14`)保证 Rust 不会误建空库掩盖问题。
- `upsert_event` 同 `remote_id` 调两次 → `calendar_events` 仍一行(靠 `event_map` 唯一键 + `ON CONFLICT`),`rows_affected` 行为符合预期。
- `advance_sync_token` + `upsert_event` 在同一 `tx`,中途 `Err` → 整体回滚(`sync_token` 不前进、事件不写)。这是方案"同事务"的核心,**X 片编排时验收,本片保证函数签名支持**。
- Rust 侧可写 `#[cfg(test)]` 单测(用临时文件 sqlite + 手动建表),但**本片不强制**;集成验收归 X 片。
**依赖**:T1(表必须先建)。逻辑上被 X 片(同步引擎)依赖。
**真实凭证/人工**:本片函数本身**否**(可用构造数据 + 临时库测)。但"端到端证明同步写入正确"需真实飞书凭证 + 人工浏览器授权 → **那是 X 片的验收,标注为需人工**。

---

## 任务依赖图 & 边界

```
T1(建表) ──┬─> T2(migrate兜底/列表游标决策)
           ├─> T3(TS类型+归一函数) ──> T4(前端CRUD) ──┐
           │                                          ├─> T6(dbTx+calendarStore) ──> T7(App接线)
           └─> T8(Rust仓储)                            │
T5(SyncTopic) ─────────────────────────────────────────┘（T6/T7 都依赖）
```

**本片交付的边界外依赖(只标,不做)**:
- **依赖 X 片(同步引擎)**:OAuth 授权码+PKCE、token 存 keychain(新引 `keyring` crate)、HTTP 拉日历/日程、增量 sync_token 翻页、429 退避、重复事件服务端展开、IANA 时区精确换算、本地变更队列与三态冲突解决、可写日历探测的实际 HTTP 调用。本片只提供这些要落地的**存储字段 + 仓储函数 + 归一函数骨架**。
- **依赖 UI 片**:`CalendarPage.tsx` 把 `calendar_events`(经 `dbListCalendarEvents` / `useCalendarStore`)与现有 Todo 日程**合并渲染**;设置页的"连接飞书/Lark"区块。本片不碰任何 page/组件。
- **可选小重构(建议纳入本片,否则标依赖)**:把 `server.rs` 私有的 `gen_id` / `now_iso` 提到共享 util,供 `sync/db.rs` 复用,避免复制。

**全程硬约束**:三张表只能前端 `db.ts` 建(Rust `create_if_missing(false)`);所有写路径 = 写库 → 更内存 store → `emitSync("calendar_events")`;Rust 写路径额外 `notify("calendar_events")`;真相源永远是 SQLite。

---

**关键文件路径(绝对)**:
- `/Users/apple/Documents/project_management/src/lib/db.ts`(T1/T2/T3/T4/T6a)
- `/Users/apple/Documents/project_management/src/lib/syncBus.ts`(T5,改第 17 行联合类型)
- `/Users/apple/Documents/project_management/src/lib/calendarStore.ts`(T6b,新建,仿 `/Users/apple/Documents/project_management/src/lib/activityStore.ts`)
- `/Users/apple/Documents/project_management/src/App.tsx`(T7,改 `MainApp` 第 60-93 行三段 effect)
- `/Users/apple/Documents/project_management/src-tauri/src/mcp/db.rs`(T8 复用 `connect`)、`/Users/apple/Documents/project_management/src-tauri/src/mcp/server.rs`(T8 复用 sqlx/notify/gen_id/now_iso 范式)、建议新建 `/Users/apple/Documents/project_management/src-tauri/src/sync/db.rs`
- 测试范式:`/Users/apple/Documents/project_management/src/lib/calendar.test.ts`;归一函数往返断言依赖 `parseScheduledTime`(`/Users/apple/Documents/project_management/src/lib/calendar.ts:100`)


---

# 片3:同步引擎

Important finding: the transitive `reqwest 0.13.3` (pulled by rmcp) has **no TLS backend** in its feature set — no `rustls`, no `native-tls`, no `default-tls`. It's only used by rmcp for something that doesn't need HTTPS. This means when I add reqwest as a direct dep for outbound HTTPS to `open.feishu.cn`, I must explicitly enable a TLS feature. I'll recommend `rustls-tls` (no OpenSSL system dependency, cleaner for macOS bundling) plus `json` and `gzip`. Feature unification means the whole tree gets TLS, which is fine.

I have all the grounding I need. Let me write the implementation plan.

I have everything needed. Here is my implementation plan for the 同步引擎(Rust) slice.

---

# 同步引擎(Rust)实施计划 — Daybreak 飞书/Lark 日历同步

> 只读分析产出。以下任务按依赖顺序排列。所有"行号锚点"基于当前 HEAD。
> 我这一片 = SQLite schema(同步相关表)+ 出站 HTTP 客户端 + 同步引擎核心循环 + token 持久化(keychain)+ 时区/重复事件归一 + 后台触发 + `feishu_sync_now` command + 写库后 notify。
> **边界外(由其它片负责)**:OAuth 授权码换取/刷新的完整流程归【认证片】;设置 UI(`SettingsPage.tsx` 填 app_id/app_secret/选区域)归【前端设置片】;新 Zustand store + `CalendarPage` 渲染归【前端日历片】;双向写回(变更队列/冲突)归【双向同步片】。我这片只读同步 + 给认证片留 token 存取接口、给前端片留表结构和 SyncTopic。

---

## 模块落点总览

新建 Rust 模块目录 `src-tauri/src/feishu/`(与 `mcp/`、`cli_agent/` 平级),内部:
- `mod.rs` — 模块导出 + region/host 常量 + 公共类型
- `db.rs` — 同步相关表的连接与读写(复用 `mcp/db.rs` 的 sqlx 连接范式)
- `client.rs` — 出站 HTTP 客户端(reqwest)+ 429 退避 + 鉴权头注入
- `token.rs` — keychain 存取(替代 `mcp/connect.rs` 明文范式)
- `sync.rs` — 同步引擎核心(日历列表→日程→token 推进事务)
- `normalize.rs` — 时区归一 + 重复事件去重 + 远端→`calendar_events` 行映射
- `engine.rs` — 后台 tokio 任务调度(启动/定时/手动/网络恢复)+ `feishu_sync_now` command

---

## 任务清单

### T1 — 建同步相关表 schema(calendar_events / event_map / sync_state / calendar_meta)

**改哪些文件**
- `src/lib/db.ts`:把 4 张表的 `CREATE TABLE IF NOT EXISTS` 追加进 `SCHEMA_V1` 常量(19-106 行),并在 `migrate()`(120-137 行)末尾按 `getColumns()`(112-118 行)范式补幂等 ALTER 兜底。**建表只在前端 db.ts 做**——这是已确立的事实:Rust 端 `create_if_missing(false)`,绝不建表(见 `mcp/db.rs:13` 注释)。
- 不改 Rust 建表逻辑。

**表结构契约**(字段级):

```sql
-- 同步来的日程(独立于 todos,不混)
CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,              -- 本地稳定 id,gen_id("ce")
  calendar_id TEXT NOT NULL,        -- 所属远端日历 id
  region TEXT NOT NULL,             -- 'feishu' | 'lark'
  title TEXT,
  scheduled_date TEXT NOT NULL,     -- 'YYYY-MM-DD' 本地时区(与 todos 同约定)
  scheduled_time TEXT,              -- 'HH:MM-HH:MM' 本地;全天事件为 NULL
  is_all_day INTEGER NOT NULL DEFAULT 0,
  start_ts INTEGER,                 -- 原始 UTC 秒(排序/调试用,定时事件有)
  end_ts INTEGER,
  status TEXT NOT NULL DEFAULT 'confirmed', -- 'confirmed' | 'cancelled'(软删)
  is_recurring_instance INTEGER NOT NULL DEFAULT 0,
  master_event_id TEXT,             -- 重复事件母 id(去重键的一半)
  original_start_ts INTEGER,        -- 实例原始起始 UTC 秒(去重键的另一半)
  etag TEXT,                        -- 远端版本号,供双向片做冲突判定
  is_writable INTEGER NOT NULL DEFAULT 0, -- 该日历是否可写(双向片用)
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cal_events_date ON calendar_events(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_cal_events_calendar ON calendar_events(calendar_id);
CREATE INDEX IF NOT EXISTS idx_cal_events_status ON calendar_events(status);

-- 远端 event_id ↔ 本地 id 幂等映射(唯一索引防重复回插)
CREATE TABLE IF NOT EXISTS event_map (
  region TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  remote_event_id TEXT NOT NULL,    -- 飞书 event_id
  dedup_key TEXT NOT NULL,          -- 重复实例去重键: master_event_id + ':' + original_start_ts;非重复事件= remote_event_id
  local_id TEXT NOT NULL,           -- → calendar_events.id
  PRIMARY KEY (region, calendar_id, dedup_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_map_local ON event_map(local_id);

-- 每日历一行的增量同步游标
CREATE TABLE IF NOT EXISTS sync_state (
  region TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  sync_token TEXT,                  -- 该日历日程增量游标;NULL 表示还没全量过
  last_synced_at TEXT,
  status TEXT NOT NULL DEFAULT 'idle', -- 'idle' | 'syncing' | 'error'
  last_error TEXT,
  PRIMARY KEY (region, calendar_id)
);

-- 日历列表本身的游标 + 每个日历的元信息(发现增删)
CREATE TABLE IF NOT EXISTS calendar_meta (
  region TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  summary TEXT,                     -- 日历名
  cal_type TEXT,                    -- 'primary' | 'shared' | ...(双向片判可写用)
  access_role TEXT,                 -- 'owner' | 'writer' | 'reader'(双向片判可写用)
  is_deleted INTEGER NOT NULL DEFAULT 0, -- 日历被删时置 1
  PRIMARY KEY (region, calendar_id)
);
-- 日历列表级别的 sync_token 单独存一行(calendar_id='__list__' 占位)在 sync_state 里复用,避免再开一张表
```

> **关键决策**:日历列表级 `sync_token` 复用 `sync_state` 表,用保留 `calendar_id = '__list__'` 的行存,不另开表。

**新增的 TS 函数签名**(供前端日历片读;我这片只定义读接口,渲染归前端片):
- 在 `src/lib/db.ts` 加 `dbListCalendarEvents(): Promise<CalendarEventRow[]>`(过滤 `status != 'cancelled'`)、`CalendarEventRow` interface + `rowToCalendarEvent()`。这是给前端片的输入契约,**实现可由前端片接走**——我只需在计划里钉死字段名,实际 TS CRUD 代码归前端片。

**验收/测试点**
- 启动 App,`PRAGMA table_info(calendar_events)` 等 4 张表列齐全。
- 旧库(无这些表)启动后 `migrate()` 跑完表存在;新库直连也有。**可单测**:对 in-memory sqlite 跑 `SCHEMA_V1` split 后的每条语句不报错。
- 唯一索引生效:重复插同 `(region,calendar_id,dedup_key)` 报约束冲突。

**依赖**:无(最前置)。
**需要真实凭证/人工**:否。

---

### T2 — 加 Rust 依赖(reqwest / keyring / chrono-tz / tokio time 特性)

**改哪些文件**
- `src-tauri/Cargo.toml`,`[dependencies]` 段(15-38 行)。

**要加的依赖**(契约级,附理由):
```toml
# 出站 HTTP:飞书 OpenAPI。注意 lockfile 里 rmcp 间接带的 reqwest 0.13 没启用任何 TLS backend,
# 直连 HTTPS 必须显式开 TLS。选 rustls 避免依赖系统 OpenSSL,macOS 打包更干净。
reqwest = { version = "0.13", default-features = false, features = ["json", "rustls-tls", "gzip"] }
# OAuth 凭证 + token 存 OS keychain(替代 mcp_token.txt 明文范式)
keyring = "3"
# 定时事件 IANA 时区 → 本地时间归一
chrono-tz = "0.10"
```
- 修改现有 `tokio` 行(27 行):**追加 `"time"` 特性**(后台定时 `interval`/退避 `sleep` 需要,当前未启用)。改成:
  `tokio = { version = "1", features = ["rt-multi-thread", "net", "sync", "macros", "process", "io-util", "time"] }`
- `chrono` 行(37 行)当前只有 `clock` 特性,够用(chrono-tz 自带 timezone 支持),不用改。

**验收/测试点**
- `cargo build`(在 `src-tauri/` 下,或 `cargo check --manifest-path src-tauri/Cargo.toml`)通过,无 TLS backend 冲突、无 `libsqlite3-sys` 重复链接报错(reqwest 用 rustls 不碰 sqlite)。
- `cargo tree -i reqwest` 确认直接依赖版本带 `rustls-tls`。

**依赖**:无。
**需要真实凭证/人工**:否。但 keyring 在 CI/headless 环境可能无可用后端 → 见 T4 风险说明。

---

### T3 — 出站 HTTP 客户端 + 429 指数退避 + region 路由

**建哪些文件**
- 新建 `src-tauri/src/feishu/client.rs`。
- 新建 `src-tauri/src/feishu/mod.rs`(声明 `pub mod client;` 等,加 region/host 常量)。
- `src-tauri/src/lib.rs`:在模块声明区(4-6 行,`pub mod mcp;` `pub mod cli_agent;` 旁)加 `pub mod feishu;`。

**`mod.rs` 常量与类型契约**:
```rust
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Region { Feishu, Lark }
impl Region {
    pub fn host(&self) -> &'static str {  // open.feishu.cn vs open.larksuite.com
        match self { Region::Feishu => "open.feishu.cn", Region::Lark => "open.larksuite.com" }
    }
    pub fn as_str(&self) -> &'static str { /* "feishu" | "lark" */ }
    pub fn from_str(s: &str) -> Option<Self> { /* 反解 */ }
}
```

**`client.rs` 契约**(签名级,别写实现):
```rust
pub struct FeishuClient {
    http: reqwest::Client,   // 复用连接池;低并发(见下)
    region: Region,
}

/// 调用方传入 user_access_token(由认证片提供,见 T4),客户端只负责发请求 + 退避。
impl FeishuClient {
    pub fn new(region: Region) -> Self;

    /// 通用 GET,自动:① 拼 https://{host}/open-apis/{path} ② 注入 Authorization: Bearer
    /// ③ 处理 429(读 Retry-After / X-Ogw-Ratelimit-* 响应头建议等待秒数,指数退避兜底)
    /// ④ 把飞书 body 里的 code!=0 转成 Err。返回原始 serde_json::Value 供各调用方自解析。
    pub async fn get_json(
        &self,
        token: &str,
        path: &str,                       // 如 "calendar/v4/calendars"
        query: &[(&str, &str)],
    ) -> Result<serde_json::Value, FeishuError>;
}

/// 退避策略:base=1s,factor=2,max_retries=5,cap=60s;优先用响应头建议值。
/// 低并发:同一时刻只跑一个同步任务(engine 层用单 task 保证),日历间串行拉。
fn backoff_delay(attempt: u32, retry_after_header: Option<u64>) -> Duration;

pub enum FeishuError {
    Http(reqwest::Error),
    RateLimited { retry_after: Option<u64> },   // 重试耗尽后才冒出来
    Api { code: i64, msg: String },             // 飞书 code != 0
    TokenExpired,                                // code 对应 token 失效 → engine 触发刷新(认证片)
}
```

> **关键决策**:退避「读响应头建议等待」——飞书 429 返回 `X-Ogw-Ratelimit-Reset`/标准 `Retry-After`,优先采纳;无头时用指数退避。**重试耗尽前不向上抛 `RateLimited`**,避免误判为永久失败。
> **串行/低并发**:不在 client 层做信号量,而在 engine 层保证「同一时刻一个同步任务、日历逐个串行」(最简单且足够);client 的 reqwest::Client 本身复用连接。

**验收/测试点**
- **可单测(纯函数)**:`backoff_delay(attempt, header)` —— 给定 attempt 序列产出递增且 ≤cap 的 Duration;给 `retry_after_header=Some(N)` 时返回约 N 秒。
- **可单测**:`Region::host/from_str` 双向映射。
- **集成验证(需凭证,标人工)**:用真实 token 调 `get_json("calendar/v4/calendars", &[])` 拿到 `code==0` 且有 `calendar_list`。可写一个 `examples/feishu_smoke.rs`(仿 `examples/mcp_smoke.rs` 的命令行冒烟范式,lib.rs:3 注释提到该模式),token 从环境变量读。

**依赖**:T2。
**需要真实凭证/人工**:单测不需要;真实 endpoint 验证**需要 user_access_token**(由 T4/认证片提供),标注人工。

---

### T4 — keychain token 存取(替代明文范式)

**建哪些文件**
- 新建 `src-tauri/src/feishu/token.rs`。

**背景锚点**:现有 token 持久化是反例——`mcp/connect.rs:11-23` `load_or_create_token()` 把 token 明文写 `mcp_token.txt`。新功能按已锁定方案改用 OS keychain(keyring crate)。

**契约**(签名级):
```rust
/// keychain service 名固定,account 用 "{region}:{kind}" 区分两平台两套凭证。
/// kind: "app_secret" | "user_access_token" | "refresh_token"
const SERVICE: &str = "com.daybreak.feishu";

pub fn save(region: Region, kind: &str, value: &str) -> Result<(), TokenError>;
pub fn load(region: Region, kind: &str) -> Result<Option<String>, TokenError>; // 不存在返回 Ok(None)
pub fn delete(region: Region, kind: &str) -> Result<(), TokenError>;

/// 一组同步要用的凭证快照(engine 启动一次性读出)
pub struct Credentials {
    pub region: Region,
    pub app_id: String,        // app_id 非敏感,可与 secret 一起放 keychain 也可放 settings;统一放 keychain 省事
    pub app_secret: String,
    pub user_access_token: String,
    pub refresh_token: String,
}
pub fn load_credentials(region: Region) -> Result<Option<Credentials>, TokenError>;
```

> **关键决策**:`app_id`/`app_secret`/两个 token 全部进 keychain(account 用 `region:kind` 命名),与 `mcp_token.txt` 明文彻底切割,呼应 `settings.ts:13` 的"上 keychain"TODO。
> **与认证片的接口边界**:认证片负责跑 OAuth 拿到 token 后,**调用本片的 `token::save()` 落盘**;刷新 token 时,认证片提供 `refresh()` 函数,但**「新 refresh_token 必须在写库成功的同一事务里持久化」这条约束的落地点在 engine(T7)**——见 T7 风险与缓解。

**验收/测试点**
- **可单测(本机有 keychain 时)**:`save → load → delete` 往返一致;`load` 不存在的 key 返回 `Ok(None)` 不报错。
- 跨重启:写一次后重启 App,`load_credentials` 仍拿得到(手动验证,标注需 GUI 运行)。

**依赖**:T2、T3(用到 `Region`)。
**需要真实凭证/人工**:单测用假值即可;**CI/headless 注意**:keyring 在无 Secret Service/无登录态的环境会失败 → 单测需 `#[cfg(target_os="macos")]` 或在 CI 跳过(标注)。

---

### T5 — 时区归一 + 远端事件→行映射(normalize)

**建哪些文件**
- 新建 `src-tauri/src/feishu/normalize.rs`。

**背景锚点**:目标格式由 `src/lib/calendar.ts:100` `parseScheduledTime()` 的正则钉死——`scheduled_time` 必须是 `^\d{1,2}:\d{2}-\d{1,2}:\d{2}$`(如 `09:30-11:00`),且 `endMin > startMin`、均 < 1440;`scheduled_date` 是本地时区 `YYYY-MM-DD`(`dateKey()`,calendar.ts:11)。归一产物必须能被这个解析器吃下。

**契约**(签名级):
```rust
/// 飞书 event 的时间字段最小模型(从 get_json 的 Value 里解出)
pub struct RawTime {
    pub date: Option<String>,        // 全天事件:"2026-05-29"(UTC+0 语义,飞书规定)
    pub timestamp: Option<String>,   // 定时事件:Unix 秒(字符串)
    pub timezone: Option<String>,    // IANA,如 "Asia/Shanghai"
}

pub struct NormalizedTime {
    pub scheduled_date: String,       // 本地 'YYYY-MM-DD'
    pub scheduled_time: Option<String>, // 'HH:MM-HH:MM';全天为 None
    pub is_all_day: bool,
    pub start_ts: Option<i64>,
    pub end_ts: Option<i64>,
}

/// 两路归一:
/// - 全天(start.date 有值):按 date 直接取,scheduled_time=None,is_all_day=true。
///   关键:全天事件飞书用 UTC+0 的 date,**不要做时区偏移**,否则跨日。
/// - 定时(start.timestamp 有值):用 start.timezone(IANA, chrono-tz 解析)把 UTC 秒转成
///   **本机本地时区**的 date + HH:MM;跨天事件(end < start 当天)按需裁断或落在起始日(见决策)。
pub fn normalize(start: &RawTime, end: &RawTime) -> NormalizedTime;

/// 远端 event Value → calendar_events 行 + dedup_key。
/// 返回 None 表示该 event 应被忽略(无法解析时间等)。
pub fn map_event(
    region: Region,
    calendar_id: &str,
    is_writable: bool,
    raw: &serde_json::Value,
) -> Option<MappedEvent>;

pub struct MappedEvent {
    pub remote_event_id: String,
    pub dedup_key: String,           // 重复实例: "{master_event_id}:{original_start_ts}";否则 = remote_event_id
    pub title: Option<String>,
    pub status: String,              // "confirmed" | "cancelled"
    pub time: NormalizedTime,
    pub master_event_id: Option<String>,
    pub original_start_ts: Option<i64>,
    pub etag: Option<String>,
}
```

> **关键决策(需在计划里明示给开发者)**:
> 1. **全天事件零偏移**:飞书全天事件 `start.date` 是 UTC+0 日历日,直接当本地 `scheduled_date`,绝不 `Utc→Local` 转,否则 UTC+8 用户会看到日期前移一天。
> 2. **跨天定时事件**:`parseScheduledTime` 要求 `endMin>startMin` 且 ≤1440,**无法表达跨天**。决策:跨天事件 `scheduled_time` 落在起始日、`end` 截到 `23:59`(或置 `scheduled_time=None` 退化为全天展示)——二选一,建议前者,在注释写明这是已知近似。
> 3. **去重键**:非重复事件 `dedup_key = remote_event_id`;重复实例 `dedup_key = master_event_id + ":" + original_start_ts`(已锁定方案)。

**验收/测试点**(这步是单测重灾区,**全部可单测**,无需凭证):
- 全天:`{date:"2026-05-29"}` → `scheduled_date="2026-05-29"`, `time=None`, `is_all_day=true`(在 UTC+8 与 UTC-5 两个测试时区下日期都不漂)。
- 定时:`Asia/Shanghai` 下 `timestamp` 对应 09:30 → `"09:30-..."`;换 `America/New_York` 同一 UTC 秒得到不同本地 HH:MM。
- 产物喂给一份 `parseScheduledTime` 的 Rust 等价校验(或直接断言正则)必须通过。
- 跨天事件按既定决策断言。
- `map_event`:`status:"cancelled"` 的 event 正确标 cancelled;重复实例 dedup_key 拼接正确。

**依赖**:T2(chrono-tz)。
**需要真实凭证/人工**:否(用构造的 JSON 测)。

---

### T6 — 同步引擎核心:日历列表 + 日程拉取 + token/写库同一事务(sync)

**建哪些文件**
- 新建 `src-tauri/src/feishu/sync.rs`。
- 新建 `src-tauri/src/feishu/db.rs`(同步相关表的 sqlx 读写,复用 `mcp/db.rs:13` 的 `connect()` 连接范式——`create_if_missing(false)` + WAL + busy_timeout)。

**`db.rs` 契约**:
```rust
// 复用 mcp::db::connect 的同款 SqliteConnectOptions(WAL/busy_timeout/不建库)。
pub async fn connect(db_path: &Path) -> Result<SqlitePool, sqlx::Error>;

// 读游标
pub async fn get_list_sync_token(pool, region) -> Result<Option<String>, sqlx::Error>; // calendar_id='__list__'
pub async fn get_calendar_sync_token(pool, region, calendar_id) -> Result<Option<String>, sqlx::Error>;
pub async fn list_active_calendars(pool, region) -> Result<Vec<String>, sqlx::Error>;   // is_deleted=0
```

**`sync.rs` 契约**(核心,签名级):
```rust
/// 拉日历列表:首次 page_token 翻页全量 → 之后带 sync_token 增量。
/// 写 calendar_meta(增/改/删:status=deleted 或列表增量返回的删除项 → is_deleted=1)。
/// 列表 sync_token 推进与 calendar_meta 写入**同一事务**。
/// 返回本轮"活跃日历 id 列表"供下一步逐个拉日程。
pub async fn sync_calendar_list(
    client: &FeishuClient, pool: &SqlitePool, region: Region, token: &str,
) -> Result<Vec<String>, SyncError>;

/// 拉单个日历的日程:sync_token 为空走 page_token 全量,否则带 sync_token 增量。
/// sync_token 与 start_time/end_time 互斥(已锁定):全量首拉用可见时间窗(start/end),
/// 增量只带 sync_token。重复事件让服务端在窗内展开(expand)实例。
///
/// 写入流程(单事务):
///   for each event:
///     map_event() → upsert event_map(ON CONFLICT(region,calendar_id,dedup_key) DO UPDATE local_id 保持)
///                 → upsert calendar_events(按 local_id)
///     若 status==cancelled:软删(见 tombstone 规则)
///   推进 sync_state.sync_token + last_synced_at
///   —— 以上全部在一个 sqlx Transaction 里 commit。
pub async fn sync_one_calendar(
    client: &FeishuClient, pool: &SqlitePool, region: Region, token: &str, calendar_id: &str,
) -> Result<SyncStats, SyncError>;

pub struct SyncStats { pub upserted: usize, pub soft_deleted: usize }
```

> **写库范式锚点**:`mcp/server.rs` 全程用 `sqlx::query(...).bind(...).execute(&self.pool)`(如 create_todo 237-253 行);本片把多条写**包进 `let mut tx = pool.begin().await?; ... tx.commit().await?;`**,这是相对 server.rs 的增量(server.rs 没用事务,因为每个工具是单条写)。token 推进 SQL 与事件 upsert SQL 在同一 `tx` 上执行,保证「token 推进与写库同一事务」(硬要求③)。
>
> **tombstone 防乱序回插(硬要求⑤)**:`event_map` + `calendar_events.status='cancelled'` 即 tombstone。增量乱序场景:先收到 cancelled、后又收到该 event 的旧 confirmed 版本时,**用 `etag`/`updated_at` 比较**——只有当新 event 的版本不旧于已存行才覆盖;cancelled 行保留(软删不删行)。具体规则:upsert 时 `WHERE excluded.updated_at >= calendar_events.updated_at`(或 etag 单调)才更新 status,避免把已 cancelled 的事件被延迟到达的 confirmed 旧版回插。

> **page_token 翻页**:`get_json` 返回里 `page_token`/`has_more` 字段,循环翻到 `has_more=false`;末页响应带新 `sync_token` → 存库。

**验收/测试点**
- **可单测(对 in-memory sqlite,mock client 返回固定 JSON)**:
  - 全量首拉:N 条 event → `calendar_events` N 行、`event_map` N 行、`sync_state.sync_token` 被写。
  - 增量:第二次带 sync_token,新增 1 条 cancelled → 对应行 `status='cancelled'`,行不消失。
  - **事务原子性**:在 upsert 中途注入错误,断言 `sync_token` 未推进(回滚)。
  - **乱序**:先 upsert cancelled(updated_at 新)再喂 confirmed(updated_at 旧)→ 行仍为 cancelled。
  - **去重**:同 dedup_key 来两次 → `event_map` 仍 1 行,`calendar_events` 不重复。
- **集成验证(需凭证,人工)**:真实账号下首拉日历列表 + 至少一个日历日程,DB 出现行;手动在飞书侧删一个日程,再增量同步 → 本地软删。

**依赖**:T1、T3、T5。
**需要真实凭证/人工**:单测不需要(mock client);端到端需真实账号 + 飞书侧操作,标注人工。

---

### T7 — 后台调度 + token 刷新衔接 + notify 刷新 + `feishu_sync_now` command(engine)

**建哪些文件**
- 新建 `src-tauri/src/feishu/engine.rs`。

**改哪些文件**
- `src-tauri/src/lib.rs`:
  - `setup()` 闭包(32-49 行)里,在现有 `spawn(mcp::start(...))`(48 行)旁,追加 `spawn(feishu::engine::run_scheduler(...))`,把 `db_path` + 一个 `notify` 回调传进去。**复用现成 notify 范式**(45-47 行):`Arc::new(move |topic| app.emit("daybreak://data-changed", topic))`——同步写完调 `notify("calendar_events")`。
  - `invoke_handler!`(51-55 行)里追加 `feishu::engine::feishu_sync_now`。
- `src/lib/syncBus.ts`:`SyncTopic` 联合类型(17-23 行)**追加 `"calendar_events"`**。
- `src/App.tsx`:
  - `daybreak://data-changed` 监听(67-80 行)里加分支:`else if (topic === "calendar_events") void useCalendarStore.getState().hydrate();`(`useCalendarStore` 由前端日历片建,我这片只标依赖)。
  - `onSync` 订阅块(84-93 行)同样加一条 `onSync("calendar_events", ...)`。
  > 这两处 App.tsx 改动**严格依赖前端日历片的 `useCalendarStore`**;若该 store 未就绪,可先只接 `daybreak://data-changed`→`emitSync("calendar_events")` 这条链路转发,hydrate 留空。

**`engine.rs` 契约**(签名级):
```rust
/// 后台调度主循环。触发源:
///  - 启动:spawn 后立即跑一次(若已有凭证)
///  - 前台定时:tokio::time::interval(默认 5min,可后续读 settings)
///  - 网络恢复:监听失败后退避重试(简单版:同步失败标记,下个 tick 重试)
///  - 手动:feishu_sync_now command 通过一个 mpsc/Notify 唤醒立即跑
/// 低并发:整个 scheduler 单任务,内部对每个 region 串行、region 内日历串行。
pub async fn run_scheduler(db_path: PathBuf, notify: Notifier);

/// 跑一轮完整同步(两 region 各自):读凭证→sync_calendar_list→逐日历 sync_one_calendar
/// →结束后 notify("calendar_events")。任何单点失败只记 sync_state.last_error,不 panic。
async fn sync_once(pool: &SqlitePool, notify: &Notifier) -> ();

/// Tauri command:前端"立即同步"按钮调。唤醒 scheduler 跑一轮,返回简要结果。
#[tauri::command]
pub async fn feishu_sync_now(app: AppHandle) -> Result<SyncSummary, String>;

pub struct SyncSummary { pub regions: Vec<RegionResult> } // 每 region: 成功/失败 + 计数
```

> **复用锚点**:`Notifier` 类型直接复用 `mcp::Notifier`(`Arc<dyn Fn(&str)+Send+Sync>`,server.rs:29);spawn 范式同 `lib.rs:48` 与 `cli_agent/mod.rs:145`(后台 task + emit 事件)。command 范式同 `cli_agent::cli_agent_send`(mod.rs:136)。
>
> **「新 refresh_token 在写库成功的同一事务里持久化」的落地(硬要求 + 认证片接口边界)**:这条约束有张力——refresh_token 在 keychain(T4),不是 SQLite,无法和 SQLite 事务真正"同一事务"。**落地方式**:`sync_one_calendar` 的事务 `commit()` **成功之后**,engine 才调 `token::save(region,"refresh_token",new)`;若 commit 失败则不更新 token(下次用旧 refresh_token 重试)。即用「commit 后才落 token」近似"同库事务"语义,在注释里写明这是 keychain 与 SQLite 跨存储的折中。**何时刷新**:client 返回 `FeishuError::TokenExpired` 时,engine 调认证片提供的 `refresh()`(边界外)拿新 token 对,再重试本轮。
>
> **manual 唤醒实现**:scheduler 持有一个 `tokio::sync::Notify` 或 `mpsc`,`feishu_sync_now` 通过 Tauri `app.state()` 拿到 handle 触发——或更简单:command 直接 `spawn(sync_once(...))` 跑一次性同步(不经 scheduler),代价是可能与定时 tick 并发 → 用一个 `tokio::sync::Mutex<()>` 串行化「同一时刻只一轮」。**建议后者**(更少状态)。

**验收/测试点**
- 启动 App 后看日志:scheduler 起来、(无凭证时)安静跳过不报错(对齐 mcp::start "失败只记日志"原则,server.rs:617-630 注释)。
- 配好凭证后,定时 tick 触发同步,DB 出现日历事件,前端 `calendar_events` topic 收到刷新(主窗 + 浮窗都 re-hydrate)。
- 点"立即同步"→ `feishu_sync_now` 返回 summary,UI 刷新。
- 并发保护:快速连点"立即同步"+ 定时 tick 撞上,不出现两轮同时写(Mutex 串行)。
- **可单测**:`sync_once` 用 mock client + in-memory db 跑通;并发 Mutex 串行化可写一个"两个 sync_once 并发、断言不交错"的测试。
- notify 调用:同步写完 `notify("calendar_events")` 被调用(用计数回调断言,仿 `mcp::start` 测试传空/计数回调的范式)。

**依赖**:T1、T3、T4、T6;App.tsx 改动额外依赖【前端日历片】的 `useCalendarStore`。
**需要真实凭证/人工**:command/scheduler 骨架与单测不需要;端到端定时同步**需要真实凭证 + 人工浏览器授权**(认证片产出的 token),标注人工。

---

## 任务依赖图(速览)

```
T1(schema, 前端db) ─┐
T2(deps) ────────────┼─→ T3(client) ──┐
                     ├─→ T4(token) ────┤
                     └─→ T5(normalize)─┼─→ T6(sync 核心+事务) ─→ T7(engine+command+notify)
                                       │                              ↑
                                  T1 ──┴──────────────────────────────┘(读写表)
                                                            前端日历片(useCalendarStore)→ App.tsx 两处分支
```

---

## 这片的关键风险(按发生概率 × 严重度排序)

1. **【实现】keychain 与 SQLite 无法真"同一事务",refresh_token 可能与数据写不一致**
   触发:`sync_one_calendar` 的 `tx.commit()` 后、`token::save()` 前进程崩溃 → 数据已落、新 refresh_token 丢失,旧 refresh_token 已被服务端作废(飞书 refresh_token 一次性)→ 下次刷新失败需重新授权。
   影响:用户被迫重新走 OAuth(体验断裂),但不丢数据。
   缓解:commit 后**立即且同步**写 keychain,中间不插任何 await/IO;并在 keychain 里多存「上一个 refresh_token」做一次性回退尝试。这是跨存储的固有张力,无法根除,只能缩小窗口——在注释里对认证片写明。

2. **【实现】全天事件时区零偏移 vs 定时事件时区转换,极易写反导致日期漂移**
   触发:开发者对全天事件也做了 `Utc→Local`,UTC+8 用户看到所有全天事件早一天。
   影响:日历视图大面积日期错位,且只在非 UTC 时区暴露(开发者本地若是 UTC+8 测则一眼看出,UTC 时区测则隐藏)。
   缓解:T5 的单测**强制覆盖 ≥2 个时区**;全天路径单独函数、不复用定时路径的转换代码。

3. **【实现】reqwest 直接依赖的 TLS 特性与 rmcp 间接 reqwest 0.13 特性合并冲突**
   触发:lockfile 里 rmcp 带的 reqwest 没开 TLS,新增直接依赖若选了与 tauri 体系冲突的 backend(如 native-tls 撞系统 OpenSSL),Cargo 特性统一后编译失败或链接报错。
   影响:`cargo build` 直接挂,阻塞整片。
   缓解:T2 选 `rustls-tls`(纯 Rust,不碰系统库),`cargo tree -i reqwest` 验证只有一个版本;若仍冲突,退而把 reqwest 换成复用 rmcp 已带的 hyper 直接发请求(更重,作为 plan B)。

4. **【实现】增量 sync_token 失效(飞书返回特定错误码要求重新全量)未处理 → 增量永久卡死**
   触发:sync_token 过期/失效,飞书返回错误码而非数据,engine 当成普通错误反复重试。
   影响:该日历再也同步不到新事件,静默失败。
   缓解:T6 在 `sync_one_calendar` 捕获"sync_token 失效"错误码 → 清空该日历 sync_state.sync_token、回退到 page_token 全量重拉。这条**需查飞书具体错误码**(端到端验证阶段补,标注需凭证)。

5. **【项目】端到端验证全程卡在「需真实双平台应用 + 人工浏览器授权」**
   触发:T3/T6/T7 的真实 endpoint 行为(分页字段名、429 头名、sync_token 失效码、全天/定时字段结构)只能在拿到 user_access_token 后验证,而 token 依赖认证片 + 用户人工点同意。
   影响:本片所有单测能过,但「字段名拼错、分页漏页」类 bug 要到联调才暴露,可能整片返工字段映射。
   缓解:T3 的 `get_json` 返回原始 `Value`、各调用方自解析,字段名集中在 T5/T6 少数几处常量;先用飞书官方文档的响应样例构造单测 fixture 逼近真实结构;把"需真实凭证验证项"在每个任务里显式列清,联调时一次性扫。

---

## 给开发者的边界备忘

- **不要**在 Rust 端建表(`mcp/db.rs:13` 的 `create_if_missing(false)` 是铁律);schema 只在 `src/lib/db.ts`。
- **不要**沿用 `mcp/connect.rs` 的明文文件存 token;一律走 T4 keychain。
- `scheduled_date`/`scheduled_time` 的格式由 `src/lib/calendar.ts:100` `parseScheduledTime` 钉死,归一产物必须能被它解析。
- notify topic 字符串用 `"calendar_events"`,需同步加进 `src/lib/syncBus.ts:17` 的 `SyncTopic` 与 `App.tsx` 两处监听(67-80、84-93)。
- 后台任务/事件/command 三件套照抄 `cli_agent/mod.rs`(spawn + mpsc + emit + `#[tauri::command]`)与 `lib.rs:48` 的 `Notifier` 范式。

**相关文件绝对路径**(供下游定位):
- 新建:`/Users/apple/Documents/project_management/src-tauri/src/feishu/{mod,client,token,normalize,sync,db,engine}.rs`
- 改:`/Users/apple/Documents/project_management/src-tauri/Cargo.toml`、`/Users/apple/Documents/project_management/src-tauri/src/lib.rs`、`/Users/apple/Documents/project_management/src/lib/db.ts`、`/Users/apple/Documents/project_management/src/lib/syncBus.ts`、`/Users/apple/Documents/project_management/src/App.tsx`
- 只读参考:`/Users/apple/Documents/project_management/src-tauri/src/mcp/{server,db,connect}.rs`、`/Users/apple/Documents/project_management/src-tauri/src/cli_agent/mod.rs`、`/Users/apple/Documents/project_management/src/lib/calendar.ts`、`/Users/apple/Documents/project_management/src/lib/store.ts`(+`goalsStore.ts`)


---

# 片4:UI与双向

I now have everything I need. I've read all the load-bearing files: CalendarPage, SettingsPage, store.ts, calendar.ts, db.ts, syncBus.ts, settings.ts, App.tsx, goalsStore.ts, lib.rs, connect.rs, db.rs (mcp), mod.rs (mcp), server.rs (head), cli_agent/mod.rs, and claude.rs (head). Let me write the implementation plan.

I'll note one thing I'm uncertain about and need to flag: the data layer片 owns the `calendar_events`/`event_map`/`sync_state` table DDL. My plan treats those tables as a dependency from the data片 but specifies the exact columns my UI/writeback code reads, so the contract is explicit.

---

# UI 与双向回写片 — 实施任务清单

## 前置说明:边界与依赖

- **数据层片(下称「数据片」)** 负责:`calendar_events` / `event_map` / `sync_state` 三张表的 DDL 与迁移(在 `src/lib/db.ts` 的 `SCHEMA_V1` + `migrate()` 里加,模式见 db.ts:19-137);`src/lib/calendar.ts` 里飞书时间归一化函数(全天/定时 → `scheduledDate`+`scheduledTime`)。本片**消费**这些,任务里凡需要新列/新函数都给出契约级字段,标注「依赖数据片」。
- **认证/同步引擎片(下称「同步片」)** 负责:OAuth PKCE 流程、token keychain 存取、飞书 HTTP client、增量同步循环、写回 HTTP 调用、etag 冲突判定的 Rust 实现。本片负责**前端状态机、UI、本地变更队列的前端读写、以及触发同步引擎的 Tauri command 契约**。
- 本片自己拥有:`src/pages/CalendarPage.tsx`、`src/pages/SettingsPage.tsx`、新建 `src/lib/calendarEventsStore.ts`、`src/lib/calendarSync.ts`(前端同步状态/触发封装),以及 `src/lib/syncBus.ts` 的 `SyncTopic` 扩展。

一个关键事实需要先确认(写进任务依赖):**日历卡片是独立实体 `calendar_events`,不是 `Todo`**。CalendarPage 当前完全围绕 `useTodoStore` + `todosByDate`(CalendarPage.tsx:81-90)。本片要让日历页**同时**渲染两个数据源(本地 todos + 同步来的 calendar_events),二者在周/月视图叠加显示。

---

## 范围 A:只读 UI

### A1. 定义 `CalendarEvent` 类型 + Row 转换(前端侧契约)

**改/建文件**
- 新建 `src/lib/calendarEventsStore.ts`(顶部导出类型,仿 goalsStore.ts:11 的 `export type` 风格)。
- `src/lib/db.ts`:加 `CalendarEventRow` 接口 + `rowToCalendarEvent()`(仿 `TodoRow`/`rowToTodo` db.ts:148-181)+ CRUD 读函数。

**新增类型/字段(契约级)**
```ts
// calendarEventsStore.ts
export interface CalendarEvent {
  id: string;                 // 本地 id(数据片生成)
  calendarId: string;         // 远端 calendar_id
  remoteEventId: string;      // 远端 event_id(母事件 id)
  title: string;
  scheduledDate: string;      // "YYYY-MM-DD"(归一化后,本地时区)
  scheduledTime?: string;     // "HH:MM-HH:MM";全天事件为空
  isAllDay: boolean;
  calendarName?: string;      // 来源标签显示用
  isWritable: boolean;        // 逐日历探测结果(见 B1)
  status: "confirmed" | "cancelled"; // cancelled = 软删,不渲染
  etag?: string;              // 冲突检测用(见 B4)
  // 重复事件实例去重键(见 A4)
  recurrenceMasterId?: string;   // 母事件 remoteEventId;非重复事件为空
  instanceStartIso?: string;     // 实例原始起始时间(母事件id, 原始起始时间)的后半
  // 本地草稿态(冲突降级,见 B4):有值时该事件是"本地未推送的草稿"
  localDraft?: boolean;
  updatedAt: string;
}
```
- DB 列名(snake_case,**依赖数据片建表**,本片读这些列):`id, calendar_id, remote_event_id, title, scheduled_date, scheduled_time, is_all_day, calendar_name, is_writable, status, etag, recurrence_master_id, instance_start_iso, local_draft, updated_at`。

**新增读函数(db.ts)**
```ts
export async function dbListCalendarEvents(): Promise<CalendarEvent[]>;
// SELECT * FROM calendar_events WHERE status = 'confirmed' ORDER BY scheduled_date
```

**验收/测试点**
- 单测 `rowToCalendarEvent`:`is_all_day=1`→`isAllDay:true`、`status='cancelled'` 的行能被 `dbListCalendarEvents` 过滤掉(WHERE 条件)、`local_draft=1`→`localDraft:true`。可纯函数单测(给 mock row 对象)。

**依赖**:数据片的 `calendar_events` 建表(列名需对齐上表)。

---

### A2. `calendarEventsStore`(新 Zustand store,仿 goalsStore)

**改/建文件**:新建 `src/lib/calendarEventsStore.ts`(整体照搬 goalsStore.ts:18-59 结构)。

**新增契约**
```ts
interface CalendarEventsStore {
  events: CalendarEvent[];
  loaded: boolean;
  hydrate: () => Promise<void>;          // dbListCalendarEvents → set,失败兜底空数组
}
export const useCalendarEventsStore = create<CalendarEventsStore>(...);
```
- `hydrate` 体照搬 goalsStore.ts:31-39 的 try/catch 兜底(出错 set 空 + loaded:true)。
- **注意**:此 store 的写不走前端(同步来的数据由 Rust 写库),所以**没有** add/update/remove。前端只 `hydrate` 重读。本地变更队列的写另起(见 B2),写完也是触发重 hydrate。

**验收/测试点**:与 goalsStore 一致,store 层逻辑薄,不单独写测;由 A5 渲染验收覆盖。

**依赖**:A1。

---

### A3. `SyncTopic` 扩展 + App.tsx 接同步链路

**改/建文件**
- `src/lib/syncBus.ts:17-23`:`SyncTopic` 联合类型加 `"calendar_events"`。
- `src/App.tsx:67-93`:两处接线。

**改动点(契约级)**
- `App.tsx:73-75`(Rust `daybreak://data-changed` 分支):加 `else if (topic === "calendar_events") void useCalendarEventsStore.getState().hydrate();`。这是**同步引擎写库后通知前端刷新**的主链路(同步片的 Rust 同步循环写完 `calendar_events` 后调 `notify("calendar_events")`,复用 server.rs:29 的 `Notifier` 机制)。
- `App.tsx:85-87`(前端 onSync 重 hydrate):加 `const offCal = onSync("calendar_events", () => void useCalendarEventsStore.getState().hydrate());`,并在 cleanup 里 `offCal()`。

**验收/测试点**
- 手动:Rust 端 emit `daybreak://data-changed` payload `"calendar_events"` → 日历页 store 重 hydrate(可在 hydrate 里打 console 验证触发)。
- 这步**不需要**真实凭证(可用一条假数据手动 INSERT + 手动 emit 验证链路通)。

**依赖**:A2。

---

### A4. 重复事件「仅当前可见窗实例」渲染去重

**改/建文件**:`src/pages/CalendarPage.tsx`(新增 `eventsByDate` useMemo,并入周/月渲染)。

**背景**:已锁决策是飞书服务端按可见时间窗展开实例、本地缓存,去重键 `(母事件id, 原始起始时间)` = `(recurrenceMasterId, instanceStartIso)`。所以**库里可能有同一母事件的多条实例**;渲染时按当前视图日期范围过滤即可(每条实例已带自己的 `scheduledDate`)。「去重」的真正含义:同一 `(recurrenceMasterId, instanceStartIso)` 不重复渲染两张卡。

**新增逻辑(契约级)**
```ts
// CalendarPage.tsx,仿 todosByDate (CalendarPage.tsx:81-90)
const eventsByDate = useMemo(() => {
  const map = new Map<string, CalendarEvent[]>();
  const seen = new Set<string>(); // 去重键 `${recurrenceMasterId ?? id}|${instanceStartIso ?? ''}`
  for (const ev of events) {
    const key = `${ev.recurrenceMasterId ?? ev.id}|${ev.instanceStartIso ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = map.get(ev.scheduledDate) ?? [];
    list.push(ev);
    map.set(ev.scheduledDate, list);
  }
  return map;
}, [events]);
```
- `events` 来自 `useCalendarEventsStore((s) => s.events)`。
- 周/月视图只渲染落在当前 `days`/`matrix` 范围内的日期 key(天然由 Map.get(dateKey) 实现,见 CalendarPage.tsx:393、549),所以「仅当前可见窗实例」= 当前周/月的那些 dateKey。

**验收/测试点**
- 单测可抽出一个纯函数 `dedupeEventsByDate(events): Map<string, CalendarEvent[]>`(把上面 useMemo 体提成独立函数放 `src/lib/calendar.ts` 或新建 `src/lib/calendarEvents.ts`),给两条同 `(masterId, instanceStartIso)` 的事件 → 输出只含一条。**这条建议单测**。
- 手动:同一周重复会(每天 9:00 站会)→ 每天一张卡,不重叠不重复。

**依赖**:A2。

---

### A5. CalendarPage 渲染日程卡片(只读 vs 可写视觉区分 + 来源标签)

**改/建文件**:`src/pages/CalendarPage.tsx`。

**改动点**
1. **数据接入**:`const events = useCalendarEventsStore((s) => s.events);`(加在 CalendarPage.tsx:69 附近),加 A4 的 `eventsByDate`。
2. **周视图**:`WeekView`/`DayColumn`(CalendarPage.tsx:449-633)新增一个 prop `eventsByDate`,在 `DayColumn` 的任务卡渲染段(CalendarPage.tsx:613-630)**之后**追加一段渲染 calendar_events 卡片。复用 `parseScheduledTime`(calendar.ts:100)算 top/height(全天事件单独处理,见下)。
3. **月视图**:`MonthView`(CalendarPage.tsx:359-445)的圆点区(CalendarPage.tsx:419-438)叠加 event 圆点(不同颜色,见下)。
4. **新增只读事件卡组件** `CalendarEventBlock`(仿 `DraggableTaskBlock` CalendarPage.tsx:635-685,但**不可拖拽**,不用 `useDraggable`):
   - 只读事件(`isWritable=false`):卡片样式用「中性灰 + 虚线左边框 + 锁图标」,与 todos 的 priority 实心色卡(CalendarPage.tsx:766-778)明显区分。
   - 可写事件(`isWritable=true`):实线左边框 + 来源色(建议统一蓝/青色系,区别于 todos 的 indigo/red/amber)。
   - **来源标签**:卡片顶部小字显示 `calendarName`(如「张三的日历」「团队日程」),用 `text-[9px]` 弱化。
   - **全天事件**:不参与时间轴定位,渲染成顶部一条「全天 chip」。建议 `DayColumn` 顶部加一个 all-day 行(`isAllDay` 的事件聚到这)。

**新增组件签名(契约级)**
```ts
function CalendarEventBlock({ event, top, height }: {
  event: CalendarEvent; top: number; height: number;
}): JSX.Element;

function eventCardCls(ev: CalendarEvent): string; // 仿 priorityCardCls,按 isWritable 分两种样式
```

**i18n**:新增文案 key(给 `t()`):`calendar.source`(来源标签前缀)、`calendar.readonly`(只读 tooltip)、`calendar.allDay`(全天)。文案本身交 i18n 资源文件(本片只占位 key,资源补充可标「依赖 i18n 资源」,但 zh/en 两份建议本片顺手加)。

**验收/测试点**
- 手动(可用假数据,**不需要凭证**):向 `calendar_events` 手动 INSERT 几条(可写1条/只读1条/全天1条/重复2条),日历页:
  - 只读卡有锁标 + 灰虚线,不可拖。
  - 可写卡蓝色实线。
  - 全天卡在顶部 all-day 行。
  - 来源标签显示 `calendarName`。
  - todos 卡片样式不受影响(回归)。
- 拖拽回归:确认 calendar_events 卡片**不**触发 `handleDragEnd`(CalendarPage.tsx:134),不会误改 todo。

**依赖**:A2、A4。

---

### A6. SettingsPage「连接飞书/Lark」区块

**改/建文件**:`src/pages/SettingsPage.tsx`(新增一个 `<Section>` + 子组件 `FeishuConnectSection`,插在 MCP 区块 SettingsPage.tsx:130-137 之后)。

**仿照范式**:`McpAccessSection`(SettingsPage.tsx:326-380,`useEffect` 里 `invoke("mcp_connection_info")` + err/loading 三态)+ `ChatBackendField`(SettingsPage.tsx:736-811,`invoke` 检测 + 状态文案)。

**UI 要素(对应任务书 ②)**
- region 选择:`SegmentControl<"feishu"|"lark">`(SettingsPage.tsx:223 现成组件)。
- `app_id` / `app_secret` 输入:密文显示可切显,**完整照搬** `ProviderKeyEditor`(SettingsPage.tsx:518-598)的 input + Eye/EyeOff 切换。
- 连接按钮:触发 OAuth(见 A7 状态机 + 同步片的 command)。
- 断开按钮:清 keychain 凭证/token(调同步片 command)。
- 同步状态 / 上次同步时间 / 错误:从 `sync_state` 表读(见下)。
- 手动同步按钮:调同步片的 `feishu_sync_now` command。

**新增前端封装(契约级)** — 新建 `src/lib/calendarSync.ts`,封装对同步片 Tauri command 的调用 + 前端读 sync_state:
```ts
export type FeishuRegion = "feishu" | "lark";

// 连接状态(前端 UI 状态机用,见 A7)
export type FeishuConnState =
  | "disconnected" | "authorizing" | "connected" | "error";

export interface FeishuConnectionInfo {  // 从同步片 command 拿
  connected: boolean;
  region?: FeishuRegion;
  lastSyncAt?: string;     // ISO
  syncStatus?: "idle" | "syncing" | "error";
  errorMessage?: string;
}

// 以下均为对同步片 Tauri command 的薄封装(invoke),签名是本片与同步片的契约:
export async function feishuGetConnectionInfo(): Promise<FeishuConnectionInfo>; // invoke("feishu_connection_info")
export async function feishuConnect(p: {                                        // invoke("feishu_connect")
  region: FeishuRegion; appId: string; appSecret: string;
}): Promise<void>;        // 内部启动 OAuth(开浏览器 + 起 localhost 监听捕获 code),完成后写 keychain + 触发首次同步
export async function feishuDisconnect(): Promise<void>;                         // invoke("feishu_disconnect")
export async function feishuSyncNow(): Promise<void>;                            // invoke("feishu_sync_now")
```
- `sync_state` 表读取:可由同步片在 `feishu_connection_info` 里聚合返回(推荐,前端不直连 sync_state 表,避免与 Rust 写竞争);**依赖同步片** command 实现。

**新增 Tauri command 契约(同步片实现,本片调用)**
| command | 入参 | 出参 | 说明 |
|---|---|---|---|
| `feishu_connection_info` | — | `FeishuConnectionInfo` | 聚合 keychain 是否有 token + sync_state 表 |
| `feishu_connect` | `{region, appId, appSecret}` | `()` 或 err | 跑 OAuth PKCE,**会开浏览器、需人工同意** |
| `feishu_disconnect` | — | `()` | 清 keychain + sync_state |
| `feishu_sync_now` | — | `()` | 触发一次增量同步 |

**验收/测试点**
- UI 渲染:断开态显示 region 选择 + 两个输入 + 连接按钮;连接态显示来源、上次同步、错误、断开/手动同步按钮。
- region 切换、密文切显、输入 onBlur 暂存(注意:**app_secret 不落 localStorage**,与现有 ProviderKeyEditor 不同——见风险点)。
- 端到端连接验证:**需用户提供真实飞书/Lark 自建应用的 app_id/app_secret + 人工在浏览器点同意**(硬约束)。本片可先用「同步片提供的 mock command」验证 UI 三态流转。

**依赖**:A7(状态机)、同步片(4 个 command)。**标注:连接成功路径需真实凭证 + 人工浏览器操作。**

---

### A7. 三条交互路径的前端状态机

**改/建文件**:`src/lib/calendarSync.ts`(状态定义 + 一个轻量 Zustand store 持有 UI 态)或直接在组件内 `useState` + 轮询。建议新建 `useFeishuSyncStore`(仿 settings store 的精简版)。

**三条路径(任务书 ③)**

1. **首次接入**:`disconnected` →(用户填凭证点连接)→ `authorizing`(按钮转圈、禁用、提示「请在浏览器完成授权」)→ 成功 `connected`(触发首次全量同步,状态显示「同步中」)/ 失败 `error`(显示 errorMessage,可重试)。
   - 监听同步片 emit 的事件确认授权完成(契约:同步片 emit `feishu://auth-done` payload `{ok:boolean, error?:string}`,或直接靠 `feishu_connect` command 的 resolve/reject——**二选一,推荐 command resolve/reject 更简单**,但 OAuth 是异步开浏览器,command 需 await 整个 localhost 回调,所以**更稳的是事件**)。**这是与同步片要敲定的接口点**(见风险点)。

2. **后台同步**:`connected` 态下,前端**不主动驱动**同步循环(循环在 Rust 同步片跑:启动/前台定时/网络恢复触发)。前端只:
   - 监听 `daybreak://data-changed` topic `calendar_events`(A3 已接)→ 重 hydrate 日历页。
   - 轮询/监听 `sync_state` 变化更新「同步中/上次同步时间/错误」UI(契约:同步片在每次同步开始/结束 emit `feishu://sync-state` 或前端定时 `feishu_connection_info` 轮询。推荐**事件**,避免轮询)。

3. **编辑(写回)**:用户在日历页改一条可写事件 → 乐观更新本地 `calendar_events`(标 `localDraft` 或入队)→ 入本地变更队列(B2)→ 触发写回(B3)。UI 即时反馈:卡片显示「同步中」小标,成功后清标,冲突则降级草稿 + 提示(B4)。

**新增契约(状态机 store)**
```ts
interface FeishuSyncStore {
  connState: FeishuConnState;
  info: FeishuConnectionInfo | null;
  refresh: () => Promise<void>;               // 调 feishuGetConnectionInfo 刷新
  startConnect: (p: {region; appId; appSecret}) => Promise<void>; // 进 authorizing,调 feishuConnect,监听结果
  disconnect: () => Promise<void>;
  syncNow: () => Promise<void>;
}
```

**验收/测试点**
- 状态机可单测(把状态转移抽成纯 reducer:`(state, event) => nextState`,event = `CONNECT_START|AUTH_OK|AUTH_FAIL|SYNC_START|SYNC_DONE|SYNC_ERROR|DISCONNECT`)。**建议单测这个 reducer**,覆盖非法转移(如 disconnected 收到 SYNC_DONE 应忽略)。
- 手动:连接→授权中→连接成功 三态 UI 切换(用 mock command)。

**依赖**:A6。**标注:授权完成事件的接口形态需与同步片敲定;真实流转需凭证+人工。**

---

## 范围 B:双向

### B1. 逐日历 `is_writable` 探测(前端消费)

**说明**:探测逻辑(日历 `type` ∈ {primary, shared} 且 `role` ∈ {writer, owner})在**同步片**拉日历列表时完成,把结果写进 `calendar_events.is_writable`(或更规范:写进数据片的「日历表」,再 join 到事件)。本片**只读** `event.isWritable` 决定卡片可否进入编辑/写回(A5 已用其分样式,B3 用其 gate 写回)。

**本片改动**:无独立改动,A5/A1 已覆盖字段。

**验收/测试点**:A5 的「只读卡不可拖、可写卡可编辑」即覆盖。

**依赖**:同步片(探测 + 写 `is_writable`)、数据片(列)。**本片仅消费,标注「依赖同步片」。**

---

### B2. 本地变更队列(前端读写 + 表结构协调)

**改/建文件**
- 表结构:`calendar_change_queue` 表,**DDL 归数据片**(在 db.ts SCHEMA_V1 加),本片给契约字段。
- `src/lib/db.ts`:加该表的 CRUD 读写函数(本片写,因为入队是前端编辑触发的)。
- 新建 `src/lib/calendarQueue.ts`:入队/查询封装。

**表字段(契约级,依赖数据片建表)**
```
calendar_change_queue (
  id            TEXT PRIMARY KEY,         -- 队列项 id
  op            TEXT NOT NULL,            -- 'create' | 'update' | 'delete'
  local_id      TEXT NOT NULL,            -- calendar_events.id
  calendar_id   TEXT NOT NULL,
  remote_event_id TEXT,                   -- update/delete 必填;create 为空
  payload_json  TEXT NOT NULL,            -- 变更后的事件字段(create/update 用)
  base_etag     TEXT,                     -- 入队时本地持有的 etag(冲突检测基线,见 B4)
  state         TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'sending'|'done'|'conflict'|'failed'
  retry_count   INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
)
```

**新增函数(db.ts / calendarQueue.ts,本片实现)**
```ts
export interface ChangeQueueItem { /* 上表字段的 camelCase 镜像 */ }
export async function dbEnqueueChange(item: ChangeQueueItem): Promise<void>;
export async function dbListPendingChanges(): Promise<ChangeQueueItem[]>; // state in ('pending','failed')
export async function dbUpdateChangeState(id: string, state: string, lastError?: string, retryCount?: number): Promise<void>;
export async function dbDeleteChange(id: string): Promise<void>;
// calendarQueue.ts:高层封装
export async function enqueueEventEdit(ev: CalendarEvent, op: "create"|"update"|"delete"): Promise<void>; // 组 payload + base_etag + emitSync
```

**关键决策**:入队由**前端**写(用户编辑动作在前端);**重放/写回执行**由谁跑要敲定——两种:
- (推荐)**前端驱动重放**:前端 enqueue 后立刻调同步片的 `feishu_flush_queue` command 让 Rust 读队列逐条写回(Rust 持有 token/HTTP)。优点:token 在 Rust,HTTP 在 Rust,职责清晰。
- (备选)Rust 后台轮询队列:更解耦但更复杂。

→ 采用推荐方案:**前端写队列 + 触发,Rust 读队列执行写回**。队列表是前后端共享(都用 sqlx/plugin-sql 连同库,WAL 并发安全,见 db.rs:13-24)。

**验收/测试点**
- 单测 `enqueueEventEdit` 组 payload 的逻辑(纯函数:给一个 CalendarEvent + op → 期望的 ChangeQueueItem 形状,含 base_etag 取自 ev.etag)。**建议单测**。
- 手动:编辑一条可写事件 → 队列表出现一条 `pending` 记录(可用 sqlite 命令行查)。

**依赖**:数据片(建 `calendar_change_queue` 表)、A1。

---

### B3. 写回 create / PATCH / DELETE(前端触发 + Rust 执行契约)

**改/建文件**
- `src/pages/CalendarPage.tsx`:让可写事件卡支持编辑入口(拖拽改时段 / 删除 / 新建)。但**重复事件只支持改单次**(B6),首版可先只做「拖拽改时段」+「删除」两个 op,create 留给后续(或仅本地新建后写回)。
- `src/lib/calendarSync.ts`:`feishuFlushQueue()` 封装。

**新增 Tauri command 契约(同步片实现)**
| command | 入参 | 出参 | 说明 |
|---|---|---|---|
| `feishu_flush_queue` | — | `FlushResult` | Rust 读 `calendar_change_queue` 的 pending,逐条 create(POST)/update(PATCH)/delete(DELETE)写回;每条带 `base_etag` 做冲突判定(B4);写回成功更新 `calendar_events` + 置队列项 done;冲突置 conflict |

```ts
export interface FlushResult {
  pushed: number; conflicted: number; failed: number;
}
export async function feishuFlushQueue(): Promise<FlushResult>; // invoke("feishu_flush_queue")
```

**前端写回触发流程**
1. 用户拖动可写事件卡改时段(需让 `CalendarEventBlock` 在 `isWritable` 时也可拖,复用 `useDraggable`;`handleDragEnd` CalendarPage.tsx:134 要区分 active id 是 todo 还是 event,建议 event 卡 id 加前缀 `event-`)。
2. drop 后:乐观更新本地 `calendar_events`(改 scheduledDate/Time,标 localDraft)→ `enqueueEventEdit(ev, "update")` → `feishuFlushQueue()` → 成功重 hydrate / 冲突走 B4。

**验收/测试点**
- 手动(**需真实凭证 + 可写日历**):拖动一条可写事件 → 飞书端该日程时间被改;删除 → 飞书端消失。
- 无凭证可测部分:乐观更新 + 入队 + 队列状态流转(用 mock 的 `feishu_flush_queue` 返回 done)。
- 回归:只读事件卡拖不动(不入队)。

**依赖**:B2、A5;**写回真实生效需真实凭证 + 可写日历(人工)**;Rust 写回实现属同步片。

---

### B4. etag 三态冲突 + 默认远端为准 + 冲突保留本地草稿

**说明**:三态判定(仅远端变→覆盖本地;仅本地变→推送;两边都变→冲突)的**核心比较在 Rust 同步片**(它持有远端 etag 与本地 base_etag)。本片负责**冲突的前端表现**:

**改/建文件**:`src/pages/CalendarPage.tsx` + `src/lib/calendarEventsStore.ts`。

**冲突的前端契约**
- 当 `feishu_flush_queue` 判定某条为冲突:Rust 把 `calendar_change_queue` 该项置 `state='conflict'`,并在 `calendar_events` 里**保留两份**:远端版(覆盖主记录,`local_draft=0`)+ 本地草稿版(`local_draft=1`,可新插一行或标记)。**这条数据形态要与同步片敲定**(推荐:主记录用远端,草稿单独一行 `local_draft=1`)。
- 前端:草稿事件卡(`localDraft=true`)用**橙色「冲突/草稿」样式 + badge**,点击给「保留我的 / 用远端」二选一(保留我的→重新入队 update;用远端→删本地草稿行)。

**新增 UI**
```ts
function ConflictBadge(...): JSX.Element;          // 草稿卡上的冲突标
// 冲突处理:复用 ConfirmDialog (SettingsPage.tsx:26 useConfirm 范式) 或内联按钮
async function resolveConflict(draft: CalendarEvent, choice: "keepLocal"|"useRemote"): Promise<void>;
```

**验收/测试点**
- 单测:冲突状态下 `eventsByDate` 会**同时**列出远端版与草稿版(去重键不同,因 `instanceStartIso` 或加一个 `local_draft` 维度)——确认去重不会把草稿吃掉。**建议单测 dedupe 函数对 localDraft 的处理**。
- 手动(需真实凭证制造冲突:本地改 + 远端同时改同一事件):出现草稿卡 + 冲突 badge;选「用远端」后草稿消失;选「保留我的」后重新推送。

**依赖**:B3;**真实冲突复现需凭证 + 两端并发改(人工)**;判定逻辑属同步片。

---

### B5. 离线入队 / 联网重放

**改/建文件**:`src/lib/calendarSync.ts`(网络状态监听 + 重放触发)。

**新增逻辑**
- 离线:`enqueueEventEdit` 写库本就不依赖网络(SQLite 本地),`feishuFlushQueue` 失败时 Rust 把队列项置 `failed` + last_error,不丢。
- 联网重放触发:监听网络恢复 → 调 `feishuFlushQueue()`。
  - 网络恢复信号:浏览器 `window.addEventListener("online", ...)`(WebView 支持)或同步片的网络恢复事件。前端用 `online` 事件最简单。
  - 同步片的同步循环本身也在「网络恢复」触发(任务书已锁),所以重放可由同步片统一驱动;**前端的 online 监听作为冗余触发**即可。

**验收/测试点**
- 手动:断网编辑可写事件 → 队列 `pending/failed`;恢复网络 → 自动 `feishuFlushQueue` → 队列清空(需凭证才能真写回,但「断网时入队不丢」可无凭证验证)。

**依赖**:B2、B3。

---

### B6. 重复事件仅「改单次」

**改/建文件**:`src/pages/CalendarPage.tsx`(编辑入口 gate)+ `src/lib/calendarQueue.ts`(payload 组装)。

**说明**:已锁决策「双向先只支持改单次」。前端:
- 当用户编辑的事件 `recurrenceMasterId` 非空(是重复实例):写回 payload 要带「仅此实例」标识(飞书 PATCH 单个实例的语义,具体字段由同步片按飞书 API 填,如对实例 event_id 而非母事件操作)。前端在 `enqueueEventEdit` 里透传 `recurrenceMasterId` + `instanceStartIso`,**让同步片决定如何调飞书 API 改单次**。
- UI:编辑重复事件时,提示「仅修改此次日程」(不提供「修改整个系列」,避免误操作整条 RRULE)。

**新增契约**:`enqueueEventEdit` 的 payload_json 对重复实例额外带 `{ recurrenceMasterId, instanceStartIso, scope: "single" }`。

**验收/测试点**
- 单测:重复实例入队时 payload 带 `scope:"single"` + 母事件信息。**建议单测**。
- 手动(需凭证):改重复会的某一天 → 只那天变,其余实例不变。

**依赖**:B2、A4;**真实生效需凭证(人工)**;飞书「改单次」API 调用属同步片。

---

## 任务依赖拓扑(便于排期)

```
数据片建表(calendar_events / event_map / sync_state / calendar_change_queue) ──┐
                                                                              │
A1(类型+Row)──A2(store)──A3(SyncTopic+App接线)                                  │
                  │                                                            │
                  ├──A4(去重)──A5(只读渲染)                                      │(A5 可纯假数据验收,不需凭证)
                  │                                                            │
                  └──A6(Settings区块)──A7(状态机)                               │(需同步片 command;连接需凭证)
                                                                              │
B1(is_writable 消费,随 A1/A5) 
B2(变更队列前端读写)──B3(写回触发)──B4(冲突表现)
                          └──B5(离线重放)
                          └──B6(改单次)
```

**无需凭证即可独立完成并验收**:A1-A5、B2(入队部分)、A4/B2/B6 的单测。
**需同步片 command(可先用 mock)**:A6、A7、B3、B5。
**需真实飞书/Lark 凭证 + 人工浏览器操作**:A6 连接成功路径、B3 真实写回、B4 真实冲突、B6 真实改单次端到端。

---

## 风险点(前 6 个,按「发生概率 × 严重度」排序)

**1. 日历卡与 Todo 卡共用一套拖拽上下文,容易串味 [类型:实现]**
- 触发:`handleDragEnd`(CalendarPage.tsx:134)目前只认 `day-*` droppable + `unscheduled-` 前缀,active id 直接当 todo id 处理(CalendarPage.tsx:141-143)。若 event 卡也用 `useDraggable` 而 id 不加前缀,拖 event 会被当 todo 改,污染 `useTodoStore`。
- 影响:用户拖飞书日程,结果改了本地待办的时间;数据错乱且难察觉。
- 缓解:event 卡 id 强制加 `event-` 前缀;`handleDragEnd` 开头先按前缀分流(todo / event / unscheduled 三路),event 路单独走 `enqueueEventEdit`。**A5/B3 必须一起改这个函数,不能只加渲染不改拖拽分流。**

**2. OAuth 授权完成的「异步回调 → 前端状态机」接口形态没定死 [类型:项目/实现]**
- 触发:`feishu_connect` 要开浏览器、起 localhost 监听等 code 回调,整个过程秒级到分钟级(人工点同意)。若用 command 的 await resolve 表达完成,command 会长时间挂起;若用事件表达,前端要正确监听 + 超时。两片对此理解不一致就会接不上。
- 影响:连接 UI 卡在「授权中」永不前进,或重复触发。
- 缓解:**本片与同步片在 A7 前先敲定**:推荐同步片 emit `feishu://auth-done {ok,error}` + 前端设超时(如 3min 无事件→error)。把这条写进两片共享的接口约定,别各写各的。

**3. app_secret 落地方式:UI 范式默认会塞 localStorage,与「凭证一律进 keychain」决策冲突 [类型:实现/安全]**
- 触发:A6 照搬 `ProviderKeyEditor`(SettingsPage.tsx:518-598),而该组件 onBlur 调 `settings.setProviderConfig` → 写 localStorage(settings.ts:142 明文)。若照搬不改,app_secret 会明文落 localStorage。
- 影响:违反已锁的 keychain 决策;敏感凭证明文留盘。
- 缓解:A6 的输入**不接 settings store**;app_id/app_secret 仅作为组件本地 state,点「连接」时直接 `invoke("feishu_connect", {appId, appSecret})` 交给 Rust 存 keychain。前端不持久化 secret(顶多 app_id 可缓存非敏感)。

**4. 冲突时「保留两份」的数据形态影响去重逻辑 [类型:实现]**
- 触发:B4 草稿版与远端版可能共享 `(recurrenceMasterId, instanceStartIso)`,A4 的去重键会把草稿吃掉(只剩一张卡),用户看不到冲突。
- 影响:冲突静默丢失,用户以为远端覆盖成功,本地改动凭空消失。
- 缓解:去重键在 B4 落地前就预留 `local_draft` 维度(键改为 `${master}|${instanceStart}|${localDraft?'d':'r'}`);dedupe 函数单测必须覆盖「同事件远端版+草稿版都保留」。

**5. 前端写队列 + Rust 读队列,并发写同一 SQLite 表的时序 [类型:实现]**
- 触发:前端 `enqueueChange` 刚 INSERT,立刻 `feishu_flush_queue` 让 Rust 读;若前端 INSERT 的事务还没 commit 到 WAL,Rust 池可能读不到。WAL 下跨连接可见性有延迟窗口。
- 影响:刚入队的变更第一次 flush 漏掉,要等下次同步才推。
- 缓解:`enqueueChange` 用 `await` 确保 plugin-sql 那条 execute 完成(已 commit)再 invoke flush;Rust flush 前可加一次短 busy_timeout 重读。db.rs:18 已设 5s busy_timeout,基本够;但要在 A 验收时观察一次「入队即 flush」是否漏。

**6. 「全天事件」与「定时事件」混在同一 DayColumn 的定位冲突 [类型:体验]**
- 触发:全天事件没有 `scheduledTime`,`parseScheduledTime` 返回 null(calendar.ts:100),若沿用 todos 的「parse 失败就丢进 unscheduled sidebar」逻辑(CalendarPage.tsx:485-493),全天日程会跑去未排期侧栏,语义错误。
- 影响:全天会议显示在「未排期」里,用户困惑。
- 缓解:A5 明确分流:event 的全天判定走 `isAllDay` 字段(不靠 parse 失败),渲染到 DayColumn 顶部 all-day 行;不要把 event 喂给 `UnscheduledSidebar`(那个只服务 todos)。

---

## 关键文件锚点速查(供下游直接定位)

- 日历渲染主体:`src/pages/CalendarPage.tsx` — `todosByDate`(81-90)、`handleDragEnd` 分流(134-186)、`WeekView`/`DayColumn`(449-633)、`DraggableTaskBlock`(635-685)、`MonthView` 圆点(419-438)、`priorityCardCls`(766-778)。
- 乐观更新范式:`src/lib/store.ts` — `applySchedules`(204-230,先落 db→再 set→emitSync)。
- store 范式:`src/lib/goalsStore.ts`(整文件,18-59)。
- DB Row 转换 + CRUD 范式:`src/lib/db.ts` — `TodoRow`/`rowToTodo`(148-181)、`dbUpdateTodoSchedule`(241-251)、`migrate()`(120-137)、`SCHEMA_V1`(19-106)。
- 同步总线:`src/lib/syncBus.ts` — `SyncTopic`(17-23)、`emitSync`/`onSync`(32-61)。
- App 接线:`src/App.tsx` — Rust data-changed 监听(67-80)、前端 onSync 重 hydrate(84-93)。
- Settings 范式:`src/pages/SettingsPage.tsx` — `McpAccessSection`(326-380,invoke 三态)、`ProviderKeyEditor`(518-598,密文输入)、`ChatBackendField`(736-811,检测+状态文案)、`SegmentControl`(223-251)、`Section`/`Field`(164-216)、`useConfirm`(26)。
- 设置持久化(反例,secret 不要走这):`src/lib/settings.ts:142`。
- Tauri command 注册:`src-tauri/src/lib.rs:51-55`(`invoke_handler` 数组,同步片新 command 在此加)。
- Rust 写库后通知前端:`src-tauri/src/mcp/server.rs:29`(`Notifier` 类型)、`src-tauri/src/lib.rs:45-47`(notify 闭包 emit `daybreak://data-changed`)。
- Rust sqlx 连同库:`src-tauri/src/mcp/db.rs:13-24`(WAL + busy_timeout + create_if_missing(false))。
- 后台任务 + 事件流范式(OAuth/同步循环参考):`src-tauri/src/cli_agent/mod.rs:136-155`(command spawn + mpsc + emit)、`src-tauri/src/cli_agent/claude.rs:76+`。
- keychain 反例(token 明文 txt,新功能改用 keyring crate):`src-tauri/src/mcp/connect.rs:11-23`。
- Cargo 依赖(需新增 `keyring`;`reqwest` 当前仅经 rmcp 间接,同步片直连飞书需显式加):`src-tauri/Cargo.toml:15-39`。
