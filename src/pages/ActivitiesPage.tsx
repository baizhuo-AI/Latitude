import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Clock, Trash2 } from "lucide-react";
import { useActivityStore, type ActivityRecord } from "../lib/activityStore";
import { cn } from "../lib/utils";
import { toast } from "../lib/toast";

/**
 * 活动时间线页面 — 按天分组展示所有活动记录,最近的在上面。
 * 数据来自 activityStore(SQLite activity_log 表),跨窗口同步。
 */

const PAGE_SIZE = 200;

function dateKeyOf(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  } catch {
    return "unknown";
  }
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function fmtDateHeading(key: string, t: (k: string) => string): string {
  const today = new Date();
  const todayKey = dateKeyOf(today.toISOString());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayKey = dateKeyOf(yesterday.toISOString());

  if (key === todayKey) return t("briefing.todayPlan").replace("方案", "").trim() || "Today";
  if (key === yesterdayKey) return "Yesterday";

  try {
    const d = new Date(key + "T00:00:00");
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      weekday: "short",
    });
  } catch {
    return key;
  }
}

type GroupedActivities = { dateKey: string; items: ActivityRecord[] }[];

function groupByDate(activities: ActivityRecord[]): GroupedActivities {
  const map = new Map<string, ActivityRecord[]>();
  for (const a of activities) {
    const key = dateKeyOf(a.createdAt);
    const arr = map.get(key);
    if (arr) arr.push(a);
    else map.set(key, [a]);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => (a > b ? -1 : a < b ? 1 : 0))
    .map(([dateKey, items]) => ({ dateKey, items }));
}

export function ActivitiesPage() {
  const { t } = useTranslation();
  const activities = useActivityStore((s) => s.activities);
  const loaded = useActivityStore((s) => s.loaded);
  const removeActivity = useActivityStore((s) => s.removeActivity);
  const hydrateActivities = useActivityStore((s) => s.hydrate);

  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  useEffect(() => {
    if (!loaded) void hydrateActivities();
  }, [loaded, hydrateActivities]);

  const visible = activities.slice(0, visibleCount);
  const hasMore = activities.length > visibleCount;
  const grouped = groupByDate(visible);

  async function handleDelete(id: string) {
    try {
      await removeActivity(id);
      toast.success(t("activities.deleted"));
    } catch {
      toast.error("Delete failed");
    }
  }

  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center text-text-faint text-sm">
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <div className="mb-6 flex items-center gap-2">
        <Clock className="h-5 w-5 text-text-muted" />
        <h1 className="text-lg font-semibold text-text">{t("activities.title")}</h1>
        <span className="ml-auto text-xs text-text-faint">
          {activities.length} {activities.length === 1 ? "record" : "records"}
        </span>
      </div>

      {grouped.length === 0 ? (
        <div className="rounded-lg border border-border/50 bg-bg-elevated px-6 py-16 text-center text-sm text-text-faint">
          {t("activities.empty")}
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map((group) => (
            <section key={group.dateKey}>
              <div className="sticky top-0 z-10 mb-2 flex items-center gap-2 bg-bg pb-1 pt-1">
                <span className="text-xs font-semibold uppercase tracking-wider text-text-faint">
                  {fmtDateHeading(group.dateKey, t)}
                </span>
                <div className="h-px flex-1 bg-border/50" />
                <span className="text-[10px] text-text-faint">{group.items.length}</span>
              </div>
              <div className="space-y-0.5">
                {group.items.map((a) => (
                  <div
                    key={a.id}
                    className={cn(
                      "group flex items-start gap-3 rounded-lg px-3 py-2 transition-colors",
                      "hover:bg-bg-muted"
                    )}
                  >
                    <span className="mt-0.5 flex-shrink-0 font-mono text-xs text-text-faint">
                      {fmtTime(a.createdAt)}
                    </span>
                    <span className="min-w-0 flex-1 text-sm leading-relaxed text-text">
                      {a.content}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleDelete(a.id)}
                      className="mt-0.5 flex-shrink-0 rounded p-1 text-text-faint opacity-0 transition-opacity hover:bg-bg-muted hover:text-red-500 group-hover:opacity-100"
                      title={t("activities.deleteConfirm")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ))}

          {hasMore && (
            <button
              type="button"
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              className="w-full rounded-lg border border-border/50 py-2 text-center text-xs font-medium text-text-muted transition-colors hover:bg-bg-muted"
            >
              {t("activities.loadMore")}
            </button>
          )}

          {!hasMore && activities.length > 0 && (
            <div className="py-2 text-center text-[11px] text-text-faint">
              {t("activities.noMore")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
