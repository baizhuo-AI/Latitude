import { create } from "zustand";
import i18n from "./i18n";
import type { PersonaSpec } from "./persona/personaSpec";
import { DEFAULT_PERSONA_KEY } from "./persona/personaSpec";
import type { ProactiveConfig, ProactiveEvents, ActivityCaptureConfig } from "./secretary/proactiveConfig";
import { defaultProactiveConfig } from "./secretary/proactiveConfig";

/**
 * setProactive 的入参:除 events / activityCapture 外都是 Partial<ProactiveConfig> 的普通字段,
 * events / activityCapture 允许只带变动的字段,由 store 深合并补齐。
 */
export type ProactivePatch = Partial<Omit<ProactiveConfig, "events" | "activityCapture">> & {
  events?: Partial<ProactiveEvents>;
  activityCapture?: Partial<ActivityCaptureConfig>;
};

/**
 * 应用偏好设置
 *
 * 持久化:localStorage(简单方案)。P3 上 Tauri keychain 后,API key 部分搬过去。
 *
 * 包含:
 *  - lang:中/英
 *  - llmProvider:当前激活 LLM
 *  - keys:各家的 API key(脱敏显示)
 *  - baseUrls / models:各家的可选覆盖
 *  - reminder:间歇式时间日志的定时提醒配置
 *
 * 主题不在这里,在 lib/theme.ts(主题切换有专门的 system 模式 + matchMedia 监听,逻辑分离更清楚)
 */

export type Lang = "zh" | "en";
export type ProviderName = "deepseek" | "anthropic" | "openai" | "mock";

/** 内置对话用哪个后端：DeepSeek API 直连 / 三家本地 CLI 各自走用户订阅或 API key */
export type ChatBackend = "deepseek-api" | "claude-cli" | "codex-cli" | "kiro-cli";

/** 飞书 / Lark 区域（国内 vs 国际，两套独立平台、两套凭证）。 */
export type FeishuRegion = "feishu" | "lark";

/**
 * 飞书偏好——故意只存「选了哪个区域」这种非敏感偏好。
 * app_secret / token / 连接状态绝不进 localStorage（落实 settings.ts 顶部那条 TODO），
 * 真实状态每次现拉 Rust 的 feishu_status。
 */
export interface FeishuPrefs {
  /** 当前选中的区域；null = 还没选过 */
  activeRegion: FeishuRegion | null;
  /** 多维表格 connector：用户粘贴的目标表链接（原始链接，非敏感） */
  bitableLink?: string;
  /** 解析缓存：base app_token（describe 成功后存，写入时复用，免重复解析 wiki） */
  bitableAppToken?: string;
  /** 解析缓存：table_id */
  bitableTableId?: string;
  /** 插件开关 */
  bitableEnabled?: boolean;
  /** 记住"哪个自定义字段代表项目"（field_definitions.id）；空 = 用默认名为"项目"的字段 */
  bitableProjectFieldId?: string;
}

interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  /** 默认 model(parseTask / 排今日 等结构化任务用) */
  model?: string;
  /**
   * 带工具的 agent 对话路径(sendMessage → chatAgentCall)用的 model。
   * 不填则回退到 model;再不填回退到内置默认。
   * 设这个字段是为了「解 reasoner/工具互斥」:
   *   - 以前 agent 路径写死 deepseek-chat(无推理);
   *   - 现在可配,比如 DeepSeek V4 这种「工具+推理合一」的模型可直接填这里,
   *     能力位会据 model 名据实放开工具+推理。
   */
  agentModel?: string;
  /**
   * 深度思考的流式对话路径(chatStreamCall)用的 model。
   * 不填则回退到内置默认(deepseek-reasoner)。同样不再写死,便于换成 V4。
   */
  reasoningModel?: string;
}

/** 提醒方式:浮窗 / 系统通知 / 两者都用 */
export type ReminderChannel = "floating" | "notification" | "both";

export interface ReminderConfig {
  /** 总开关 */
  enabled: boolean;
  /** 提醒间隔(分钟) */
  intervalMin: number;
  /** 提醒方式 */
  channel: ReminderChannel;
  /** 工作时段起始小时(0-23),只在 [workStart, workEnd) 内提醒 */
  workStart: number;
  /** 工作时段结束小时(0-23) */
  workEnd: number;
  /** 暂停截止时间戳(ms);Date.now() < pausedUntil 时不提醒 */
  pausedUntil?: number;
}

