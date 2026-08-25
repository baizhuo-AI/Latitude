import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Eye, EyeOff, Plug, CalendarClock, Sheet } from "lucide-react";
import { useSettingsStore, type FeishuRegion } from "../lib/settings";
import { useCalendarEventsStore } from "../lib/calendarEventsStore";
import { feishuSyncNow } from "../lib/calendarSync";
import { describeBitable } from "../lib/feishuBitable";
import { cn } from "../lib/utils";
import { Section, Field, SegmentControl } from "../components/settings/SettingsPrimitives";

/**
 * 「连接」页(需求 3)— 从设置页拆出的一级导航入口。
 *
 * 收纳所有「与外部服务 / 工具建立连接」的对接:
 *  - 飞书 / Lark 日历同步(用户主诉求,放最前)
 *  - 飞书多维表格写入(依赖同一份飞书授权,紧随其后)
 *  - 接入 AI 助手(MCP,让外部 AI 连进来读写数据)
 *
 * 边界:LLM 提供商 / 对话后端是「选哪个大脑」的 app 基础依赖,不是外部对接,仍留在设置页。
 */
export function ConnectionsPage() {
  const { t } = useTranslation();
  return (
    <div className="h-full flex flex-col">
      <header className="h-14 px-6 flex items-center border-b border-zinc-200 dark:border-zinc-800 flex-shrink-0">
        <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          {t("nav.connections")}
        </h1>
      </header>

      <div className="flex-1 overflow-auto scrollbar-thin">
        <div className="max-w-2xl mx-auto px-6 py-8 space-y-8">
          {/* 连接飞书 / Lark 日历 */}
          <Section
            icon={<CalendarClock className="w-4 h-4" />}
            title="连接飞书 / Lark 日历"
            description="把飞书/Lark 日程同步进 Latitude；在 Latitude 修改可写日程时也会回传，因此需要日历读写权限。凭证只存本机系统钥匙串。"
          >
            <FeishuConnectSection />
          </Section>

          {/* 飞书多维表格写入(需先连接上方同一飞书 / Lark 账号) */}
          <Section
            icon={<Sheet className="w-4 h-4" />}
            title="飞书多维表格"
            description="开启后，对话中的写入请求会真实修改指定的飞书多维表格；当前没有统一的执行前确认或回滚。建议先读取表结构再开启。"
          >
            <FeishuBitableSection />
          </Section>

          {/* 接入 AI 助手（MCP）*/}
          <Section
            icon={<Plug className="w-4 h-4" />}
            title="接入 AI 助手"
            description="让本机 AI 通过带访问密钥的 MCP 操作任务、目标、活动记录、记忆和自定义字段；当前写入与删除没有逐次确认或统一回滚。"
          >
            <McpAccessSection />
          </Section>
        </div>
      </div>
    </div>
  );
}

/* ---------- 接入 AI 助手（MCP）---------- */

interface McpConnInfo {
  port: number;
  token: string;
  command: string;
}

function McpAccessSection() {
  const [info, setInfo] = useState<McpConnInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        setInfo(await invoke<McpConnInfo>("mcp_connection_info"));
      } catch (e) {
        setErr(String(e));
      }
    })();
  }, []);

  async function copy() {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr("复制失败，请手动选中命令复制");
    }
  }

  if (err) return <p className="text-sm text-red-500">{err}</p>;
  if (!info)
    return <p className="text-sm text-zinc-400 dark:text-zinc-500">加载中…</p>;

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
        在终端运行下面这条命令，把 Latitude 接入 Claude
        Code（连接配置会持久保存；Latitude 运行时，命令中的密钥可用）：
      </p>
      <div className="relative">
        <pre className="text-xs font-mono bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg p-3 pr-16 overflow-x-auto whitespace-pre-wrap break-all text-zinc-800 dark:text-zinc-200">
{info.command}
        </pre>
        <button
          type="button"
          onClick={() => void copy()}
          className="absolute right-2 top-2 px-2.5 py-1 text-xs font-medium rounded-md bg-indigo-600 text-white hover:bg-indigo-500 transition-colors"
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
        端口 {info.port}，仅本机可连，需保持 Latitude 运行。命令含访问密钥，请勿公开分享；接入后 AI 可调用对应写工具。Latitude 当前不提供逐次审批、密钥轮换或最近动作列表，也不包含日历查询、提案和多维表写入能力。
      </p>
    </div>
  );
}

