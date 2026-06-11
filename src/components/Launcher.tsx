import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as RPointerEvent
} from "react";
import { Plus, Sparkles, ListTodo, LayoutDashboard } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { cn } from "../lib/utils";

const COLLAPSED_H = 48; // 逻辑 px:只剩主钮
const EXPANDED_H = 192; // 逻辑 px:主钮 + 3 个动作钮(各 40 + 间距/内边距)
const CLICK_SLOP = 4; // 逻辑 px:移动小于此值算"点击"而非"拖动"

type Action = "main" | "chatbar" | "todo" | "workbench";

interface DragState {
  startX: number;
  startY: number;
  winX: number;
  winY: number;
  sf: number;
  moved: boolean;
}

/**
 * 桌面悬浮按钮 launcher — 一个常驻置顶的圆钮(FAB):
 *  - 轻点主钮 → 向上扇出 3 个动作钮:💬 对话条 / ✓ 待办 / ▦ 工作台。
 *  - 点动作钮 → 各自开/收(对话条、待办 toggle;工作台是把主窗唤到前台),然后收起。
 *  - 再点主钮 → 收起。按住任意钮拖动 = 移动整个 launcher。
 * 展开/收起时改窗口高度(底边固定,主钮位置不动);收起先改 state 再缩窗、展开先长窗再改 state,
 * 避免内容溢出被窗口裁切。Tauri API 动态拿,无 runtime 时安静失败。
 */
export function Launcher() {
  const [expanded, setExpanded] = useState(false);
  const expandedRef = useRef(false);
  expandedRef.current = expanded;
  const drag = useRef<DragState | null>(null);

  useEffect(() => {
    const html = document.documentElement;
    html.classList.add("is-floating");
    return () => html.classList.remove("is-floating");
  }, []);

  /** 改窗口高度,底边固定(主钮不动)。collapse 先改 state 再缩,expand 先长再改 state。 */
  async function applyExpand(next: boolean) {
    if (!next) setExpanded(false);
    try {
      const win = getCurrentWebviewWindow();
      const sf = await win.scaleFactor();
      const pos = await win.outerPosition();
      const size = await win.outerSize();
      const newH = Math.round((next ? EXPANDED_H : COLLAPSED_H) * sf);
      const bottom = pos.y + size.height;
      await win.setSize(new PhysicalSize(size.width, newH));
      await win.setPosition(new PhysicalPosition(pos.x, bottom - newH));
    } catch (err) {
      console.error("[launcher] expand:", err);
    }
    if (next) setExpanded(true);
  }

  async function handlePointerDown(e: RPointerEvent<HTMLButtonElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    try {
      const win = getCurrentWebviewWindow();
      const sf = await win.scaleFactor();
      const pos = await win.outerPosition();
      drag.current = {
        startX: e.screenX * sf,
        startY: e.screenY * sf,
        winX: pos.x,
        winY: pos.y,
        sf,
        moved: false
      };
    } catch (err) {
      console.error("[launcher] pointerdown:", err);
    }
  }

  async function handlePointerMove(e: RPointerEvent<HTMLButtonElement>) {
    const d = drag.current;
    if (!d) return;
    const dx = e.screenX * d.sf - d.startX;
    const dy = e.screenY * d.sf - d.startY;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < CLICK_SLOP * d.sf) return;
    d.moved = true;
    try {
      await getCurrentWebviewWindow().setPosition(
        new PhysicalPosition(Math.round(d.winX + dx), Math.round(d.winY + dy))
      );
    } catch (err) {
      console.error("[launcher] pointermove:", err);
    }
  }

  async function handlePointerUp(e: RPointerEvent<HTMLButtonElement>, action: Action) {
    const d = drag.current;
    drag.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 指针可能已释放,忽略 */
    }
    if (!d || d.moved) return; // 拖动结束,不触发动作
    if (action === "main") {
      await applyExpand(!expandedRef.current);
      return;
    }
    const cmd =
      action === "chatbar"
        ? "toggle_chatbar"
        : action === "todo"
          ? "toggle_todo"
          : "show_main";
    void invoke(cmd).catch((err) => console.error("[launcher] action:", err));
    await applyExpand(false);
  }

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-end gap-2 p-1">
      {expanded && (
        <>
          <FanButton
            title="工作台"
            icon={<LayoutDashboard className="h-4 w-4" />}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={(e) => void handlePointerUp(e, "workbench")}
          />
          <FanButton
            title="待办"
            icon={<ListTodo className="h-4 w-4" />}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={(e) => void handlePointerUp(e, "todo")}
          />
          <FanButton
            title="对话条"
            icon={<Sparkles className="h-4 w-4" />}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={(e) => void handlePointerUp(e, "chatbar")}
          />
        </>
      )}
      <button
        type="button"
        onPointerDown={(e) => void handlePointerDown(e)}
        onPointerMove={(e) => void handlePointerMove(e)}
        onPointerUp={(e) => void handlePointerUp(e, "main")}
        title="Daybreak"
        aria-label="Daybreak"
        className="flex h-10 w-10 flex-shrink-0 touch-none select-none items-center justify-center rounded-full bg-accent text-white transition-transform active:scale-95"
      >
        <Plus className={cn("h-5 w-5 transition-transform", expanded && "rotate-45")} />
      </button>
    </div>
  );
}

function FanButton({
  title,
  icon,
  onPointerDown,
  onPointerMove,
  onPointerUp
}: {
  title: string;
  icon: ReactNode;
  onPointerDown: (e: RPointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (e: RPointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (e: RPointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      onPointerDown={(e) => void onPointerDown(e)}
      onPointerMove={(e) => void onPointerMove(e)}
      onPointerUp={onPointerUp}
      title={title}
      aria-label={title}
      className="flex h-10 w-10 flex-shrink-0 touch-none select-none items-center justify-center rounded-full border border-border/70 bg-bg-elevated text-text-muted transition-colors hover:text-accent active:scale-95"
    >
      {icon}
    </button>
  );
}