export interface ShortcutsConfig {
  /** 全局快捷键 accelerator(形如 "Alt+Space" / "Super+Shift+KeyK";空串 = 禁用) */
  toggleChatbar: string;
  toggleTodo: string;
  showWorkbench: string;
}

export interface SettingsState {
  lang: Lang;
  llmProvider: ProviderName;
  providers: {
    deepseek: ProviderConfig;
    anthropic: ProviderConfig;
    openai: ProviderConfig;
  };
  /** 内置对话用哪个后端：默认 DeepSeek API；三家 CLI 走用户本地订阅/API key */
  chatBackend: ChatBackend;
  reminder: ReminderConfig;
  shortcuts: ShortcutsConfig;
  feishu: FeishuPrefs;
  /**
   * 用户人设配置(Task 1.1)
   * 默认=资深幕僚预设;用户可在 Settings 里切换/自定义(Task 1.2 做 UI)
   */
  persona: PersonaSpec;
  /**
   * AI 秘书主动姿态配置(Task 3.4)
   * 懒人三档(关/温和/积极)+ 高玩字段(心跳/晨报/打扰预算/事件开关/渠道)。
   * 默认温和(gentle);静默时段沿用 reminder.workStart/workEnd(不在此重复存)。
   */
  proactive: ProactiveConfig;
  /**
   * 隐私:仅本地大脑(Task 4.6a)
   * 开启时,记忆/上下文只注入本地 CLI 引擎(claude-cli/codex-cli/kiro-cli)。
   * 若用户选了云端 API 后端(deepseek-api),UI 显示警告;buildChatSystemPrompt
   * 在云端后端时跳过记忆注入。
   * 默认 false(不改变现有行为)。
   */
  localOnlyBrain: boolean;
  /**
   * 隐私:敏感信息不记忆(Task 4.6a)
   * 开启时,在系统提示词里追加指令,告知大脑不要把密码/财务/身份/医疗等
   * 敏感信息写进 remember 工具的长期记忆。
   * 默认 false。
   */
  noSensitiveMemory: boolean;
  /**
   * 成本:省电/低频模式(Task 4.6a)
   * 开启时用于 UI 提示「已切换低频」;实际参数通过 setProactive 写入 proactive
   * (heartbeatMin 拉长到 240min、budgetPerHalfDay 收紧到 1 次/半天)。
   * 此字段本身仅作 UI 状态跟踪(开关是否激活)。
   * 默认 false。
   */
  lowPowerMode: boolean;
  /**
   * 侧栏导航项显隐(需求 4)
   * 存「被隐藏的导航 key」列表(briefing/todos/calendar/activities/history/telos/aboutYou/connections)。
   * 默认 []=全部显示;只存被关掉的,向后兼容(旧存档无此字段即全显)。
   * 「设置」入口不参与隐藏(它是侧栏管理的回路,藏了用户会被锁死),故不在此列表里。
   */
  sidebarHidden: string[];
}

// re-export PersonaSpec / ProactiveConfig 让消费方不用另外 import 子模块
export type { PersonaSpec };
export type { ProactiveConfig };

const STORAGE_KEY = "daybreak.settings";

/** 默认值:provider 从 .env.local 兜底(给开发期方便);用户在 Settings 里填会覆盖 */
function defaults(): SettingsState {
  const env = import.meta.env;
  return {
    lang: detectInitialLang(),
    llmProvider:
      ((env.VITE_LLM_PROVIDER as ProviderName) ?? "deepseek") || "deepseek",
    providers: {
      deepseek: {
        apiKey: env.VITE_DEEPSEEK_API_KEY,
        baseUrl: env.VITE_DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
        model: env.VITE_DEEPSEEK_MODEL ?? "deepseek-chat"
      },
      anthropic: {
        apiKey: env.VITE_ANTHROPIC_API_KEY,
        baseUrl: "https://api.anthropic.com",
        model: env.VITE_ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514"
      },
      openai: {
        apiKey: env.VITE_OPENAI_API_KEY,
        baseUrl: "https://api.openai.com/v1",
        model: env.VITE_OPENAI_MODEL ?? "gpt-4o"
      }
    },
    chatBackend: "deepseek-api",
    // 提醒默认关闭(用户主动去设置里开,避免一上来就被打扰);开后默认 2h、工作时段 9-22
    reminder: {
      enabled: false,
      intervalMin: 120,
      channel: "both",
      workStart: 9,
      workEnd: 22
    },
    shortcuts: { toggleChatbar: "Alt+Space", toggleTodo: "", showWorkbench: "" },
    feishu: { activeRegion: null, bitableEnabled: false },
    persona: { presetKey: DEFAULT_PERSONA_KEY },
    // 主动姿态默认温和(gentle)——见 defaultProactiveConfig
    proactive: defaultProactiveConfig(),
    // 隐私 + 成本(Task 4.6a):默认全关,不改变现有行为
    localOnlyBrain: false,
    noSensitiveMemory: false,
    lowPowerMode: false,
    // 新用户默认只露 todos/calendar/aboutYou,其余藏起来降低初始认知负荷
    sidebarHidden: ["briefing", "activities", "history", "telos", "connections"]
  };
}

