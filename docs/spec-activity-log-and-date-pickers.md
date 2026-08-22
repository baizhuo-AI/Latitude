# Daybreak Spec:间歇式时间日志 + 日期选择器改造

> ⚠️ **文档状态：historical（已实现，口径可能过期）**
> 本文描述的是 Latitude 早期（Daybreak 时期）的设计与实现，**不是当前产品规范**。
> 当前权威：[产品总纲](specs/2026-08-20-dimension-master-prd.md) · [工程实施计划](plans/2026-08-20-dimension-implementation-plan.md)。
> 保留原因：其中的实现细节与踩坑记录仍对工程有效。

> 状态:待评审 / 实现前
> 技术栈:Tauri 2 + React 18 + Vite + Tailwind + zustand + SQLite(`tauri-plugin-sql`)
> 范围:两个独立功能,可分别交付。**建议日期改造先行**(纯前端、零依赖),时间日志后做(末尾涉及系统通知插件 + 一次重启)。

---

# 需求一:间歇式时间日志(Activity Log)

## 问题陈述
Daybreak 目前只记录「计划」(todos),不记录「实际做了什么」——日程上排了什么,不代表真的做了。计划与执行脱节,导致反思(Reflect)只能基于计划臆测。需要一个低成本方式:定时打断用户、记一句「刚才在做什么」,积累真实活动流水。

## 目标
1. 工作时段内被周期性提醒,**30 秒内**能记完一条「刚才做了什么」。
2. 记录带时间戳、本地持久化,形成可回看的**当日活动流水**。
3. 提醒强度可控(间隔可调、可暂停),不至于因打扰被关掉。

## 非目标(v1 明确不做)
1. **不接入 AI**:本期只做记录与回看,不喂 Reflect/Briefing(已确认)。架构预留,后期再接。
2. **不做跨天统计/图表**:只展示当日流水,不做周报、时间饼图。
3. **不做与 todo 的自动关联**:记录是自由文本,不强制挂到某条 todo。
4. **不保证 app 关闭时提醒**:见技术设计,后台常驻提醒成本高,v1 依赖 app 运行。

## 用户故事
- 作为使用者,我希望每隔一段时间被提醒「刚才在干嘛」,这样能积累真实时间去向,不用自己记得回来记。
- 作为使用者,我希望提醒能用浮窗或系统通知、且能在设置里选,这样按自己习惯接收。
- 作为使用者,我希望能调间隔、临时暂停,这样忙的时候不被打断。
- 作为使用者,我希望看到今天已经记了哪些,这样对一天的时间去向有概览。

## 需求与验收

### P0(没有就不成立)
- **定时提醒**:按设置间隔,在工作时段内触发。
  - Given 开启提醒、间隔 2h、在工作时段;When 距上次提醒满 2h;Then 触发一次提醒(浮窗浮现 / 系统通知,按设置)。
  - Given 当前不在工作时段;Then 不提醒。
- **记录填写**:提醒后输入一句话保存,带自动时间戳。
  - Given 提醒触发、浮窗进入「记录态」;When 输入文本并提交;Then 写入 `activity_log`,清空输入,回常态。
- **持久化 + 回看**:记录存 SQLite;浮窗能看当日流水。
- **设置项**:开关、间隔(默认 120min、可自定义)、提醒方式(浮窗/通知/两者)、工作时段(默认 9–22)。
- **控制**:能临时暂停(暂停 N 小时 / 暂停到今天结束)。

### P1(快速跟进)
- 漏填提示:上一格没填,下次提醒带一句「上一格漏填了」。
- 浮窗当日流水支持删除/编辑单条。
- 通知点击直达浮窗记录态。

### P2(预留,不做但别挡路)
- 接入 Reflect:`activity_log` 作为真实素材喂 AI 复盘 → **所以表结构带时间戳、结构化存**。
- 历史回看 / 简单统计。

## 技术设计

**数据层**(`src/lib/db.ts` + 新 store)
- 新表 `activity_log(id TEXT PK, content TEXT, created_at TEXT)`,`CREATE TABLE IF NOT EXISTS`(与现有 todos/goals 一致)。
- db 函数:`dbInsertActivity` / `dbListActivities(sinceDateKey?)` / `dbDeleteActivity`。
- 新 zustand store(或并入现有):add/list/remove + hydrate。跨窗口同步复用 `syncBus`,新增 topic `"activities"`。

**设置项**(`src/lib/settings.ts` + `SettingsPage.tsx`)
- 配置结构:`reminder: { enabled, intervalMin, channel: "floating"|"notification"|"both", workStart, workEnd, pausedUntil? }`。
- 沿用现有 settings 持久化机制。

