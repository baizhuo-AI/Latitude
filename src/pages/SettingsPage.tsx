import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Eye,
  EyeOff,
  Languages,
  Palette,
  KeyRound,
  Database,
  RotateCcw,
  Download,
  Upload,
  Trash2,
  Plug,
  Command,
  ListFilter,
  PanelLeft,
  BellRing,
  AlertTriangle,
  CheckCircle2,
  ShieldCheck
} from "lucide-react";
import {
  useSettingsStore,
  type Lang,
  type ProviderName,
  type ChatBackend,
  type ShortcutsConfig
} from "../lib/settings";
import { evaluateModelTier } from "../lib/llm/modelTier";
import { invoke } from "@tauri-apps/api/core";
import { useThemeStore, type ThemeMode } from "../lib/theme";
import { cn } from "../lib/utils";
import { useConfirm } from "../components/ConfirmDialog";
import { deleteAllTodos, downloadExport, importFromJson } from "../lib/dataIO";
import { toast } from "../lib/toast";
import { dbUsageSummary } from "../lib/db";
import { CustomFieldsManager } from "../components/CustomFieldsManager";
import { ProactiveSettings } from "../components/secretary/ProactiveSettings";
import { PrivacySettings } from "../components/privacy/PrivacySettings";
import { Section, Field, SegmentControl } from "../components/settings/SettingsPrimitives";
import { SIDEBAR_NAV_ITEMS } from "../components/Sidebar";

/**
 * Settings 页 — App 偏好的全部入口
 *
 * 4 个 section:
 *  1. 外观:语言 + 主题
 *  2. LLM:provider 切换 + 各家 API key 输入(密文显示,可切显)
 *  3. 用量:(留位,等 P3 接 llm_usage 表)
 *  4. 数据:重置设置 + 清空数据库
 */