/**
 * 仅供测试:暴露 defaults() 的当前值快照,让 secretary 配置测试断言「默认温和」
 * 等不依赖 localStorage 的纯默认。生产代码请用 readSettingsSnapshot / useSettingsStore。
 */
export function defaultSettingsForTest(): SettingsState {
  return defaults();
}

function detectInitialLang(): Lang {
  if (typeof window === "undefined") return "zh";
  const nav = window.navigator.language ?? "zh";
  return nav.toLowerCase().startsWith("en") ? "en" : "zh";
}

/**
 * 合并 proactive 配置 + 老 reminder → activityCapture 的一次性迁移(定时×主动全合 M4)。
 *
 * 背景:M4 退役老 reminder 的"活动记录"定时器,改由 activity_capture 接手。开过老提醒的
 * 用户(reminder.enabled / 设过 reminder.intervalMin),升级后应等价地由 activity_capture 接管。
 *
 * 迁移规则(兜底安全、幂等):
 *   1. 幂等护栏:存档里【已有】 proactive.activityCapture(用户已在新 schema 下保存过)→
 *      一律以存档为准,reminder 不再覆盖它。这样升级后用户在新 UI 改的设置不会被反复回滚。
 *   2. 仅当存档【没有】 activityCapture(纯老用户)时,用 reminder 的值初始化 activityCapture:
 *        activityCapture.enabled    ← reminder.enabled
 *        activityCapture.intervalMin ← reminder.intervalMin
 *      activityCaptureMode 老 schema 无此概念,取默认 gentle。
 *
 * ⚠️ 共享字段(workStart/workEnd/pausedUntil)是整个主动引擎的唯一真相源,留在 reminder 里,
 *    本迁移绝不读写/搬走它们 —— 只读 reminder 的 enabled/intervalMin。
 *
 * @param parsedProactive 存档里的 proactive(可能整块缺失,或缺 activityCapture)
 * @param parsedReminder  存档里的 reminder(用于纯老用户的迁移源)
 * @param def             defaults() 的当前快照(补缺字段)
 */
function mergeProactiveWithMigration(
  parsedProactive: Partial<ProactiveConfig> | undefined,
  parsedReminder: Partial<ReminderConfig> | undefined,
  def: SettingsState
): ProactiveConfig {
  // 整块没存过 proactive:纯老用户(或全新用户)。activityCapture 从 reminder 迁移(老用户)
  // 或落默认(全新用户,parsedReminder 也为空时 ?? 兜底到 def 默认值)。
  if (!parsedProactive) {
    return {
      ...def.proactive,
      activityCapture: migrateActivityCaptureFromReminder(parsedReminder, def),
    };
  }
  // 存过 proactive,但可能缺 activityCapture(老 schema 的 proactive,没有这个子配置)。
  const activityCapture: ActivityCaptureConfig = parsedProactive.activityCapture
    ? // 幂等护栏:已在新 schema 下保存过 activityCapture → 以存档为准(补缺字段)
      { ...def.proactive.activityCapture, ...parsedProactive.activityCapture }
    : // 老 schema 的 proactive 没有 activityCapture → 从 reminder 迁移
      migrateActivityCaptureFromReminder(parsedReminder, def);
  return {
    ...def.proactive,
    ...parsedProactive,
    events: { ...def.proactive.events, ...(parsedProactive.events ?? {}) },
    activityCapture,
  };
}

