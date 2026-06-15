import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { feishuSyncNow } from "../lib/calendarSync";
import { useCalendarEventsStore } from "../lib/calendarEventsStore";
import { toast } from "../lib/toast";
import { cn } from "../lib/utils";

interface RegionStatus {
  connected: boolean;
}
interface StatusInfo {
  feishu: RegionStatus;
  lark: RegionStatus;
}

/**
 * 飞书 / Lark「立即同步」按钮 — 给日历页头部用(设置页另有完整的连接/同步面板,这里只是个快捷入口)。
 *
 * 只在飞书或 Lark 任一已连接时才显示(没连接谈不上同步)。点击 → 跑一轮手动同步 + 重新 hydrate 事件,
 * 结果用 toast 反馈。状态(上次同步时间等)仍只在设置页看,这里保持轻量。
 */
export function FeishuSyncButton({ className }: { className?: string }) {
  const { t } = useTranslation();
  const [connected, setConnected] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const hydrate = useCalendarEventsStore((s) => s.hydrate);

  useEffect(() => {
    void (async () => {
      try {
        const s = await invoke<StatusInfo>("feishu_status");
        setConnected(Boolean(s.feishu?.connected || s.lark?.connected));
      } catch {
        setConnected(false);
      }
    })();
  }, []);

  if (!connected) return null;

  async function sync() {
    if (syncing) return;
    setSyncing(true);
    try {
      const summary = await feishuSyncNow();
      await hydrate();
      const err = summary.regions.find((r) => r.error)?.error;
      if (err) {
        toast.error(t("calendar.syncFailed", { msg: err }));
      } else {
        const up = summary.regions.reduce((n, r) => n + (r.upserted ?? 0), 0);
        const del = summary.regions.reduce((n, r) => n + (r.deleted ?? 0), 0);
        toast.success(t("calendar.synced", { up, del }));
      }
    } catch (e) {
      console.error("[calendar] feishu sync failed:", e);
      toast.error(t("calendar.syncFailed", { msg: String(e) }));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void sync()}
      disabled={syncing}
      title={t("calendar.syncFeishu")}
      className={cn(
        "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors",
        "text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-800",
        "hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100",
        "disabled:opacity-60 disabled:cursor-not-allowed",
        className
      )}
    >
      {syncing ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : (
        <RefreshCw className="w-3.5 h-3.5" />
      )}
      <span>{syncing ? t("calendar.syncing") : t("calendar.syncFeishu")}</span>
    </button>
  );
}