/* ---------- 连接飞书 / Lark 日历 ---------- */

/** 回调地址：必须与 Rust 端 callback.rs 的 CALLBACK_PORT 一致，且逐字填进飞书后台。 */
const FEISHU_REDIRECT_URI = "http://127.0.0.1:42801/feishu/callback";

/** 与 Rust feishu_status 返回结构对齐（serde 字段名为 snake_case）。 */
interface FeishuRegionStatus {
  has_app_id: boolean;
  has_secret: boolean;
  connected: boolean;
  token_expires_at: number | null;
  last_error: string | null;
}
interface FeishuStatusInfo {
  active_region: FeishuRegion | null;
  feishu: FeishuRegionStatus;
  lark: FeishuRegionStatus;
}
interface FeishuAuthEvent {
  phase: "waiting_browser" | "exchanging" | "success" | "error";
  region: FeishuRegion;
  message: string | null;
}

const feishuInputCls = cn(
  "w-72 px-3 py-1.5 rounded-lg text-sm outline-none transition-colors font-mono",
  "bg-zinc-50 dark:bg-zinc-950",
  "border border-zinc-200 dark:border-zinc-700",
  "focus:border-indigo-500",
  "text-zinc-900 dark:text-zinc-100",
  "placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
);

function fmtExpiry(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString();
}

/** 同步状态行的聚合产物:把当前 region 下各日历的游标行揉成一句话该显示什么。 */
interface FeishuSyncDisplay {
  /** 任一日历处于 syncing(同步进行中)。 */
  syncing: boolean;
  /** 当前 region 下最近一次成功同步时间(ISO);取各日历 lastSyncedAt 的最大值。 */
  lastSyncedAt: string | null;
  /** 当前 region 下任一日历的 last_error(取第一条非空);无则 null。 */
  lastError: string | null;
}

/**
 * 把某 region 下的同步游标行聚合成展示态。
 * 规则:syncing 只要有一条在同步就算同步中;lastSyncedAt 取最大(最近);
 * lastError 取第一条非空(单日历失败的细节,设置页只露一条即可)。
 */
function aggregateSyncDisplay(
  states: { calendarId: string; lastSyncedAt?: string; status: string; lastError?: string }[]
): FeishuSyncDisplay {
  let syncing = false;
  let lastSyncedAt: string | null = null;
  let lastError: string | null = null;
  for (const s of states) {
    if (s.status === "syncing") syncing = true;
    if (s.lastSyncedAt && (!lastSyncedAt || s.lastSyncedAt > lastSyncedAt)) {
      lastSyncedAt = s.lastSyncedAt;
    }
    if (!lastError && s.lastError) lastError = s.lastError;
  }
  return { syncing, lastSyncedAt, lastError };
}

/** ISO 时间 → 本地可读串(同步状态行用,格式跟 fmtExpiry 一致)。 */
function fmtSyncedAt(iso: string): string {
  return new Date(iso).toLocaleString();
}