**提醒调度**(新 `src/lib/reminder.ts` 或 hook)
- ⚠️ **只在主窗口跑一份定时器**(避免主窗口 + 浮窗各跑一个 interval 重复提醒):仅当当前不是 floating hash 时启动。
- 每分钟 tick,判断「距上次提醒 ≥ intervalMin」且「在工作时段」且「未暂停」→ 触发。
- 上次提醒时间存 localStorage(防重启丢)。

**触发动作**
- 浮窗:`WebviewWindow.getByLabel("floating").show()`(权限已具备),通过 syncBus / Tauri 事件让浮窗切到「记录态」(顶部输入提示变「刚才在做什么?」)。
- 系统通知:`@tauri-apps/plugin-notification` 的 `sendNotification`;点击通知唤起浮窗记录态。

**浮窗「记录态」**(`src/pages/FloatingApp.tsx`)
- ⚠️ 浮窗现有输入框是「记待办」(走 `parseTask` → `addTodo`)。记录态要**区分开**:加模式标识,记录态提交走 `addActivity` 而非 addTodo,提示文案不同,**不污染记待办逻辑**。
- 浮窗加「今日活动流水」区(可折叠),列出当日 `activity_log`。

**系统通知依赖**(最后一步,需重启)
- npm 装 `@tauri-apps/plugin-notification`;Cargo 装 `tauri-plugin-notification`;`lib.rs` 注册插件。
- capability `default.json` 加 `notification:default`。
- 首次运行申请 macOS 通知授权(`requestPermission`)。

## 实现路径(前 5 步纯前端、免重启;第 6 步重启一次)
1. **数据层**:建表 + 读写函数 + store。验收:能 add 一条并读回。
2. **设置项**:reminder 配置 + SettingsPage UI。验收:改设置能持久化、刷新仍在。
3. **提醒调度**:定时器(仅主窗口),按设置触发提醒事件(先只 console / 浮窗,不接通知)。验收:间隔调 1min 能按时触发,切非工作时段不触发。
4. **浮窗记录态 + 触发浮窗**:提醒触发 → 浮窗 show + 进记录态;提交存 `activity_log`。验收:到点浮窗自动浮现、记一条、存库。
5. **今日流水回看**:浮窗加当日流水区。验收:记的能立刻出现。
6. **系统通知**:装插件 + Cargo + capability + 注册 + 申请权限,重启;接通「通知/两者」。验收:到点弹系统通知,点击唤起浮窗记录态。

## 风险
- **打扰感**[体验/高]:间隔太短易被嫌烦关掉 → 默认 2h + 一键暂停 + 工作时段限制。
- **重复提醒**[实现/中]:主窗口 + 浮窗各跑定时器会双弹 → 调度只在主窗口起一份。
- **可靠性**[实现/中]:纯前端定时器仅 app 开着有效 → v1 明确非目标;后台提醒需 Rust 定时,后期评估。
- **记待办 vs 记活动混淆**[体验/中]:浮窗两种输入共存易乱 → 记录态独立标识与文案,默认态仍是记待办。

---

# 需求二:日期填写改为选择器

## 问题陈述
当前所有日期/时间都是手敲文本框,易格式不一致、敲错——尤其 `scheduledTime` 的 `"09:30-11:00"` 一旦格式错,日历/早安/浮窗的 `parseScheduledTime` 解析全失败。改成点选,降低出错、提升填写速度。

## 目标
1. 三处日期/时间填写改点选,消除手敲格式错误。
2. `scheduledTime` 改造后**输出格式不变**,日历/早安/浮窗解析不受影响。
3. deadline 兼顾「精确选某天」与「今天/明天/本周五/下周一」快捷。

## 非目标
1. **不引第三方日期库**:用原生 `type="date"`/`type="time"` + 自定义快捷按钮,零依赖(已确认)。
2. **deadline 不做到时:分**:v1 只到「天」(已确认),时间精度后补。
3. **不迁移老数据**:老 deadline 的自然语言(「下周一」)原样保留显示,不批量转标准日期。
4. **不改 AI 解析路径**:TopBar ⌘K 的自然语言解析照旧,本次只动手填表单。

## 用户故事
- 作为使用者,我希望填目标截止 / 待办截止 / 执行时段时是点选不是打字,这样不会写错格式、也更快。
- 作为使用者,我希望填待办截止时,既能点日历选具体某天,也能一键选「明天/本周五」,常见情况更快。

## 需求与验收

### P0
- **Telos 目标日期**:换原生日期选择器。
  - Given 在 Telos 新建目标;When 点目标日期;Then 弹原生日历,选中存 `"YYYY-MM-DD"`,列表展示。