/**
 * 从老 reminder 配置派生 activityCapture(纯老用户的迁移源)。
 * reminder 缺字段时回退默认值(全新用户走这条也安全)。
 */
function migrateActivityCaptureFromReminder(
  parsedReminder: Partial<ReminderConfig> | undefined,
  def: SettingsState
): ActivityCaptureConfig {
  return {
    enabled:
      typeof parsedReminder?.enabled === "boolean"
        ? parsedReminder.enabled
        : def.proactive.activityCapture.enabled,
    intervalMin:
      typeof parsedReminder?.intervalMin === "number"
        ? parsedReminder.intervalMin
        : def.proactive.activityCapture.intervalMin,
    // 老 schema 无策略档概念,取默认 gentle
    activityCaptureMode: def.proactive.activityCapture.activityCaptureMode,
  };
}

function readStored(): SettingsState {
  if (typeof window === "undefined") return defaults();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Partial<SettingsState>;
    const def = defaults();
    // 浅合并 + 嵌套合并
    return {
      lang: parsed.lang === "en" || parsed.lang === "zh" ? parsed.lang : def.lang,
      llmProvider:
        parsed.llmProvider && validProvider(parsed.llmProvider)
          ? parsed.llmProvider
          : def.llmProvider,
      providers: {
        deepseek: { ...def.providers.deepseek, ...(parsed.providers?.deepseek ?? {}) },
        anthropic: { ...def.providers.anthropic, ...(parsed.providers?.anthropic ?? {}) },
        openai: { ...def.providers.openai, ...(parsed.providers?.openai ?? {}) }
      },
      chatBackend: validChatBackend(parsed.chatBackend) ? parsed.chatBackend : def.chatBackend,
      reminder: { ...def.reminder, ...(parsed.reminder ?? {}) },
      shortcuts: { ...def.shortcuts, ...(parsed.shortcuts ?? {}) },
      feishu: {
        activeRegion: validFeishuRegion(parsed.feishu?.activeRegion)
          ? parsed.feishu!.activeRegion!
          : def.feishu.activeRegion,
        bitableLink: parsed.feishu?.bitableLink,
        bitableAppToken: parsed.feishu?.bitableAppToken,
        bitableTableId: parsed.feishu?.bitableTableId,
        bitableEnabled: parsed.feishu?.bitableEnabled ?? def.feishu.bitableEnabled,
        bitableProjectFieldId: parsed.feishu?.bitableProjectFieldId
      },
      persona: parsed.persona ? { ...def.persona, ...parsed.persona } : def.persona,
      // proactive:嵌套合并 + 老 reminder → activityCapture 一次性迁移(M4)。
      // 见 mergeProactiveWithMigration:已存过 activityCapture 以存档为准(幂等护栏),
      // 纯老用户/老 schema 则用 reminder.{enabled,intervalMin} 初始化 activityCapture。
      proactive: mergeProactiveWithMigration(parsed.proactive, parsed.reminder, def),
      // Task 4.6a 隐私 + 成本:布尔字段浅合并,旧存档无此字段时回退 defaults
      localOnlyBrain: typeof parsed.localOnlyBrain === "boolean" ? parsed.localOnlyBrain : def.localOnlyBrain,
      noSensitiveMemory: typeof parsed.noSensitiveMemory === "boolean" ? parsed.noSensitiveMemory : def.noSensitiveMemory,
      lowPowerMode: typeof parsed.lowPowerMode === "boolean" ? parsed.lowPowerMode : def.lowPowerMode,
      // 侧栏显隐:只接受字符串数组,逐项过滤脏数据。
      // 老用户(有 localStorage 但没存过此字段)回退 [] 全显,不被新默认值突然藏掉导航;
      // 全新用户(无 localStorage)走 defaults() 拿到精简默认。
      sidebarHidden: Array.isArray(parsed.sidebarHidden)
        ? parsed.sidebarHidden.filter((x): x is string => typeof x === "string")
        : []
    };
  } catch (err) {
    console.error("[settings] parse failed, falling back to defaults:", err);
    return defaults();
  }
}

