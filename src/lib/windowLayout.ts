/**
 * 多窗口编排:窗口角色判定 + 打开/聚焦悬浮窗 + 对话条展开/收起的窗口尺寸调整。
 *
 * 三个窗口:main(工作台)/ chatbar(对话悬浮条)/ todo(todo 悬浮窗)。
 * 角色用 URL hash 判定(同步、test-safe);操作窗口的函数一律动态 import @tauri-apps/api,
 * 无 Tauri runtime(jsdom 单测 / Ladle)时安静失败。
 */

export const CHATBAR_HASH = "#/__chatbar__";
export const TODO_HASH = "#/__todo__";
export const LAUNCHER_HASH = "#/__launcher__";
export const WIN_MAIN = "main";
export const WIN_CHATBAR = "chatbar";
export const WIN_TODO = "todo";
export const WIN_LAUNCHER = "launcher";

export type WindowRole = "main" | "chatbar" | "todo" | "launcher";

/** 当前窗口角色。main 的路由 hash 永远不会以 #/__chatbar__ / #/__todo__ / #/__launcher__ 开头,故稳定。 */
export function windowRole(): WindowRole {
  if (typeof window === "undefined") return "main";
  const h = window.location.hash;
  if (h.startsWith(CHATBAR_HASH)) return "chatbar";
  if (h.startsWith(TODO_HASH)) return "todo";
  if (h.startsWith(LAUNCHER_HASH)) return "launcher";
  return "main";
}

// 对话条尺寸(逻辑像素):收起只剩输入条,展开向上长出会话面板,底边固定不动。
export const CHATBAR_W = 560;
export const CHATBAR_BAR_H = 72;
export const CHATBAR_PANEL_H = 480;

async function showWindow(label: string): Promise<void> {
  try {
    const mod = await import("@tauri-apps/api/webviewWindow");
    const win = await mod.WebviewWindow.getByLabel(label);
    if (win) {
      await win.show();
      await win.setFocus();
    }
  } catch (err) {
    console.error(`[windowLayout] show ${label} failed:`, err);
  }
}

/** 工作台窗调用:打开/聚焦对话悬浮条。 */
export function openChatBar(): Promise<void> {
  return showWindow(WIN_CHATBAR);
}

/** 工作台窗 / 提醒调度调用:打开/聚焦 todo 悬浮窗。 */
export function openTodoFloat(): Promise<void> {
  return showWindow(WIN_TODO);
}

/**
 * 切换对话条显隐:可见则收起,隐藏则打开并聚焦。
 * 复用 Rust 的 toggle_chatbar 命令——与全局快捷键、托盘菜单走同一条路径,
 * 保证桌面侧栏按钮与其它入口对窗口状态的认知一致(避免各管一份本地 flag 漂移)。
 */
export async function toggleChatBar(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("toggle_chatbar");
  } catch (err) {
    console.error("[windowLayout] toggle chatbar failed:", err);
  }
}

/** 切换 todo 悬浮窗显隐:可见则收起,隐藏则打开并聚焦(复用 Rust toggle_todo,与快捷键/托盘同路径)。 */
export async function toggleTodoFloat(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("toggle_todo");
  } catch (err) {
    console.error("[windowLayout] toggle todo failed:", err);
  }
}

/**
 * 查询某悬浮窗当前是否可见(label 取 WIN_CHATBAR / WIN_TODO)。
 * 无 Tauri runtime(jsdom 单测 / Ladle)时返回 false,安静降级——
 * 此时侧栏按钮一律显示「打开」,点击走 toggle 仍安全。
 */
export async function isFloaterVisible(label: string): Promise<boolean> {
  try {
    const mod = await import("@tauri-apps/api/webviewWindow");
    const win = await mod.WebviewWindow.getByLabel(label);
    return win ? await win.isVisible() : false;
  } catch {
    return false;
  }
}

/** 隐藏「当前窗口」。悬浮窗的关闭按钮用 hide 而非 close,保住 label 下次再 show。 */
export async function hideCurrentWindow(): Promise<void> {
  try {
    const mod = await import("@tauri-apps/api/webviewWindow");
    await mod.getCurrentWebviewWindow().hide();
  } catch (err) {
    console.error("[windowLayout] hide current failed:", err);
  }
}

/**
 * 对话条展开/收起:改「当前窗口」高度,底边固定(向上长高 / 向下缩回)。
 * 收起 = 只剩输入条;展开 = 长出会话面板。只在对话条窗口里调。
 * 读当前实际位置/尺寸来算,重复调也不会算错(幂等)。
 */
export async function setChatBarExpanded(expanded: boolean): Promise<void> {
  try {
    const winmod = await import("@tauri-apps/api/webviewWindow");
    const dpi = await import("@tauri-apps/api/dpi");
    const win = winmod.getCurrentWebviewWindow();
    const factor = await win.scaleFactor();
    const pos = (await win.outerPosition()).toLogical(factor);
    const size = (await win.outerSize()).toLogical(factor);
    const targetH = expanded ? CHATBAR_PANEL_H : CHATBAR_BAR_H;
    // 底边固定:新 top = 当前 top -(目标高 - 当前高)
    const newY = Math.max(0, Math.round(pos.y - (targetH - size.height)));
    await win.setSize(new dpi.LogicalSize(CHATBAR_W, targetH));
    await win.setPosition(new dpi.LogicalPosition(Math.round(pos.x), newY));
  } catch (err) {
    console.error("[windowLayout] setChatBarExpanded failed:", err);
  }
}