function FeishuConnectSection() {
  const activeRegionPref = useSettingsStore((s) => s.feishu.activeRegion);
  const setFeishuRegion = useSettingsStore((s) => s.setFeishuRegion);

  const [region, setRegion] = useState<FeishuRegion>(activeRegionPref ?? "feishu");
  const [status, setStatus] = useState<FeishuStatusInfo | null>(null);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 同步状态展示从 calendarEventsStore 的 syncStates 读(真相源是 SQLite 的 sync_state 表)。
  // 首屏拉一次,之后手动同步完再 refreshSyncStates() 刷新;Rust 后台同步走 notify→hydrate 也会带上。
  const syncStates = useCalendarEventsStore((s) => s.syncStates);
  const hydrate = useCalendarEventsStore((s) => s.hydrate);
  const refreshSyncStates = useCalendarEventsStore((s) => s.refreshSyncStates);
  const [syncing, setSyncing] = useState(false); // 「立即同步」按钮 pending 态(本组件本地,不混引擎内部状态)
  const [syncSummary, setSyncSummary] = useState<string | null>(null); // 上一轮手动同步的摘要文案
  const [syncErr, setSyncErr] = useState<string | null>(null); // 手动同步失败文案(与凭证/授权的 err 分开)

  async function refresh() {
    try {
      setStatus(await invoke<FeishuStatusInfo>("feishu_status"));
    } catch (e) {
      setErr(String(e));
    }
  }

  useEffect(() => {
    void refresh();
    // 同步状态首屏拉一次:Settings 页可能是冷启动直接打开,store 还没 hydrate 过,
    // 没有 syncStates 会让状态行一直显示「尚未同步」。只刷游标行(不动 events,轻)。
    void refreshSyncStates();
    // 监听 OAuth 进度事件（后台 spawn 的授权流程靠它推进度/结果）
    const un = listen<FeishuAuthEvent>("feishu-auth-event", (ev) => {
      const p = ev.payload;
      setPhase(p.phase);
      if (p.phase === "success") {
        setErr(null);
        setAppSecret("");
        void refresh();
        setTimeout(() => setPhase(null), 2500);
      } else if (p.phase === "error") {
        setErr(p.message ?? "授权失败");
        setPhase(null);
      }
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const cur = status ? status[region] : null;
  const busy = phase === "waiting_browser" || phase === "exchanging";
  // 当前 region 下各日历游标行的聚合展示态(上次同步 / 同步中 / 出错)。
  const syncDisplay = aggregateSyncDisplay(syncStates.filter((s) => s.region === region));

  function chooseRegion(r: FeishuRegion) {
    setRegion(r);
    setFeishuRegion(r);
    setErr(null);
    setPhase(null);
    // 切区域时清掉上一区域的手动同步摘要/错误,避免串台(状态行 syncDisplay 会按新 region 自动重算)。
    setSyncSummary(null);
    setSyncErr(null);
  }

  async function connect() {
    setErr(null);
    try {
      // 填了新凭证就先存；没填则用已存的直接授权
      if (appId.trim() && appSecret.trim()) {
        await invoke("feishu_set_credentials", {
          region,
          appId: appId.trim(),
          appSecret: appSecret.trim()
        });
      } else if (!cur?.has_app_id || !cur?.has_secret) {
        setErr("请先填写 App ID 和 App Secret");
        return;
      }
      setPhase("waiting_browser");
      await invoke("feishu_start_auth", { region });
    } catch (e) {
      setErr(String(e));
      setPhase(null);
    }
  }

  async function disconnect() {
    setErr(null);
    try {
      await invoke("feishu_disconnect", { region });
      setAppId("");
      setAppSecret("");
      await refresh();
    } catch (e) {
      setErr(String(e));
    }
  }

  async function runSync() {
    setSyncErr(null);
    setSyncSummary(null);
    setSyncing(true);
    try {
      const summary = await feishuSyncNow();
      // 摘要按 region 汇总(后台引擎一轮可能同步飞书+Lark 两边,这里只把当前选中 region 的数字拎出来给用户看)。
      const cur = summary.regions.find((r) => r.region === region);
      if (cur?.error) {
        // region 级失败:引擎跑了但整个 region 挂了(凭证失效等),当错误显示而非"成功"。
        setSyncErr(cur.error);
      } else if (cur) {
        setSyncSummary(`新增 ${cur.upserted}、删除 ${cur.deleted}`);
      } else {
        // 当前 region 没在本轮结果里(通常是未连接 → 引擎跳过),给个温和提示。
        setSyncSummary("本次未同步(当前区域未连接)");
      }
      // 不管摘要如何,同步副作用已落库,刷新内存:事件喂日历视图 + 游标行喂本状态行。
      await hydrate();
      await refreshSyncStates();
    } catch (e) {
      // 凭证缺失 / 引擎未起 / IPC 失败等:兜底显示文案,不崩。
      setSyncErr(String(e));
    } finally {
      setSyncing(false);
    }
  }

  async function copyRedirect() {
    try {
      await navigator.clipboard.writeText(FEISHU_REDIRECT_URI);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr("复制失败，请手动复制");
    }
  }

  const phaseText: Record<string, string> = {
    waiting_browser: "已打开浏览器，请在飞书页面点「同意授权」…",
    exchanging: "正在换取 token…",
    success: "✓ 连接成功"
  };

  return (
    <div className="space-y-4">
      <Field label="区域">
        <SegmentControl<FeishuRegion>
          value={region}
          onChange={chooseRegion}
          options={[
            { value: "feishu", label: "飞书（国内）" },
            { value: "lark", label: "Lark（国际）" }
          ]}
        />
      </Field>

      <div className="text-xs leading-relaxed">
        {cur?.connected ? (
          <span className="text-emerald-600 dark:text-emerald-400">
            ✓ 已连接
            {cur.token_expires_at ? ` · token 约 ${fmtExpiry(cur.token_expires_at)} 过期` : ""}
          </span>
        ) : cur?.has_app_id && cur?.has_secret ? (
          <span className="text-amber-600 dark:text-amber-400">凭证已保存，待授权</span>
        ) : (
          <span className="text-zinc-500 dark:text-zinc-400">未配置</span>
        )}
        {cur?.last_error && !cur.connected && (
          <span className="text-red-500 ml-2">· 上次错误：{cur.last_error}</span>
        )}
      </div>

      {/* 同步状态 + 立即同步:仅已连接时显示(没连接谈不上同步) */}
      {cur?.connected && (
        <div className="rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-3 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs leading-relaxed min-w-0">
              {syncDisplay.syncing ? (
                <span className="text-indigo-600 dark:text-indigo-400">同步中…</span>
              ) : syncDisplay.lastError ? (
                <span className="text-red-500 break-all">
                  出错：{syncDisplay.lastError}
                </span>
              ) : syncDisplay.lastSyncedAt ? (
                <span className="text-zinc-500 dark:text-zinc-400">
                  上次同步：{fmtSyncedAt(syncDisplay.lastSyncedAt)}
                </span>
              ) : (
                <span className="text-zinc-500 dark:text-zinc-400">尚未同步</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void runSync()}
              disabled={syncing || syncDisplay.syncing}
              className="flex-shrink-0 px-3 py-1.5 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
            >
              {syncing ? "同步中…" : "立即同步"}
            </button>
          </div>
          {syncSummary && !syncErr && (
            <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
              ✓ 已同步 · {syncSummary}
            </p>
          )}
          {syncErr && (
            <p className="text-[11px] text-red-500 break-all">同步失败：{syncErr}</p>
          )}
        </div>
      )}

      <Field label="App ID">
        <input
          type="text"
          value={appId}
          onChange={(e) => setAppId(e.target.value)}
          placeholder={cur?.has_app_id ? "已保存（如需更换请重填）" : "cli_xxxxxxxxxxxxxxxx"}
          className={feishuInputCls}
        />
      </Field>
      <Field label="App Secret">
        <div className="relative">
          <input
            type={showSecret ? "text" : "password"}
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            placeholder={cur?.has_secret ? "已保存（只写不回显）" : "应用密钥"}
            className={cn(feishuInputCls, "pr-9")}
          />
          <button
            type="button"
            onClick={() => setShowSecret((v) => !v)}
            aria-label={showSecret ? "hide" : "show"}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
          >
            {showSecret ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
      </Field>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void connect()}
          disabled={busy}
          className="px-3 py-1.5 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
        >
          {cur?.connected ? "重新授权" : "连接"}
        </button>
        {(cur?.connected || cur?.has_app_id) && (
          <button
            type="button"
            onClick={() => void disconnect()}
            className="px-3 py-1.5 text-sm font-medium rounded-lg text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/50 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors"
          >
            断开
          </button>
        )}
        {phase && (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {phaseText[phase] ?? phase}
          </span>
        )}
      </div>

      {err && <p className="text-xs text-red-500">{err}</p>}

      <div className="rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-3 space-y-1.5">
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
          在{region === "feishu" ? "飞书" : "Lark"}开放平台建「自建应用」，申请日历读写
          scope（calendar:calendar + offline_access），并把下面这个回调地址
          <strong>逐字</strong>填进应用的「重定向 URL」：
        </p>
        <div className="relative">
          <code className="block text-xs font-mono bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md p-2 pr-14 break-all text-zinc-800 dark:text-zinc-200">
            {FEISHU_REDIRECT_URI}
          </code>
          <button
            type="button"
            onClick={() => void copyRedirect()}
            className="absolute right-1.5 top-1.5 px-2 py-0.5 text-[11px] font-medium rounded bg-indigo-600 text-white hover:bg-indigo-500 transition-colors"
          >
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- 飞书多维表格 connector ---------- */

function FeishuBitableSection() {
  const f = useSettingsStore((s) => s.feishu);
  const setBitableConfig = useSettingsStore((s) => s.setBitableConfig);
  const [link, setLink] = useState(f.bitableLink ?? "");
  const [testing, setTesting] = useState(false);
  const [fields, setFields] = useState<{ name: string; isPrimary: boolean }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const region = f.activeRegion;
  const enabled = f.bitableEnabled ?? false;

  async function test() {
    setErr(null);
    setFields(null);
    const l = link.trim();
    if (!l) {
      setErr("请先粘贴飞书多维表格的链接");
      return;
    }
    if (!region) {
      setErr("请先在上方「连接飞书 / Lark 日历」选好区域并连接账号");
      return;
    }
    setTesting(true);
    try {
      const info = await describeBitable(region, l);
      setBitableConfig({
        bitableLink: l,
        bitableAppToken: info.app_token,
        bitableTableId: info.table_id
      });
      setFields(info.fields.map((x) => ({ name: x.field_name, isPrimary: x.is_primary })));
    } catch (e) {
      const msg = String(e);
      // token 失效 / 权限不足 → 引导去重新授权（设计决策 B）。
      const needReauth =
        msg.includes("失效") || msg.includes("token") || msg.includes("权限") || msg.includes("99991");
      setErr(
        needReauth
          ? `${msg}\n→ 请到上方「连接飞书 / Lark 日历」点「重新授权」，并确认已在飞书开放平台后台给应用勾选「多维表格」相关权限。`
          : msg
      );
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
        粘贴链接、读取表结构并开启后，在对话里说「把今天的项目进展写进飞书表」会真实修改外部记录。
        当前写入前没有统一确认，发生后也不能从 Latitude 一键回滚；需先在上方连接同一个飞书 / Lark 账号。
      </p>

      <Field label="表格链接">
        <input
          type="text"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="https://xxx.feishu.cn/wiki/...?table=tbl..."
          className={cn(feishuInputCls, "w-full")}
        />
      </Field>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void test()}
          disabled={testing}
          className="px-3 py-1.5 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
        >
          {testing ? "读取中…" : "测试连接 / 读取表结构"}
        </button>
      </div>

      {fields && (
        <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 p-3 space-y-2">
          <p className="text-xs text-emerald-700 dark:text-emerald-300">
            ✓ 已连接，共 {fields.length} 个字段：
          </p>
          <div className="flex flex-wrap gap-1.5">
            {fields.map((x) => (
              <span
                key={x.name}
                className={cn(
                  "px-2 py-0.5 rounded text-[11px]",
                  x.isPrimary
                    ? "bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 font-medium"
                    : "bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700"
                )}
              >
                {x.name}
                {x.isPrimary ? " · 主" : ""}
              </span>
            ))}
          </div>
        </div>
      )}

      {err && <p className="text-xs text-red-500 whitespace-pre-line">{err}</p>}

      <Field label="启用外部写入">
        <SegmentControl<"on" | "off">
          value={enabled ? "on" : "off"}
          onChange={(v) =>
            setBitableConfig({ bitableEnabled: v === "on", bitableLink: link.trim() || undefined })
          }
          options={[
            { value: "on", label: "开启" },
            { value: "off", label: "关闭" }
          ]}
        />
      </Field>
    </div>
  );
}
