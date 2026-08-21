# Tauri Shell

Latitude 的 Tauri 2 桌面壳。两个窗口:

- `main` — 主 App,1100×740,可调整大小,带原生标题栏
- `floating` — 浮窗,260×420,无边框 / 常驻置顶 / **默认隐藏**,由主 App Sidebar 左下角"打开浮窗"按钮拉出;浮窗顶部自带一个隐藏按钮(`hide()`,不 close),关掉后再打开走的是同一个窗口实例

## Plugins

- `tauri-plugin-sql` (sqlite) — 前端通过 `@tauri-apps/plugin-sql` 直接调 SQLite。Schema 初始化在前端 `src/lib/db.ts`(`IF NOT EXISTS` + `PRAGMA` 自检列),Rust 端不写迁移
- `tauri-plugin-single-instance` — 防双开。第二次启动时把焦点切回已有 `main` 窗口,避免两个进程同时写同一个 SQLite 文件触发 BUSY

跨窗口数据同步走前端的 `BroadcastChannel`(`src/lib/syncBus.ts`),**不走 Tauri 事件** —— 同 origin 多窗口浏览器原生支持,不需要 capability、也不要 Rust 端代码。

## Capabilities

`capabilities/default.json` 同时挂在 `main` 和 `floating` 两个窗口上,带 `core:default`(常用 webview/window 控制,含 `show`/`hide`/`setFocus`)+ `sql:*`(读写 SQLite)。

## 跑

需 Rust 工具链(rustc/cargo)。从项目根:

```bash
npm run tauri:dev    # 开发,自动起 vite + 编译 Rust 壳
npm run tauri:build  # 打包,产物在 src-tauri/target/release/bundle/{macos,dmg}/
```
