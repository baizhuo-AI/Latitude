# Tauri Shell

Latitude 的 Tauri 2 桌面壳。**四个窗口**(以 `tauri.conf.json` 为准):

| label | 尺寸 | 说明 |
|---|---|---|
| `main` | 1100×740 | 主 App,可调整大小,带原生标题栏 |
| `chatbar` | 560 宽 | 对话悬浮条,全局快捷键唤起;与桌面底部对话条共享同一会话 |
| `todo` | 280 宽 | 待办悬浮窗。**新架构中已决定砍掉**（内容并入主桌面的行动职能），见[工程实施计划](../docs/plans/2026-08-20-dimension-implementation-plan.md) §1 |
| `launcher` | 48 宽 | 启动器 |

> 早期版本的 `floating`(260×420)窗口已不存在,被 `chatbar` / `todo` 取代。

## Plugins

- `tauri-plugin-sql` (sqlite) — 前端通过 `@tauri-apps/plugin-sql` 直接调 SQLite。Schema 初始化在前端 `src/lib/db.ts`(`IF NOT EXISTS` + `PRAGMA` 自检列),Rust 端不写迁移
- `tauri-plugin-single-instance` — 防双开。第二次启动时把焦点切回已有 `main` 窗口,避免两个进程同时写同一个 SQLite 文件触发 BUSY

跨窗口数据同步走 **Tauri 事件**(`src/lib/syncBus.ts` 的 `emit`/`listen`)。

> 历史踩坑:早期用 `BroadcastChannel`,以为"同 origin 多窗口浏览器原生支持"就够了 —— 实际上 Tauri 的多窗口不共享 BroadcastChannel 上下文,浮窗与主窗从未真正同步过。现已改为 Tauri event,需要 capability 授权(见下)。

## Capabilities

`capabilities/default.json` 挂在全部四个窗口(`main` / `chatbar` / `todo` / `launcher`)上,带 `core:default`(常用 webview/window 控制,含 `show`/`hide`/`setFocus`/`close`)+ `sql:*`(读写 SQLite)+ 事件收发权限(跨窗口同步依赖)。

## 跑

需 Rust 工具链(rustc/cargo)。从项目根:

```bash
npm run tauri:dev    # 开发,自动起 vite + 编译 Rust 壳
npm run tauri:build  # 打包,产物在 src-tauri/target/release/bundle/{macos,dmg}/
```
