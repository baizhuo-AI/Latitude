/**
 * proactiveConfig.ts — AI 秘书「主动姿态」配置类型 + 三档解析纯函数 (Task 3.4)
 *
 * 配置真相源在 settings.ts 的 SettingsState.proactive(ProactiveConfig);本文件提供:
 *   - ProactiveConfig / ProactiveMode / ProactiveEvents / ProactiveChannel 类型
 *   - defaultProactiveConfig():给 settings.defaults() 复用,默认「温和」(gentle)
 *   - modeDefaults(mode) / resolveProactiveStance(config):懒人三档 → 具体生效姿态(纯函数)
 *
 * ─── 三档语义(懒人开关) ──────────────────────────────────────────────────────
 *   - off    :完全不主动(总闸关)。
 *   - gentle :默认。只在紧迫时刻冒一句,优先级地板高(背景/正反馈类被挡)。
 *   - active :更积极,优先级地板低(允许背景类如"任务搁置/刚完成")。
 *
 * 高玩展开字段(在三档基础上微调,由 UI 暴露):
 *   - heartbeatMin     :心跳/巡检间隔(分钟),决定多久跑一轮主动巡检(3.7 消费)。
 *   - morningHour      :晨间简报触发小时(0-23)。
 *   - budgetPerHalfDay :每半天打扰预算上限(给 gateProactive)。
 *   - events           :四类事件触发的开关(关掉的类在 3.7 巡检时整类跳过)。
 *   - channel          :投递渠道(给 deliverProactive)。
 *
 * ⚠️ 静默时段不在这里——沿用 reminder.workStart/workEnd 这一唯一真相源(铁律:
 *    工作时段只有一处,不重复造第二套,避免漂移)。UI 把「静默时段」做成编辑
 *    reminder 工作时段的入口。
 *
 * 纯函数铁律:modeDefaults / resolveProactiveStance 体内不读 Date.now()/Math.random()/store。
 *
 * ⚠️ 本文件不 import gateProactive —— 它是 settings.ts 的间接依赖(settings → proactiveConfig),
 *    而 gateProactive → gate → composeProactive → llm/index → settings 会成环。
 *    故温和地板这里用字面量 50,并在 proactiveConfig.test.ts 断言它 === gateProactive.PRIORITY_FLOOR_GENTLE
 *    防漂移(测试是测试文件,可安全 import gateProactive,不进生产环)。
 */

// ─── 导出常量:优先级地板(测试引用做断言) ──────────────────────────────────

/**
 * 温和姿态的优先级地板(=50,与 gateProactive.PRIORITY_FLOOR_GENTLE 对齐;见文件头说明为何不 import):
 *   meeting_soon 80 / deadline_near 70 过线;task_stuck 40 / just_completed 30 被挡。
 */
export const PROACTIVE_FLOOR_GENTLE = 50;

/**
 * 积极姿态的优先级地板(更低)。放低到 25:
 *   task_stuck 40 / just_completed 30 也能过线(背景/正反馈类允许冒出)。
 */
export const PROACTIVE_FLOOR_ACTIVE = 25;

// ─── 默认值常量 ──────────────────────────────────────────────────────────────

/** 默认心跳间隔(分钟):90min 巡检一次,温和不频繁 */
export const DEFAULT_HEARTBEAT_MIN = 90;
/** 默认晨报小时:与 wiring.ts 的 MORNING_HOUR 对齐 */
export const DEFAULT_MORNING_HOUR = 7;
/** 默认半天打扰预算:与 gateProactive 的 HALF_DAY_BUDGET_DEFAULT 对齐 */
export const DEFAULT_BUDGET_PER_HALF_DAY = 3;

/**
 * 活动捕获默认间隔(分钟):继承 reminder.intervalMin 的语义(默认 120min)。
 * 调用方可在 ProactiveConfig.activityCapture.intervalMin 里覆盖。
 */
export const DEFAULT_ACTIVITY_CAPTURE_INTERVAL_MIN = 120;

// ─── 类型 ─────────────────────────────────────────────────────────────────────

/** 懒人三档主动姿态 */
export type ProactiveMode = "off" | "gentle" | "active";

/**
 * 投递渠道枚举(给 deliverProactive)。
 * 语义见 deliverProactive.resolveDeliveryChannels:chat 恒投(可回复载体),其余叠加。
 */
export type ProactiveChannel = "chat" | "notification" | "float" | "all";

/** 四类事件触发的开关 */
export interface ProactiveEvents {
  /** 会议将至 */
  meetingSoon: boolean;
  /** ddl 临近 */
  deadlineNear: boolean;
  /** 任务搁置较久 */
  taskStuck: boolean;
  /** 刚完成(正反馈) */
  justCompleted: boolean;
}

/**
 * 活动捕获策略档位(解"规律性 vs 克制"张力):
 *   - "gentle":随秘书克制模式 — 忙时/别烦我时不催,与秘书其余触发共用节奏调制。
 *   - "scheduled":按时硬提醒 — 跳过"忙时"调制,只认工作时段 + 别烦我(pausedUntil)。
 *
 * M1 只定义此字段 + 默认值。M2 在 gateProactive 里据此决定是否跳过忙时调制。
 */
export type ActivityCaptureMode = "gentle" | "scheduled";