export function SettingsPage() {
  const { t } = useTranslation();
  const settings = useSettingsStore();
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();

  useLayoutEffect(() => {
    const target = searchParams.get("scrollTo");
    if (target) {
      requestAnimationFrame(() => {
        document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  return (
    <div className="h-full flex flex-col">
      <header className="h-14 px-6 flex items-center border-b border-zinc-200 dark:border-zinc-800 flex-shrink-0">
        <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          {t("settings.title")}
        </h1>
      </header>

      <div className="flex-1 overflow-auto scrollbar-thin">
        <div className="max-w-2xl mx-auto px-6 py-8 space-y-8">
          {/* 外观 */}
          <Section
            icon={<Palette className="w-4 h-4" />}
            title={t("settings.appearance.title")}
          >
            <Field label={t("settings.appearance.lang")}>
              <SegmentControl<Lang>
                value={settings.lang}
                onChange={settings.setLang}
                options={[
                  { value: "zh", label: "中文" },
                  { value: "en", label: "English" }
                ]}
              />
            </Field>
            <Field label={t("settings.appearance.theme")}>
              <SegmentControl<ThemeMode>
                value={themeMode}
                onChange={setThemeMode}
                options={[
                  { value: "light", label: t("settings.appearance.themeLight") },
                  { value: "dark", label: t("settings.appearance.themeDark") },
                  {
                    value: "system",
                    label: t("settings.appearance.themeSystem")
                  }
                ]}
              />
            </Field>
          </Section>

          {/* 定时提醒已并入下方「主动提醒」面板的「活动记录」子项(定时×主动全合 M4)——
              工作时段 / 别烦我 / 间隔 / 策略档统一在那里设,这里不再单列定时提醒区。 */}

          {/* 侧栏管理(需求 4)*/}
          <div id="sidebar-manager">
          <Section
            icon={<PanelLeft className="w-4 h-4" />}
            title={t("settings.sidebar.title")}
            description={t("settings.sidebar.description")}
          >
            <SidebarManager />
          </Section>
          </div>

          {/* 快捷键 */}
          <Section
            icon={<Command className="w-4 h-4" />}
            title={t("settings.shortcuts.title")}
            description={t("settings.shortcuts.description")}
          >
            <ShortcutsSettings />
          </Section>

          {/* LLM */}
          <Section
            icon={<KeyRound className="w-4 h-4" />}
            title={t("settings.llm.title")}
            description={t("settings.llm.description")}
          >
            <Field label={t("settings.llm.provider")}>
              <SegmentControl<ProviderName>
                value={settings.llmProvider}
                onChange={settings.setProvider}
                options={[
                  { value: "deepseek", label: "DeepSeek" },
                  { value: "anthropic", label: "Claude" },
                  { value: "openai", label: "OpenAI" },
                  { value: "mock", label: t("settings.llm.providerMock") }
                ]}
              />
            </Field>

            {settings.llmProvider !== "mock" && (
              <ProviderKeyEditor provider={settings.llmProvider} />
            )}
          </Section>

          {/* AI 秘书主动提醒(Task 3.4) */}
          <div id="proactive-panel">
          <Section
            icon={<BellRing className="w-4 h-4" />}
            title={t("proactive.sectionTitle")}
            description={t("proactive.sectionDesc")}
          >
            <ProactiveSettings />
          </Section>
          </div>

          {/* 隐私与成本(Task 4.6a) */}
          <div id="privacy-panel">
          <Section
            icon={<ShieldCheck className="w-4 h-4" />}
            title={t("privacy.sectionTitle")}
            description={t("privacy.sectionDesc")}
          >
            <PrivacySettings />
          </Section>
          </div>

          {/* 对话后端切换：DeepSeek API / 三家本地 CLI */}
          <Section
            title="对话后端"
            description="选 DeepSeek API 直连或本地 CLI（claude/codex/kiro）"
            icon={<Plug className="w-4 h-4" />}
          >
            <ChatBackendField />
          </Section>

          {/* 自定义字段 */}
          <div id="custom-fields">
          <Section
            icon={<ListFilter className="w-4 h-4" />}
            title={t("customFields.title")}
            description={t("customFields.description")}
          >
            <CustomFieldsManager />
          </Section>
          </div>

          {/* 用量 */}
          <Section
            icon={<Languages className="w-4 h-4 rotate-180" />}
            title={t("settings.usage.title")}
            description={t("settings.usage.description")}
          >
            <UsagePanel />
          </Section>

          {/* 数据 */}
          <Section
            icon={<Database className="w-4 h-4" />}
            title={t("settings.data.title")}
            description={t("settings.data.description")}
          >
            <DataActions confirm={confirm} settingsReset={settings.reset} />
          </Section>
        </div>
      </div>
    </div>
  );
}

/* ---------- 子组件 ---------- */

function UsagePanel() {
  const { t } = useTranslation();
  const [stats, setStats] = useState<{
    totalCalls: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
  } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const s = await dbUsageSummary();
        setStats(s);
      } catch (err) {
        console.error("[Settings] usage summary failed:", err);
      }
    })();
  }, []);

  if (!stats) {
    return (
      <p className="text-sm text-zinc-400 dark:text-zinc-500">
        {t("common.loading")}
      </p>
    );
  }

  // DeepSeek 价格估算(deepseek-chat ¥0.001/1K input + ¥0.002/1K output,粗算)
  const costInput = (stats.totalPromptTokens / 1000) * 0.001;
  const costOutput = (stats.totalCompletionTokens / 1000) * 0.002;
  const cost = (costInput + costOutput).toFixed(3);

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <UsageStat label={t("settings.usage.calls")} value={String(stats.totalCalls)} />
      <UsageStat label={t("settings.usage.promptTokens")} value={fmtNum(stats.totalPromptTokens)} />
      <UsageStat
        label={t("settings.usage.completionTokens")}
        value={fmtNum(stats.totalCompletionTokens)}
      />
      <UsageStat label={t("settings.usage.estCost")} value={`¥${cost}`} />
    </div>
  );
}

function UsageStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg p-3 bg-zinc-50 dark:bg-zinc-950/60 border border-zinc-200 dark:border-zinc-800">
      <div className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500 dark:text-zinc-400">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
        {value}
      </div>
    </div>
  );
}

function fmtNum(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function SidebarManager() {
  const { t } = useTranslation();
  const sidebarHidden = useSettingsStore((s) => s.sidebarHidden);
  const setSidebarHidden = useSettingsStore((s) => s.setSidebarHidden);

  const visibleCount = SIDEBAR_NAV_ITEMS.filter((i) => !sidebarHidden.includes(i.key)).length;

  // 显示=从隐藏列表移除;隐藏=加入列表,但至少保留一项(关到最后一个时拦下并提示)。
  function setShown(key: string, show: boolean) {
    if (show) {
      setSidebarHidden(sidebarHidden.filter((k) => k !== key));
      return;
    }
    if (visibleCount <= 1) {
      toast.error(t("settings.sidebar.atLeastOne"));
      return;
    }
    if (!sidebarHidden.includes(key)) {
      setSidebarHidden([...sidebarHidden, key]);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
        {t("settings.sidebar.hint")}
      </p>
      <div className="space-y-1">
        {SIDEBAR_NAV_ITEMS.map((item) => {
          const shown = !sidebarHidden.includes(item.key);
          return (
            <div key={item.key} className="flex items-center justify-between gap-4 py-1">
              <div className="flex items-center gap-2.5 text-sm text-zinc-700 dark:text-zinc-300">
                <item.icon className="w-4 h-4 text-zinc-400 dark:text-zinc-500" />
                <span>{t(`nav.${item.key}`)}</span>
              </div>
              <SegmentControl<"show" | "hide">
                value={shown ? "show" : "hide"}
                onChange={(v) => setShown(item.key, v === "show")}
                options={[
                  { value: "show", label: t("settings.sidebar.show") },
                  { value: "hide", label: t("settings.sidebar.hide") }
                ]}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DataActions({
  confirm,
  settingsReset
}: {
  confirm: (opts: {
    title: string;
    message: string;
    destructive?: boolean;
    confirmLabel?: string;
  }) => Promise<boolean>;
  settingsReset: () => void;
}) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleExport() {
    try {
      const result = await downloadExport();
      toast.success(
        t("settings.data.exportDone", {
          filename: result.filename,
          kb: (result.size / 1024).toFixed(1)
        })
      );
    } catch (err) {
      console.error(err);
      toast.error("导出失败,详情见 console");
    }
  }

  function handleImportClick() {
    fileInputRef.current?.click();
  }

  async function handleImportFile(file: File) {
    try {
      const text = await file.text();
      const summary = await importFromJson(text);
      toast.success(
        t("settings.data.importDone", {
          todos: summary.todosImported,
          goals: summary.goalsImported,
          skipped: summary.todosSkipped + summary.goalsSkipped
        })
      );
    } catch (err) {
      console.error(err);
      toast.error(`导入失败:${(err as Error).message}`);
    }
  }

  async function handleClearTodos() {
    const ok = await confirm({
      title: t("settings.data.clearTodos"),
      message: t("settings.data.clearTodosConfirm"),
      destructive: true,
      confirmLabel: t("settings.data.clearTodos")
    });
    if (!ok) return;
    const n = await deleteAllTodos();
    toast.success(t("settings.data.clearTodosDone", { count: n }));
  }

  async function handleResetSettings() {
    const ok = await confirm({
      title: t("settings.data.resetSettings"),
      message: t("settings.data.resetSettingsConfirm"),
      destructive: true
    });
    if (ok) {
      settingsReset();
      toast.success(t("settings.data.resetDone"));
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      <DataButton icon={<Download className="w-3.5 h-3.5" />} onClick={() => void handleExport()}>
        {t("settings.data.export")}
      </DataButton>
      <DataButton icon={<Upload className="w-3.5 h-3.5" />} onClick={handleImportClick}>
        {t("settings.data.import")}
      </DataButton>
      <DataButton icon={<RotateCcw className="w-3.5 h-3.5" />} onClick={() => void handleResetSettings()}>
        {t("settings.data.resetSettings")}
      </DataButton>
      <DataButton
        icon={<Trash2 className="w-3.5 h-3.5" />}
        onClick={() => void handleClearTodos()}
        destructive
      >
        {t("settings.data.clearTodos")}
      </DataButton>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleImportFile(file);
          e.target.value = ""; // 允许再次选同一文件
        }}
      />
    </div>
  );
}

function DataButton({
  icon,
  onClick,
  destructive,
  children
}: {
  icon: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors",
        destructive
          ? "text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/50 hover:bg-red-50 dark:hover:bg-red-950/40"
          : "text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900 hover:text-zinc-900 dark:hover:text-zinc-100"
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function ProviderKeyEditor({
  provider
}: {
  provider: Exclude<ProviderName, "mock">;
}) {
  const { t } = useTranslation();
  const settings = useSettingsStore();
  const cfg = settings.providers[provider];
  const [showKey, setShowKey] = useState(false);
  const [draft, setDraft] = useState(cfg.apiKey ?? "");
  const [model, setModel] = useState(cfg.model ?? "");

  function commit() {
    settings.setProviderConfig(provider, {
      apiKey: draft.trim() || undefined,
      model: model.trim() || undefined
    });
  }

  const placeholderKey =
    provider === "deepseek"
      ? "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      : provider === "anthropic"
        ? "sk-ant-xxxxxxxx"
        : "sk-proj-xxxxxxxx";

  return (
    <>
      <Field label={t("settings.llm.apiKey")}>
        <div className="flex items-center gap-2">
          <div className="relative">
            <input
              type={showKey ? "text" : "password"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              placeholder={placeholderKey}
              className={cn(
                "w-72 px-3 py-1.5 pr-9 rounded-lg text-sm outline-none transition-colors font-mono",
                "bg-zinc-50 dark:bg-zinc-950",
                "border border-zinc-200 dark:border-zinc-700",
                "focus:border-indigo-500",
                "text-zinc-900 dark:text-zinc-100",
                "placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
              )}
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? "hide" : "show"}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
            >
              {showKey ? (
                <EyeOff className="w-3.5 h-3.5" />
              ) : (
                <Eye className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>
      </Field>
      <Field label={t("settings.llm.model")}>
        <div className="flex flex-col gap-1.5">
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            onBlur={commit}
            placeholder={cfg.model ?? ""}
            className={cn(
              "w-72 px-3 py-1.5 rounded-lg text-sm outline-none transition-colors font-mono",
              "bg-zinc-50 dark:bg-zinc-950",
              "border border-zinc-200 dark:border-zinc-700",
              "focus:border-indigo-500",
              "text-zinc-900 dark:text-zinc-100",
              "placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
            )}
          />
          {/* 推荐档位标注 + 低于推荐档时的软性引导(R3 弱模型地板)。
              判定走纯函数 evaluateModelTier;实时随输入变化,unknown 不打扰。 */}
          <ModelTierHint provider={provider} model={model} />
        </div>
      </Field>
    </>
  );
}

/**
 * 推荐档位提示(Task 3.6)。
 * 三态(纯函数 evaluateModelTier 判定):
 *   - recommended:绿色「已是推荐档」+ 始终显示推荐档名,正反馈。
 *   - below      :橙色软性提示「低于推荐档,建议用 X」,引导但不拦截。
 *   - unknown    :只显示推荐档名(灰),不报警——温和姿态,不误判用户挂的新/强/代理模型。
 */
function ModelTierHint({
  provider,
  model
}: {
  provider: Exclude<ProviderName, "mock">;
  model: string;
}) {
  const { t } = useTranslation();
  const verdict = evaluateModelTier(provider, model);

  if (verdict.status === "below") {
    return (
      <div className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400 max-w-72 leading-relaxed">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>{t("settings.llm.tierBelow", { model: verdict.recommendedModel })}</span>
      </div>
    );
  }

  if (verdict.status === "recommended") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
        <span>{t("settings.llm.tierOk")}</span>
      </div>
    );
  }

  // unknown:不报警,仅给出推荐档名供参考(灰)
  return (
    <span className="text-xs text-zinc-400 dark:text-zinc-500">
      {t("settings.llm.recommendedTier", { model: verdict.recommendedModel })}
    </span>
  );
}

/* ---------- 全局快捷键 ---------- */

/** 键盘事件 → Tauri accelerator(用 e.code 当主键名,与 Rust global-shortcut 的 Code 名一致)。 */
function eventToAccelerator(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.metaKey) mods.push("Super");
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  const code = e.code;
  // 纯修饰键:还没按主键,继续等
  if (!code || /^(Meta|Control|Alt|Shift|OS)(Left|Right)?$/.test(code)) return null;
  if (mods.length === 0) return null; // 至少一个修饰键,避免误触发全局键
  return [...mods, code].join("+");
}

/** accelerator → 给人看的符号串("Alt+KeyK" → "⌥ K")。 */
function prettyAccelerator(accel: string): string {
  if (!accel) return "";
  return accel
    .split("+")
    .map((part) => {
      switch (part) {
        case "Super":
          return "⌘";
        case "Control":
          return "⌃";
        case "Alt":
          return "⌥";
        case "Shift":
          return "⇧";
        case "ArrowUp":
          return "↑";
        case "ArrowDown":
          return "↓";
        case "ArrowLeft":
          return "←";
        case "ArrowRight":
          return "→";
        default:
          if (part.startsWith("Key")) return part.slice(3);
          if (part.startsWith("Digit")) return part.slice(5);
          return part;
      }
    })
    .join(" ");
}

function ShortcutRecorder({
  value,
  onChange
}: {
  value: string;
  onChange: (accel: string) => void;
}) {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;
    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const accel = eventToAccelerator(e);
      if (!accel) return; // 等一个「修饰键 + 主键」的有效组合
      onChange(accel);
      setRecording(false);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, onChange]);

  return (
    <div className="flex items-center gap-2">
      <kbd className="inline-flex min-w-[72px] justify-center px-2 py-1 rounded-md text-xs font-medium bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200">
        {recording
          ? t("settings.shortcuts.recording")
          : value
            ? prettyAccelerator(value)
            : t("settings.shortcuts.unset")}
      </kbd>
      <button
        type="button"
        onClick={() => setRecording((v) => !v)}
        className="px-2.5 py-1 rounded-md text-xs font-medium text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-500/10 hover:bg-indigo-100 dark:hover:bg-indigo-500/20 transition-colors"
      >
        {recording ? t("settings.shortcuts.cancel") : t("settings.shortcuts.record")}
      </button>
      {value && !recording && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="px-2 py-1 rounded-md text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors"
        >
          {t("settings.shortcuts.clear")}
        </button>
      )}
    </div>
  );
}

function ShortcutsSettings() {
  const { t } = useTranslation();
  const shortcuts = useSettingsStore((s) => s.shortcuts);
  const setShortcut = useSettingsStore((s) => s.setShortcut);

  async function apply(patch: Partial<ShortcutsConfig>) {
    setShortcut(patch);
    const s = useSettingsStore.getState().shortcuts;
    try {
      await invoke("set_global_shortcuts", {
        chatbar: s.toggleChatbar,
        todo: s.toggleTodo,
        workbench: s.showWorkbench
      });
      const anySet = s.toggleChatbar || s.toggleTodo || s.showWorkbench;
      toast.success(anySet ? t("settings.shortcuts.saved") : t("settings.shortcuts.disabled"));
    } catch (e) {
      console.error("[Settings] set_global_shortcuts failed:", e);
      toast.error(t("settings.shortcuts.failed"));
    }
  }

  return (
    <div className="space-y-4">
      <Field label={t("settings.shortcuts.toggleChatbar")}>
        <ShortcutRecorder
          value={shortcuts.toggleChatbar}
          onChange={(a) => void apply({ toggleChatbar: a })}
        />
      </Field>
      <Field label={t("settings.shortcuts.toggleTodo")}>
        <ShortcutRecorder
          value={shortcuts.toggleTodo}
          onChange={(a) => void apply({ toggleTodo: a })}
        />
      </Field>
      <Field label={t("settings.shortcuts.showWorkbench")}>
        <ShortcutRecorder
          value={shortcuts.showWorkbench}
          onChange={(a) => void apply({ showWorkbench: a })}
        />
      </Field>
    </div>
  );
}

/* ---------- 对话后端切换 + CLI 安装检测 ---------- */

function ChatBackendField() {
  const settings = useSettingsStore();
  const [detection, setDetection] = useState<Record<string, boolean | null>>({
    claude: null,
    codex: null,
    kiro: null,
  });

  useEffect(() => {
    let mounted = true;
    const detect = async (kind: "claude" | "codex" | "kiro") => {
      try {
        const ok = await invoke<boolean>("cli_agent_detect", { kind });
        if (mounted) setDetection((d) => ({ ...d, [kind]: ok }));
      } catch {
        if (mounted) setDetection((d) => ({ ...d, [kind]: false }));
      }
    };
    void detect("claude");
    void detect("codex");
    void detect("kiro");
    return () => {
      mounted = false;
    };
  }, []);

  // 当前选中后端的状态文案：装没装 / 是否还需登录 / MCP 怎么配
  const statusText = (() => {
    const b = settings.chatBackend;
    if (b === "deepseek-api") {
      return "✓ 用 DeepSeek API 直连，按 token 付费（已极便宜）。在上方「LLM」配好 DeepSeek key 即可。";
    }
    const key = b === "claude-cli" ? "claude" : b === "codex-cli" ? "codex" : "kiro";
    const v = detection[key];
    if (v === null) return "检测中…";
    if (!v) {
      const hint =
        key === "claude"
          ? "npm i -g @anthropic-ai/claude-code，然后 claude login 登录订阅"
          : key === "codex"
          ? "见 OpenAI Codex CLI 安装文档"
          : "见 AWS Kiro CLI 安装文档";
      return `✗ 未在 PATH 检测到 ${key === "kiro" ? "kiro-cli" : key} 命令。请先安装：${hint}`;
    }
    if (key === "kiro") {
      return "✓ 已检测到 kiro-cli。还需在系统环境变量里设置 KIRO_API_KEY（Kiro headless 强制要 key），MCP 在 Kiro 配置里加 latitude server。";
    }
    if (key === "claude") {
      return "✓ 已检测到 claude。先 claude login 登录订阅。Latitude 启动 claude 时会自动配 MCP 指向本机 server。";
    }
    return "✓ 已检测到 codex。先 codex login 登录。Latitude 启动 codex 时会自动配 MCP 指向本机 server（无需手动 codex mcp add）。";
  })();

  return (
    <>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-3 leading-relaxed">
        选内置对话用哪个 AI。DeepSeek API 按 token 付费（默认）；三家 CLI 走你本地的订阅或 API key，更省钱但需先装好 CLI 工具。
      </p>
      <Field label="后端">
        <SegmentControl<ChatBackend>
          value={settings.chatBackend}
          onChange={settings.setChatBackend}
          options={[
            { value: "deepseek-api", label: "DeepSeek API" },
            { value: "claude-cli", label: "Claude Code" },
            { value: "codex-cli", label: "Codex" },
            { value: "kiro-cli", label: "Kiro" },
          ]}
        />
        <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-2 leading-relaxed">
          {statusText}
        </div>
      </Field>
    </>
  );
}