/**
 * 直接从 localStorage 读最新飞书配置（跨窗口实时）。
 *
 * 为什么不用 useSettingsStore.getState()：Daybreak 是多窗口应用，每个窗口（工作台 / 对话悬浮条 /
 * todo 浮窗）有各自独立的 Zustand store 实例，store 内存态只在该窗口 create 时读一次 localStorage、
 * 之后不重读。设置页（主窗）改了配置只更新主窗 store + localStorage，对话悬浮条窗口的 store 内存态
 * 仍是陈旧快照。localStorage 同源跨窗口共享，故对话里的 AI 工具必须直读 localStorage 才能拿到最新配置。
 */
export function readFeishuPrefs(): FeishuPrefs {
  return readStored().feishu;
}

/**
 * 直接从 localStorage 读完整 settings 快照（跨窗口实时）。
 *
 * 用途：对话层（buildChatSystemPrompt / resolveDeepSeekModel 等）读 persona / lang /
 * providers 等配置时必须走这里，不能用 useSettingsStore.getState()——理由同上（多窗口 store
 * 隔离，对话悬浮条的 store 是陈旧快照）。localStorage 同源跨窗口共享，直读即实时。
 *
 * 同 readFeishuPrefs 一样是「真相源」读取器；命名 readSettingsSnapshot 强调它返回的
 * 是当前 localStorage 里的完整状态，与任何窗口的 store 内存态无关。
 */
export function readSettingsSnapshot(): SettingsState {
  return readStored();
}

/** 直接 patch localStorage 里的飞书配置（跨窗口生效）。供对话工具记住"项目字段"等，不经任一窗口 store。 */
export function patchFeishuPrefsInStorage(patch: Partial<FeishuPrefs>): void {
  if (typeof window === "undefined") return;
  try {
    const cur = readStored();
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...cur, feishu: { ...cur.feishu, ...patch } })
    );
  } catch (err) {
    console.error("[settings] patchFeishuPrefsInStorage failed:", err);
  }
}

function validProvider(v: string): v is ProviderName {
  return ["deepseek", "anthropic", "openai", "mock"].includes(v);
}

function validChatBackend(v: unknown): v is ChatBackend {
  return v === "deepseek-api" || v === "claude-cli" || v === "codex-cli" || v === "kiro-cli";
}

function validFeishuRegion(v: unknown): v is FeishuRegion {
  return v === "feishu" || v === "lark";
}

function persist(state: SettingsState) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.error("[settings] persist failed:", err);
  }
  // 活动记录的原生后台调度（Rust 引擎）需要这份配置,但设置只在前端 localStorage、Rust 读不到。
  // 收口在 persist:任何设置变更都把最新「主动配置」推给 Rust。fire-and-forget,失败只告警不阻塞。
  pushProactiveConfigToTauri(state);
}

/**
 * 把「主动配置」推给 Rust 后台引擎(`set_proactive_config` 命令)。
 *
 * 字段口径对齐 `src-tauri/src/secretary/config.rs` 的 `ProactiveRuntimeConfig`(camelCase)。
 * 动态 import invoke:避免给被广泛引用的 settings.ts 加 Tauri 顶层依赖;非 Tauri 环境(单测)
 * 走 catch 静默失败,不影响设置本身。
 */
function pushProactiveConfigToTauri(state: SettingsState): void {
  const ac = state.proactive?.activityCapture;
  const config = {
    enabled: ac?.enabled ?? false,
    masterOn: (state.proactive?.mode ?? "gentle") !== "off",
    intervalMin: ac?.intervalMin ?? 120,
    workStart: state.reminder?.workStart ?? 9,
    workEnd: state.reminder?.workEnd ?? 22,
    pausedUntil: state.reminder?.pausedUntil ?? null,
    channel: state.proactive?.channel ?? "chat",
    lang: state.lang ?? "zh",
  };
  void (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_proactive_config", { config });
    } catch (err) {
      console.warn("[settings] 推送主动配置到 Rust 失败(忽略):", err);
    }
  })();
}

/**
 * 启动时(主窗)推一次初始「主动配置」给 Rust。
 * persist 只在用户改设置时触发,冷启动不会调,故主窗挂载时须主动推一次,否则 Rust 引擎
 * 配置为 None、每个 tick 都跳过,活动记录永不触发。
 */
export function pushProactiveConfig(): void {
  pushProactiveConfigToTauri(readSettingsSnapshot());
}