/**
 * 活动捕获子配置(进 ProactiveConfig.activityCapture)。
 *
 * 语义继承:
 *   - enabled:活动捕获总开关(默认关,用户主动开启);工作时段沿用 reminder.workStart/workEnd。
 *   - intervalMin:提醒间隔(分钟),继承 reminder.intervalMin 的语义(默认 120)。
 *   - activityCaptureMode:策略档 — 随克制(默认)/ 按时硬提醒(M2 在 gate 实施)。
 *
 * ⚠️ 工作时段(workStart/workEnd)和 pausedUntil 不在本子配置里 — 它们是全局唯一真相源
 *    (reminder.workStart/workEnd + gateState.pausedUntil),不重复存以防漂移。
 *    shouldRunActivityCapture 由调用方注入这两个值(ActivityCaptureRunConfig)。
 */
export interface ActivityCaptureConfig {
  /** 活动捕获总开关(默认 false,用户主动开启) */
  enabled: boolean;
  /** 提醒间隔(分钟),继承 reminder 语义 */
  intervalMin: number;
  /** 策略档:随克制(gentle)/ 按时硬提醒(scheduled) */
  activityCaptureMode: ActivityCaptureMode;
}

/** 主动姿态完整配置(进 SettingsState.proactive) */
export interface ProactiveConfig {
  /** 懒人三档 */
  mode: ProactiveMode;
  /** 心跳/巡检间隔(分钟) */
  heartbeatMin: number;
  /** 晨间简报触发小时(0-23) */
  morningHour: number;
  /** 每半天打扰预算上限 */
  budgetPerHalfDay: number;
  /** 投递渠道 */
  channel: ProactiveChannel;
  /** 四类事件触发开关 */
  events: ProactiveEvents;
  /**
   * 活动捕获子配置(定时提醒×主动提醒全合 M1)。
   * 包含:开关 / 间隔 / 策略档。工作时段 + pausedUntil 沿用全局唯一真相源,不在此重复。
   */
  activityCapture: ActivityCaptureConfig;
}

/** 活动捕获子配置默认值 */
export function defaultActivityCaptureConfig(): ActivityCaptureConfig {
  return {
    enabled: false, // 默认关闭,用户主动开启,避免一上来就双重打扰
    intervalMin: DEFAULT_ACTIVITY_CAPTURE_INTERVAL_MIN,
    activityCaptureMode: "gentle",
  };
}

/** 某档位映射出的基础行为(modeDefaults 的产物) */
export interface ModeDefaults {
  /** 总闸:是否启用主动(off=false) */
  enabled: boolean;
  /** 该档对应的优先级地板基准 */
  priorityFloor: number;
}

/**
 * resolveProactiveStance 的产物:把 config「拍平」成 3.7/闸门/投递可直接消费的生效姿态。
 * = modeDefaults(总闸 + 地板)+ config 透传的具体阈值/开关。
 */
export interface ProactiveStance {
  /** 总闸:false 时 3.7 整轮不跑主动巡检 */
  enabled: boolean;
  /** 优先级地板(给 gateProactive.opts.priorityFloor) */
  priorityFloor: number;
  /** 心跳间隔(分钟) */
  heartbeatMin: number;
  /** 晨报小时 */
  morningHour: number;
  /** 半天打扰预算 */
  budgetPerHalfDay: number;
  /** 投递渠道 */
  channel: ProactiveChannel;
  /** 事件开关 */
  events: ProactiveEvents;
}

// ─── 默认配置(给 settings.defaults() 复用) ───────────────────────────────────

/** 默认主动配置:温和(gentle)、晨报 07:00、渠道仅聊天、四类事件全开、活动捕获默认关 */
export function defaultProactiveConfig(): ProactiveConfig {
  return {
    mode: "gentle",
    heartbeatMin: DEFAULT_HEARTBEAT_MIN,
    morningHour: DEFAULT_MORNING_HOUR,
    budgetPerHalfDay: DEFAULT_BUDGET_PER_HALF_DAY,
    channel: "chat",
    events: {
      meetingSoon: true,
      deadlineNear: true,
      taskStuck: true,
      justCompleted: true,
    },
    activityCapture: defaultActivityCaptureConfig(),
  };
}

// ─── 纯函数:三档 → 基础行为 ──────────────────────────────────────────────────

/**
 * 懒人三档 → 基础行为(总闸 + 优先级地板)。纯函数。
 *
 * @param mode 三档
 */
export function modeDefaults(mode: ProactiveMode): ModeDefaults {
  switch (mode) {
    case "off":
      return { enabled: false, priorityFloor: PROACTIVE_FLOOR_GENTLE };
    case "active":
      return { enabled: true, priorityFloor: PROACTIVE_FLOOR_ACTIVE };
    case "gentle":
    default:
      return { enabled: true, priorityFloor: PROACTIVE_FLOOR_GENTLE };
  }
}

// ─── 纯函数:config → 生效姿态 ────────────────────────────────────────────────

/**
 * 把 ProactiveConfig 拍平成生效姿态:档位决定总闸 + 地板,其余字段透传。
 *
 * 给 3.7 接线层:据 stance.enabled 决定是否巡检,据 priorityFloor / budgetPerHalfDay
 * 构造 gateProactive 的 opts,据 events 过滤候选,据 channel 投递。
 *
 * ⚠️ 纯函数:不读 store / Date.now();只认入参 config。
 *
 * @param config 主动配置
 */
export function resolveProactiveStance(config: ProactiveConfig): ProactiveStance {
  const base = modeDefaults(config.mode);
  return {
    enabled: base.enabled,
    priorityFloor: base.priorityFloor,
    heartbeatMin: config.heartbeatMin,
    morningHour: config.morningHour,
    budgetPerHalfDay: config.budgetPerHalfDay,
    channel: config.channel,
    events: { ...config.events },
  };
}