- **待办时段 `scheduledTime`**:开始 + 结束两个时间选择器。
  - Given 填时段;When 选开始 09:30、结束 11:00;Then 存 `"09:30-11:00"`;When 结束 ≤ 开始;Then 阻止/提示。
  - ⚠️ 输出严格 `HH:MM-HH:MM`,`parseScheduledTime` 必须能解析。
- **待办截止 `deadline`**:日历选择器 + 快捷按钮(今天/明天/本周五/下周一)。
  - Given 新建待办;When 点「本周五」;Then deadline 设为本周五 `"YYYY-MM-DD"`;When 日历选某天;Then 设为该天。

### P1
- deadline 加「清除」(选了能取消)。
- 时段选择支持 15 分钟吸附(与拖拽排期一致)。

### P2
- deadline 精确到时:分(datetime)。
- 老数据自然语言 → 标准日期的一次性迁移。

## 技术设计

**Telos 目标日期**(`src/pages/TelosPage.tsx`)
- 现 `targetDate` 是文本 input(纯展示、不被解析)→ 直接换 `<input type="date">`,绑 `"YYYY-MM-DD"`。**零连锁影响**。

**待办时段 `scheduledTime`**(`src/components/NewTaskModal.tsx`)
- 现是文本 input `"09:30-11:00"` → 改两个 `<input type="time">`(start/end),提交拼 `${start}-${end}`。
- 提交前用 `parseScheduledTime` **自校验**(end > start、格式合法),不通过不让存。
- 影响面已确认:`CalendarPage` / `BriefingPage` / `FloatingApp` 都靠 `parseScheduledTime`,格式不变即不受影响。

**待办截止 `deadline`**(`src/components/NewTaskModal.tsx`)
- `<input type="date">`(日历)+ 一排快捷 chip:今天 / 明天 / 本周五 / 下周一。
- 快捷词用现成 `src/lib/calendar.ts`:今天=`dateKey(new Date())`;明天=`dateKey(addDays(now,1))`;本周五=`startOfWeek` 推周五;下周一=`addDays(startOfWeek(now),7)`。
- 存储:`Todo.deadline` 改存 `"YYYY-MM-DD"`。**新老混存**:老数据自然语言,显示层判断「能否解析为日期」,标准日期友好格式化、自然语言原样输出。
- 排序:`TodosPage` 现按 deadline 字符串假排序;标准日期后可做真日期排序(P1)。

## 实现路径(纯前端、免重启,热更新即时看)
1. **Telos 目标日期** → `type="date"`。最快、零风险,先做以验证控件风格。
2. **待办时段** → 双 `type="time"` + 拼接 + `end>start` 校验。验收:选出的时段在日历周视图正确定位。
3. **待办 deadline** → `type="date"` + 快捷 chip(复用 calendar.ts 算日期)。验收:点「本周五」填入正确日期;日历选生效;老数据仍正常显示。
4. **显示兼容**:检查 deadline 展示处,标准日期友好格式化、自然语言原样显示。
5. (P1 可选)TodosPage deadline 真日期排序。

## 风险
- **`scheduledTime` 格式破坏**[实现/高]:拼接没拼成 `HH:MM-HH:MM` 或带秒 → 全线解析失败。缓解:提交前 `parseScheduledTime` 自校验,不通过不让存。
- **deadline 新老混存**[实现/中]:显示/排序需兼容两种格式。缓解:显示层判断能否解析为日期,否则原样。
- **原生控件风格**[体验/低]:macOS WebKit 的 date/time input 偏系统化,与设计系统不完全统一。缓解:CSS 可调到基本一致;要完美统一才考虑引库(当前非目标)。

---

# 统一实现顺序与里程碑

| 阶段 | 内容 | 重启 | 价值 |
|---|---|---|---|
| **M1** | 日期改造全 3 处 | 否 | 立即降低填写出错,见效最快 |
| **M2** | 时间日志 P0 前 5 步(数据/设置/调度/浮窗记录/回看) | 否 | 核心闭环可用(浮窗提醒) |
| **M3** | 时间日志系统通知 | 是(1 次) | app 失焦也能提醒 |

按 **M1 → M2 → M3**,把唯一一次重启(系统通知插件)放最后,中间一路热更新。

# 开放问题
- [产品] 漏填提示(P1)要不要进 v1?(你之前说「做到第 3 步前告诉我」)
- [产品] 暂停粒度:暂停 1h / 暂停到今天结束 / 两者都给?
- [产品] deadline 老数据(种子里的「下周一」)要不要这次顺手转标准日期?当前按「不迁移」。
- [设计] 浮窗「今日流水」放浮窗(空间紧)还是主 App 某页也有入口?