interface SettingsStore extends SettingsState {
  setLang: (lang: Lang) => void;
  setProvider: (p: ProviderName) => void;
  setProviderConfig: (p: Exclude<ProviderName, "mock">, cfg: ProviderConfig) => void;
  setReminder: (patch: Partial<ReminderConfig>) => void;
  setShortcut: (patch: Partial<ShortcutsConfig>) => void;
  setChatBackend: (b: ChatBackend) => void;
  setFeishuRegion: (r: FeishuRegion | null) => void;
  setBitableConfig: (patch: Partial<FeishuPrefs>) => void;
  /** Task 1.1: 更新人设配置 */
  setPersona: (patch: Partial<PersonaSpec>) => void;
  /** Task 3.4: 更新主动姿态配置(events 单独深合并,patch.events 只需带变动的开关) */
  setProactive: (patch: ProactivePatch) => void;
  /** Task 4.6a: 更新隐私/成本开关(localOnlyBrain / noSensitiveMemory / lowPowerMode) */
  setPrivacy: (patch: Partial<Pick<SettingsState, "localOnlyBrain" | "noSensitiveMemory" | "lowPowerMode">>) => void;
  /** 需求 4: 全量覆盖侧栏隐藏项列表(「至少保留一项」的校验在 UI 层做,这里只负责存) */
  setSidebarHidden: (hidden: string[]) => void;
  reset: () => void;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  ...readStored(),
  setLang: (lang) => {
    set({ lang });
    persist({ ...get(), lang });
    void i18n.changeLanguage(lang);
  },
  setProvider: (llmProvider) => {
    set({ llmProvider });
    persist({ ...get(), llmProvider });
    // 让 LLM 模块下次取 provider 时重新构造(单例失效)
    resetProviderCache();
  },
  setProviderConfig: (p, cfg) => {
    const merged = { ...get().providers[p], ...cfg };
    const providers = { ...get().providers, [p]: merged };
    set({ providers });
    persist({ ...get(), providers });
    resetProviderCache();
  },
  setReminder: (patch) => {
    const reminder = { ...get().reminder, ...patch };
    set({ reminder });
    persist({ ...get(), reminder });
  },
  setShortcut: (patch) => {
    const shortcuts = { ...get().shortcuts, ...patch };
    set({ shortcuts });
    persist({ ...get(), shortcuts });
  },
  setChatBackend: (chatBackend) => {
    set({ chatBackend });
    persist({ ...get(), chatBackend });
  },
  setFeishuRegion: (region) => {
    const feishu = { ...get().feishu, activeRegion: region };
    set({ feishu });
    persist({ ...get(), feishu });
  },
  setBitableConfig: (patch) => {
    const feishu = { ...get().feishu, ...patch };
    set({ feishu });
    persist({ ...get(), feishu });
  },
  setPersona: (patch) => {
    const persona = { ...get().persona, ...patch };
    set({ persona });
    persist({ ...get(), persona });
  },
  setProactive: (patch) => {
    const cur = get().proactive;
    // events / activityCapture 单独深合并:UI 只改某一个字段时,不会把其他字段抹成 undefined
    const proactive: ProactiveConfig = {
      ...cur,
      ...patch,
      events: { ...cur.events, ...(patch.events ?? {}) },
      activityCapture: { ...cur.activityCapture, ...(patch.activityCapture ?? {}) },
    };
    set({ proactive });
    persist({ ...get(), proactive });
  },
  setPrivacy: (patch) => {
    set(patch);
    persist({ ...get(), ...patch });
  },
  setSidebarHidden: (sidebarHidden) => {
    set({ sidebarHidden });
    persist({ ...get(), sidebarHidden });
  },
  reset: () => {
    const d = defaults();
    set(d);
    persist(d);
    void i18n.changeLanguage(d.lang);
    resetProviderCache();
  }
}));

/**
 * LLM provider 缓存失效信号
 * lib/llm/index.ts 监听这个,切换 provider 或改 key 时重建实例
 */
let _resetters: Array<() => void> = [];
export function onProviderConfigChange(cb: () => void): () => void {
  _resetters.push(cb);
  return () => {
    _resetters = _resetters.filter((x) => x !== cb);
  };
}
function resetProviderCache() {
  _resetters.forEach((cb) => cb());
}

/** 启动时同步 i18n 到 store 里的 lang */
export function applyInitialLang() {
  const lang = useSettingsStore.getState().lang;
  void i18n.changeLanguage(lang);
}
