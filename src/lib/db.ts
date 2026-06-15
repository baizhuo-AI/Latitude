import Database from "@tauri-apps/plugin-sql";
import type { Todo, Priority, TodoStatus } from "./store";

/**
 * SQLite 单例
 *
 * 数据库位置:Tauri 默认 AppData 目录下的 daybreak.db
 *  - macOS: ~/Library/Application Support/com.apple.todo-floating-panel/daybreak.db
 *
 * Schema 迁移策略:
 *  - V1: CREATE TABLE IF NOT EXISTS(初始表)
 *  - V2+: ALTER TABLE ADD COLUMN,用 try/catch 兜底("duplicate column name" 忽略)
 *
 * 加新列时:把语句追加到 migrate() 末尾,旧库会执行 ALTER,新库 IF NOT EXISTS 路径自带新列。
 */

let _db: Database | null = null;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  reason TEXT,
  deadline TEXT,
  priority TEXT NOT NULL DEFAULT 'none',
  tags TEXT NOT NULL DEFAULT '[]',
  est_time TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  scheduled_time TEXT,
  scheduled_date TEXT,
  is_pushback INTEGER NOT NULL DEFAULT 0,
  is_procrastinated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
CREATE INDEX IF NOT EXISTS idx_todos_scheduled_date ON todos(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_todos_created_at ON todos(created_at);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  period TEXT NOT NULL,
  target_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_goals_period ON goals(period);
CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conv_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  reasoning_content TEXT,
  usage_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conv_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, created_at);

CREATE TABLE IF NOT EXISTS reflections (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  period TEXT NOT NULL,
  content TEXT NOT NULL,
  mood_tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reflections_date ON reflections(date, period);

CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  feature TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_created_at ON llm_usage(created_at);

CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_created_at ON activity_log(created_at);

CREATE TABLE IF NOT EXISTS field_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id                    TEXT PRIMARY KEY,
  region                TEXT NOT NULL,
  calendar_id           TEXT NOT NULL,
  remote_event_id       TEXT NOT NULL,
  title                 TEXT NOT NULL DEFAULT '',
  description           TEXT,
  location              TEXT,
  is_all_day            INTEGER NOT NULL DEFAULT 0,
  start_ts              INTEGER,
  end_ts                INTEGER,
  timezone              TEXT,
  scheduled_date        TEXT,
  scheduled_time        TEXT,
  status                TEXT NOT NULL DEFAULT 'confirmed',
  is_recurring_instance INTEGER NOT NULL DEFAULT 0,
  recurrence_master_id  TEXT,
  instance_start_iso    TEXT,
  calendar_name         TEXT,
  is_writable           INTEGER NOT NULL DEFAULT 0,
  local_draft           INTEGER NOT NULL DEFAULT 0,
  etag                  TEXT,
  freshness             INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cal_events_sched_date ON calendar_events(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_cal_events_calendar ON calendar_events(calendar_id);
CREATE INDEX IF NOT EXISTS idx_cal_events_status ON calendar_events(status);

CREATE TABLE IF NOT EXISTS event_map (
  id              TEXT PRIMARY KEY,
  region          TEXT NOT NULL,
  calendar_id     TEXT NOT NULL,
  remote_event_id TEXT NOT NULL,
  dedup_key       TEXT NOT NULL,
  local_id        TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_event_map_dedup ON event_map(region, calendar_id, dedup_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_map_local ON event_map(local_id);

CREATE TABLE IF NOT EXISTS sync_state (
  region          TEXT NOT NULL,
  calendar_id     TEXT NOT NULL,
  sync_token      TEXT,
  last_synced_at  TEXT,
  status          TEXT NOT NULL DEFAULT 'idle',
  last_error      TEXT,
  is_writable     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (region, calendar_id)
);

CREATE TABLE IF NOT EXISTS calendar_meta (
  region          TEXT NOT NULL,
  calendar_id     TEXT NOT NULL,
  summary         TEXT,
  cal_type        TEXT,
  access_role     TEXT,
  is_deleted      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (region, calendar_id)
);

CREATE TABLE IF NOT EXISTS calendar_change_queue (
  id              TEXT PRIMARY KEY,
  op              TEXT NOT NULL,
  local_id        TEXT NOT NULL,
  calendar_id     TEXT NOT NULL,
  remote_event_id TEXT,
  payload_json    TEXT NOT NULL,
  base_etag       TEXT,
  state           TEXT NOT NULL DEFAULT 'pending',
  retry_count     INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_change_queue_state ON calendar_change_queue(state);

CREATE TABLE IF NOT EXISTS daily_digest (
  date       TEXT PRIMARY KEY,
  summary    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

/**
 * 查表的列名集合(用 SQLite 的 pragma_table_info 虚表)
 * 比 try/catch + ALTER 更可靠,因为 plugin-sql 对 ALTER 失败的报错信息不一定包含 "duplicate column name"
 */
async function getColumns(db: Database, table: string): Promise<Set<string>> {
  const rows = await db.select<Array<{ name: string }>>(
    "SELECT name FROM pragma_table_info($1)",
    [table]
  );
  return new Set(rows.map((r) => r.name));
}

async function migrate(db: Database): Promise<void> {
  // V1: 创建表(IF NOT EXISTS)
  for (const stmt of SCHEMA_V1.split(";").map((s) => s.trim()).filter(Boolean)) {
    await db.execute(stmt);
  }
  // V2: scheduled_date 列(旧库 P1 初版没有这列,新库 V1 已带)
  const todoCols = await getColumns(db, "todos");
  if (!todoCols.has("scheduled_date")) {
    await db.execute("ALTER TABLE todos ADD COLUMN scheduled_date TEXT");
    console.info("[db] migrated: added scheduled_date column");
  }
  // V3: messages 加 reasoning_content(推理模型的思考过程持久化)
  const msgCols = await getColumns(db, "messages");
  if (msgCols.size > 0 && !msgCols.has("reasoning_content")) {
    await db.execute("ALTER TABLE messages ADD COLUMN reasoning_content TEXT");
    console.info("[db] migrated: added reasoning_content column");
  }
  // V5: todos 加 custom_fields（自定义字段值，JSON 格式）
  if (!todoCols.has("custom_fields")) {
    await db.execute(
      "ALTER TABLE todos ADD COLUMN custom_fields TEXT NOT NULL DEFAULT '{}'"
    );
    console.info("[db] migrated: added todos.custom_fields column");
  }
  // V4: calendar_events 加 freshness（乱序守卫用的可比新鲜度，与 etag 字符串列分离：
  // etag 留给 Phase 4 冲突检测，freshness 专做增量乱序的"谁更新"比较）
  const calCols = await getColumns(db, "calendar_events");
  if (calCols.size > 0 && !calCols.has("freshness")) {
    await db.execute(
      "ALTER TABLE calendar_events ADD COLUMN freshness INTEGER NOT NULL DEFAULT 0"
    );
    console.info("[db] migrated: added calendar_events.freshness column");
  }
  // V6: todos 加 completed_at（完成时刻，喂"今日完成事项"同步到飞书表）
  if (!todoCols.has("completed_at")) {
    await db.execute("ALTER TABLE todos ADD COLUMN completed_at TEXT");
    console.info("[db] migrated: added todos.completed_at column");
  }
  // V7: daily_digest 表（AI 秘书每日纪要，Task 1.3）
  // 老库通过 V1 的 IF NOT EXISTS 已建表；新库 V1 路径直接带。这里无需 ALTER，仅记录版本号。
}

export async function getDb(): Promise<Database> {
  if (_db) return _db;
  _db = await Database.load("sqlite:daybreak.db");
  await migrate(_db);
  return _db;
}

/* ---------- 事务封装 ---------- */

/**
 * 在一个传入的 db 上跑事务（抽出 db 参数版，便于单测）。
 *
 * 关键事实：@tauri-apps/plugin-sql 的 Database 只有 execute/select，**没有 transaction()**，
 * 所以这里手写 BEGIN/COMMIT，出错 ROLLBACK 后把原错误重抛。
 *
 * 注意:SQLite 不支持嵌套事务,fn 内部不要再调 dbTx/runInTransaction。
 * ROLLBACK 自身失败(连接已坏等)被吞掉,但保证重抛的始终是 fn 抛出的原始错误。
 */
export async function runInTransaction(
  db: Database,
  fn: (db: Database) => Promise<void>
): Promise<void> {
  await db.execute("BEGIN");
  try {
    await fn(db);
    await db.execute("COMMIT");
  } catch (e) {
    try {
      await db.execute("ROLLBACK");
    } catch {
      // ROLLBACK 失败也不能盖掉原始错误,忽略它继续往下重抛 e
    }
    throw e;
  }
}

/** 取单例 db 跑事务。批量写 + token 推进同事务靠这个落地。 */
export async function dbTx(fn: (db: Database) => Promise<void>): Promise<void> {
  return runInTransaction(await getDb(), fn);
}

/* ---------- Row 类型 + 转换 ---------- */

interface TodoRow {
  id: string;
  title: string;
  reason: string | null;
  deadline: string | null;
  priority: string;
  tags: string;
  est_time: string | null;
  status: string;
  scheduled_time: string | null;
  scheduled_date: string | null;
  is_pushback: number;
  is_procrastinated: number;
  custom_fields: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function rowToTodo(row: TodoRow): Todo {
  let customFields: Record<string, string | string[]> | undefined;
  try {
    const parsed = JSON.parse(row.custom_fields ?? "{}");
    if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
      customFields = parsed;
    }
  } catch { /* ignore */ }
  return {
    id: row.id,
    title: row.title,
    reason: row.reason ?? undefined,
    deadline: row.deadline ?? undefined,
    priority: row.priority as Priority,
    tags: safeJsonParseArray(row.tags),
    estTime: row.est_time ?? undefined,
    status: row.status as TodoStatus,
    scheduledTime: row.scheduled_time ?? undefined,
    scheduledDate: row.scheduled_date ?? undefined,
    isPushBackSuggestion: row.is_pushback === 1,
    isProcrastinated: row.is_procrastinated === 1,
    createdAt: row.created_at,
    customFields,
    completedAt: row.completed_at ?? undefined,
  };
}

function safeJsonParseArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/* ---------- CRUD ---------- */

export async function dbListTodos(): Promise<Todo[]> {
  const db = await getDb();
  const rows = await db.select<TodoRow[]>(
    "SELECT * FROM todos ORDER BY created_at DESC"
  );
  return rows.map(rowToTodo);
}

/**
 * 列出某本地日期"完成"的 todo（status='done' 且 completed_at 落在该日）。
 * 喂"把今日完成事项同步到飞书表"。
 *
 * 时区口径：completed_at 存 UTC ISO，这里按 dateKey 的 [T00:00:00, T23:59:59.999]
 * 字符串区间比较，与 dbListActivities 保持一致（接受 UTC 边界近似，换取两个数据源同口径）。
 * dateKey 由前端按本地时区算（YYYY-MM-DD）。
 */
export async function dbListTodosCompletedOn(dateKey: string): Promise<Todo[]> {
  const db = await getDb();
  const rows = await db.select<TodoRow[]>(
    `SELECT * FROM todos
     WHERE status = 'done'
       AND completed_at >= $1 AND completed_at < $2
     ORDER BY completed_at DESC`,
    [`${dateKey}T00:00:00`, `${dateKey}T23:59:59.999`]
  );
  return rows.map(rowToTodo);
}

export async function dbInsertTodo(todo: Todo): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.execute(
    `INSERT INTO todos
      (id, title, reason, deadline, priority, tags, est_time, status,
       scheduled_time, scheduled_date, is_pushback, is_procrastinated,
       custom_fields, created_at, updated_at, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      todo.id,
      todo.title,
      todo.reason ?? null,
      todo.deadline ?? null,
      todo.priority,
      JSON.stringify(todo.tags ?? []),
      todo.estTime ?? null,
      todo.status,
      todo.scheduledTime ?? null,
      todo.scheduledDate ?? null,
      todo.isPushBackSuggestion ? 1 : 0,
      todo.isProcrastinated ? 1 : 0,
      JSON.stringify(todo.customFields ?? {}),
      todo.createdAt ?? now,
      now,
      // 插入即 done 时记完成时刻；否则空。done↔completed_at 不变式由写入层统一维护
      todo.status === "done" ? (todo.completedAt ?? now) : null
    ]
  );
}

export async function dbUpdateTodoStatus(
  id: string,
  status: TodoStatus
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  // 维护 done↔completed_at 不变式：变 done 时若无完成时刻则记 now（已有则保留，避免重复标 done 刷新），
  // 变其它状态清空。
  await db.execute(
    `UPDATE todos SET status = $1, updated_at = $2,
       completed_at = CASE WHEN $1 = 'done' THEN COALESCE(completed_at, $2) ELSE NULL END
     WHERE id = $3`,
    [status, now, id]
  );
}

export async function dbUpdateTodoSchedule(
  id: string,
  scheduledDate: string | null,
  scheduledTime: string | null
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE todos SET scheduled_date = $1, scheduled_time = $2, updated_at = $3 WHERE id = $4",
    [scheduledDate, scheduledTime, new Date().toISOString(), id]
  );
}

export async function dbUpdateTodo(todo: Todo): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE todos SET
      title = $1, reason = $2, deadline = $3, priority = $4, tags = $5,
      est_time = $6, status = $7, scheduled_time = $8, scheduled_date = $9,
      is_pushback = $10, is_procrastinated = $11, custom_fields = $12, updated_at = $13,
      completed_at = CASE WHEN $7 = 'done' THEN COALESCE(completed_at, $13) ELSE NULL END
     WHERE id = $14`,
    [
      todo.title,
      todo.reason ?? null,
      todo.deadline ?? null,
      todo.priority,
      JSON.stringify(todo.tags ?? []),
      todo.estTime ?? null,
      todo.status,
      todo.scheduledTime ?? null,
      todo.scheduledDate ?? null,
      todo.isPushBackSuggestion ? 1 : 0,
      todo.isProcrastinated ? 1 : 0,
      JSON.stringify(todo.customFields ?? {}),
      new Date().toISOString(),
      todo.id
    ]
  );
}

export async function dbDeleteTodo(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM todos WHERE id = $1", [id]);
}

/**
 * 一次性把 P1 mock 数据塞进去(只在表为空时调用,做个种子数据)
 */
export async function dbSeedIfEmpty(seeds: Todo[]): Promise<void> {
  const db = await getDb();
  const rows = await db.select<{ c: number }[]>(
    "SELECT COUNT(*) as c FROM todos"
  );
  const count = rows[0]?.c ?? 0;
  if (count > 0) return;
  for (const t of seeds) {
    await dbInsertTodo(t);
  }
}

/* ---------- Field Definitions ---------- */

export interface FieldDefinitionRow {
  id: string;
  name: string;
  type: string;
  options: string;
  sort_order: number;
  created_at: string;
}

export interface FieldDefinition {
  id: string;
  name: string;
  type: "single_select" | "multi_select";
  options: { id: string; label: string; color: string }[];
  sortOrder: number;
  createdAt: string;
}

function rowToField(row: FieldDefinitionRow): FieldDefinition {
  let options: FieldDefinition["options"] = [];
  try {
    options = JSON.parse(row.options);
  } catch { /* ignore */ }
  return {
    id: row.id,
    name: row.name,
    type: row.type as FieldDefinition["type"],
    options,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

export async function dbListFields(): Promise<FieldDefinition[]> {
  const db = await getDb();
  const rows = await db.select<FieldDefinitionRow[]>(
    "SELECT * FROM field_definitions ORDER BY sort_order ASC, created_at ASC"
  );
  return rows.map(rowToField);
}

export async function dbInsertField(field: FieldDefinition): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO field_definitions (id, name, type, options, sort_order, created_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      field.id,
      field.name,
      field.type,
      JSON.stringify(field.options),
      field.sortOrder,
      field.createdAt,
    ]
  );
}

export async function dbUpdateField(field: FieldDefinition): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE field_definitions SET name=$1, type=$2, options=$3, sort_order=$4 WHERE id=$5`,
    [field.name, field.type, JSON.stringify(field.options), field.sortOrder, field.id]
  );
}

export async function dbDeleteField(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM field_definitions WHERE id = $1", [id]);
}

export async function dbClearFieldFromTodos(fieldId: string): Promise<void> {
  const db = await getDb();
  const rows = await db.select<{ id: string; custom_fields: string }[]>(
    "SELECT id, custom_fields FROM todos WHERE custom_fields LIKE $1",
    [`%${fieldId}%`]
  );
  for (const row of rows) {
    try {
      const cf = JSON.parse(row.custom_fields);
      delete cf[fieldId];
      await db.execute(
        "UPDATE todos SET custom_fields = $1, updated_at = $2 WHERE id = $3",
        [JSON.stringify(cf), new Date().toISOString(), row.id]
      );
    } catch { /* ignore */ }
  }
}

export async function dbClearOptionFromTodos(fieldId: string, optionId: string): Promise<void> {
  const db = await getDb();
  const rows = await db.select<{ id: string; custom_fields: string }[]>(
    "SELECT id, custom_fields FROM todos WHERE custom_fields LIKE $1",
    [`%${optionId}%`]
  );
  for (const row of rows) {
    try {
      const cf = JSON.parse(row.custom_fields);
      const val = cf[fieldId];
      if (val === optionId) {
        delete cf[fieldId];
      } else if (Array.isArray(val)) {
        cf[fieldId] = val.filter((v: string) => v !== optionId);
        if (cf[fieldId].length === 0) delete cf[fieldId];
      }
      await db.execute(
        "UPDATE todos SET custom_fields = $1, updated_at = $2 WHERE id = $3",
        [JSON.stringify(cf), new Date().toISOString(), row.id]
      );
    } catch { /* ignore */ }
  }
}

/* ---------- Goals ---------- */

export type GoalPeriod = "year" | "quarter" | "month";
export type GoalStatus = "active" | "achieved" | "abandoned";

export interface Goal {
  id: string;
  title: string;
  description?: string;
  period: GoalPeriod;
  targetDate?: string;
  status: GoalStatus;
  createdAt: string;
}

interface GoalRow {
  id: string;
  title: string;
  description: string | null;
  period: string;
  target_date: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function rowToGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    period: row.period as GoalPeriod,
    targetDate: row.target_date ?? undefined,
    status: row.status as GoalStatus,
    createdAt: row.created_at
  };
}

export async function dbListGoals(): Promise<Goal[]> {
  const db = await getDb();
  const rows = await db.select<GoalRow[]>(
    "SELECT * FROM goals ORDER BY created_at DESC"
  );
  return rows.map(rowToGoal);
}

export async function dbInsertGoal(goal: Goal): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.execute(
    `INSERT INTO goals
      (id, title, description, period, target_date, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      goal.id,
      goal.title,
      goal.description ?? null,
      goal.period,
      goal.targetDate ?? null,
      goal.status,
      goal.createdAt ?? now,
      now
    ]
  );
}

export async function dbUpdateGoalStatus(
  id: string,
  status: GoalStatus
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "UPDATE goals SET status = $1, updated_at = $2 WHERE id = $3",
    [status, new Date().toISOString(), id]
  );
}

export async function dbDeleteGoal(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM goals WHERE id = $1", [id]);
}

/* ---------- Chat: conversations + messages ---------- */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessageRow {
  id: string;
  convId: string;
  role: ChatRole;
  content: string;
  /** 推理模型的思考过程(deepseek-reasoner 等) */
  reasoningContent?: string;
  /** 仅 assistant 消息有,记录这条消息消耗的 tokens(JSON 字符串) */
  usageJson?: string;
  createdAt: string;
}

export interface ConversationRow {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface ConvRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface MsgRow {
  id: string;
  conv_id: string;
  role: string;
  content: string;
  reasoning_content: string | null;
  usage_json: string | null;
  created_at: string;
}

export async function dbListConversations(): Promise<ConversationRow[]> {
  const db = await getDb();
  const rows = await db.select<ConvRow[]>(
    "SELECT * FROM conversations ORDER BY updated_at DESC"
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
}

export async function dbInsertConversation(conv: ConversationRow): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO conversations (id, title, created_at, updated_at) VALUES ($1,$2,$3,$4)`,
    [conv.id, conv.title, conv.createdAt, conv.updatedAt]
  );
}

export async function dbUpdateConversationTitle(
  id: string,
  title: string
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE conversations SET title = $1, updated_at = $2 WHERE id = $3`,
    [title, new Date().toISOString(), id]
  );
}

export async function dbTouchConversation(id: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE conversations SET updated_at = $1 WHERE id = $2`,
    [new Date().toISOString(), id]
  );
}

export async function dbDeleteConversation(id: string): Promise<void> {
  const db = await getDb();
  // messages 表有 FK CASCADE,但 SQLite 默认不启用 FK,显式删一下保险
  await db.execute("DELETE FROM messages WHERE conv_id = $1", [id]);
  await db.execute("DELETE FROM conversations WHERE id = $1", [id]);
}

export async function dbListMessages(convId: string): Promise<ChatMessageRow[]> {
  const db = await getDb();
  const rows = await db.select<MsgRow[]>(
    "SELECT * FROM messages WHERE conv_id = $1 ORDER BY created_at ASC",
    [convId]
  );
  return rows.map((r) => ({
    id: r.id,
    convId: r.conv_id,
    role: r.role as ChatRole,
    content: r.content,
    reasoningContent: r.reasoning_content ?? undefined,
    usageJson: r.usage_json ?? undefined,
    createdAt: r.created_at
  }));
}

export async function dbInsertMessage(msg: ChatMessageRow): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO messages (id, conv_id, role, content, reasoning_content, usage_json, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      msg.id,
      msg.convId,
      msg.role,
      msg.content,
      msg.reasoningContent ?? null,
      msg.usageJson ?? null,
      msg.createdAt
    ]
  );
}

export async function dbUpdateMessageContent(
  id: string,
  content: string,
  reasoningContent?: string,
  usageJson?: string
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE messages SET content = $1, reasoning_content = $2, usage_json = $3 WHERE id = $4`,
    [content, reasoningContent ?? null, usageJson ?? null, id]
  );
}

/* ---------- Reflections ---------- */

export type ReflectPeriod = "day" | "week";

export interface ReflectionRow {
  id: string;
  /** date 形如 "2026-05-11" 或 周 "2026-W19" */
  date: string;
  period: ReflectPeriod;
  content: string;
  moodTags: string[];
  createdAt: string;
}

interface ReflectRow {
  id: string;
  date: string;
  period: string;
  content: string;
  mood_tags: string;
  created_at: string;
}

function rowToReflection(r: ReflectRow): ReflectionRow {
  return {
    id: r.id,
    date: r.date,
    period: r.period as ReflectPeriod,
    content: r.content,
    moodTags: safeJsonParseArray(r.mood_tags),
    createdAt: r.created_at
  };
}

export async function dbListReflections(
  period: ReflectPeriod,
  limit = 20
): Promise<ReflectionRow[]> {
  const db = await getDb();
  const rows = await db.select<ReflectRow[]>(
    "SELECT * FROM reflections WHERE period = $1 ORDER BY date DESC LIMIT $2",
    [period, limit]
  );
  return rows.map(rowToReflection);
}

export async function dbUpsertReflection(rec: ReflectionRow): Promise<void> {
  const db = await getDb();
  // 同一 date+period 只保留最新一条:先删后插
  await db.execute(
    "DELETE FROM reflections WHERE date = $1 AND period = $2",
    [rec.date, rec.period]
  );
  await db.execute(
    `INSERT INTO reflections (id, date, period, content, mood_tags, created_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      rec.id,
      rec.date,
      rec.period,
      rec.content,
      JSON.stringify(rec.moodTags ?? []),
      rec.createdAt
    ]
  );
}

export async function dbDeleteReflection(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM reflections WHERE id = $1", [id]);
}

/* ---------- llm_usage ---------- */

export interface LlmUsageRecord {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** feature 标签:parseTask / generateTodayPlan / chat / reflect 等 */
  feature?: string;
}

export async function dbInsertUsage(rec: LlmUsageRecord): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO llm_usage
      (provider, model, prompt_tokens, completion_tokens, total_tokens, feature, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      rec.provider,
      rec.model,
      rec.promptTokens,
      rec.completionTokens,
      rec.totalTokens,
      rec.feature ?? null,
      new Date().toISOString()
    ]
  );
}

export async function dbUsageSummary(): Promise<{
  totalCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
}> {
  const db = await getDb();
  const rows = await db.select<
    Array<{
      calls: number | null;
      pt: number | null;
      ct: number | null;
      tt: number | null;
    }>
  >(
    `SELECT
       COUNT(*) AS calls,
       SUM(prompt_tokens) AS pt,
       SUM(completion_tokens) AS ct,
       SUM(total_tokens) AS tt
     FROM llm_usage`
  );
  const r = rows[0];
  return {
    totalCalls: r?.calls ?? 0,
    totalPromptTokens: r?.pt ?? 0,
    totalCompletionTokens: r?.ct ?? 0,
    totalTokens: r?.tt ?? 0
  };
}

/* ---------- Activity Log(间歇式时间日志) ---------- */

export interface ActivityRecord {
  id: string;
  content: string;
  /** ISO 时间戳 */
  createdAt: string;
}

interface ActivityRow {
  id: string;
  content: string;
  created_at: string;
}

export async function dbInsertActivity(rec: ActivityRecord): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT INTO activity_log (id, content, created_at) VALUES ($1,$2,$3)",
    [rec.id, rec.content, rec.createdAt]
  );
}

/**
 * 活动记录查询,按时间倒序。
 * 可选日期范围过滤(ISO 前缀匹配,如 "2026-06-12")。
 * 当日过滤交给前端(按本地时区 dateKey),避免 UTC 边界问题。
 */
export async function dbListActivities(
  limit = 100,
  opts?: { startDate?: string; endDate?: string }
): Promise<ActivityRecord[]> {
  const db = await getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (opts?.startDate) {
    conditions.push(`created_at >= $${idx}`);
    params.push(opts.startDate + "T00:00:00");
    idx++;
  }
  if (opts?.endDate) {
    conditions.push(`created_at < $${idx}`);
    params.push(opts.endDate + "T23:59:59.999");
    idx++;
  }
  const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);
  const rows = await db.select<ActivityRow[]>(
    `SELECT * FROM activity_log${where} ORDER BY created_at DESC LIMIT $${idx}`,
    params
  );
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    createdAt: r.created_at
  }));
}

export async function dbDeleteActivity(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM activity_log WHERE id = $1", [id]);
}

/* ---------- Calendar Events(飞书/Lark 同步来的日历事件) ---------- */

export type CalRegion = "feishu" | "lark";
export type CalEventStatus = "confirmed" | "cancelled";

/**
 * 同步来的日历事件(独立实体,不混 todos)。
 *
 * 字段语义(列名以 SCHEMA_V1 的 calendar_events 为准):
 * - startTs/endTs/timezone:定时事件原始 UTC 秒 + IANA 时区,保留供重新归一;全天为 null。
 * - scheduledDate/scheduledTime:归一产物,喂月/周视图(normalizeEventTiming 产出,
 *   格式契约见 calendar.ts 的 parseScheduledTime);全天 scheduledTime 为 null。
 * - status:'confirmed' | 'cancelled'(软删,cancelled 行不真删)。
 * - isRecurringInstance / recurrenceMasterId / instanceStartIso:重复事件三元组,
 *   去重键 dedup_key 的另一半(重复实例 = master_id + ':' + instanceStartIso)。
 * - isWritable:逐日历可写探测结果,冗余到事件行(前端按它 gate 编辑/分样式)。
 * - localDraft:冲突降级时的本地未推送草稿标记(Phase 4 用)。
 * - etag:远端版本号,冲突三态判定用。
 */
export interface CalendarEvent {
  id: string;
  region: CalRegion;
  calendarId: string;
  remoteEventId: string;
  title: string;
  description?: string;
  location?: string;
  isAllDay: boolean;
  startTs?: number;
  endTs?: number;
  timezone?: string;
  scheduledDate?: string;
  scheduledTime?: string;
  status: CalEventStatus;
  isRecurringInstance: boolean;
  recurrenceMasterId?: string;
  instanceStartIso?: string;
  calendarName?: string;
  isWritable: boolean;
  localDraft: boolean;
  etag?: string;
  createdAt: string;
  updatedAt: string;
}

/** 每日历一行的增量同步游标;列表级游标复用保留行 calendarId='__list__'。 */
export interface SyncStateRecord {
  region: CalRegion;
  calendarId: string;
  syncToken?: string;
  lastSyncedAt?: string;
  status: string; // 'idle' | 'syncing' | 'error'
  lastError?: string;
  isWritable: boolean;
  createdAt: string;
  updatedAt: string;
}

interface CalendarEventRow {
  id: string;
  region: string;
  calendar_id: string;
  remote_event_id: string;
  title: string;
  description: string | null;
  location: string | null;
  is_all_day: number;
  start_ts: number | null;
  end_ts: number | null;
  timezone: string | null;
  scheduled_date: string | null;
  scheduled_time: string | null;
  status: string;
  is_recurring_instance: number;
  recurrence_master_id: string | null;
  instance_start_iso: string | null;
  calendar_name: string | null;
  is_writable: number;
  local_draft: number;
  etag: string | null;
  created_at: string;
  updated_at: string;
}

interface SyncStateRow {
  region: string;
  calendar_id: string;
  sync_token: string | null;
  last_synced_at: string | null;
  status: string;
  last_error: string | null;
  is_writable: number;
  created_at: string;
  updated_at: string;
}

function rowToCalendarEvent(row: CalendarEventRow): CalendarEvent {
  return {
    id: row.id,
    region: row.region as CalRegion,
    calendarId: row.calendar_id,
    remoteEventId: row.remote_event_id,
    title: row.title,
    description: row.description ?? undefined,
    location: row.location ?? undefined,
    isAllDay: row.is_all_day === 1,
    startTs: row.start_ts ?? undefined,
    endTs: row.end_ts ?? undefined,
    timezone: row.timezone ?? undefined,
    scheduledDate: row.scheduled_date ?? undefined,
    scheduledTime: row.scheduled_time ?? undefined,
    status: row.status as CalEventStatus,
    isRecurringInstance: row.is_recurring_instance === 1,
    recurrenceMasterId: row.recurrence_master_id ?? undefined,
    instanceStartIso: row.instance_start_iso ?? undefined,
    calendarName: row.calendar_name ?? undefined,
    isWritable: row.is_writable === 1,
    localDraft: row.local_draft === 1,
    etag: row.etag ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToSyncState(row: SyncStateRow): SyncStateRecord {
  return {
    region: row.region as CalRegion,
    calendarId: row.calendar_id,
    syncToken: row.sync_token ?? undefined,
    lastSyncedAt: row.last_synced_at ?? undefined,
    status: row.status,
    lastError: row.last_error ?? undefined,
    isWritable: row.is_writable === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * 去重键规则:非重复事件 = remoteEventId;重复实例 = `${recurrenceMasterId}:${instanceStartIso}`。
 * 这是 event_map 唯一索引 uq_event_map_dedup(region,calendar_id,dedup_key) 的核心去重逻辑。
 */
export function computeDedupKey(e: CalendarEvent): string {
  if (e.isRecurringInstance && e.recurrenceMasterId) {
    return `${e.recurrenceMasterId}:${e.instanceStartIso ?? ""}`;
  }
  return e.remoteEventId;
}

/** 生成本地 calendar_events id(仿 store.ts 的 newTodoId,前缀 'ce')。 */
export function newCalendarEventId(): string {
  return `ce${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

/** 生成本地 event_map id(前缀 'em')。 */
function newEventMapId(): string {
  return `em${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

export interface ListCalendarEventsOptions {
  /** 是否带上已软删(cancelled)的行。默认 false:只返回 confirmed。 */
  includeCancelled?: boolean;
  /** 限定某个 region。 */
  region?: CalRegion;
  /** 限定某个日历。 */
  calendarId?: string;
}

/**
 * 列出日历事件。默认过滤 status != 'cancelled'(软删行不出现在视图)。
 * 按 scheduled_date 升序、再按 scheduled_time 升序,喂月/周视图。
 */
export async function dbListCalendarEvents(
  opts: ListCalendarEventsOptions = {}
): Promise<CalendarEvent[]> {
  const db = await getDb();
  const where: string[] = [];
  const args: unknown[] = [];
  if (!opts.includeCancelled) {
    where.push("status != 'cancelled'");
  }
  if (opts.region) {
    args.push(opts.region);
    where.push(`region = $${args.length}`);
  }
  if (opts.calendarId) {
    args.push(opts.calendarId);
    where.push(`calendar_id = $${args.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await db.select<CalendarEventRow[]>(
    `SELECT * FROM calendar_events ${clause}
     ORDER BY scheduled_date ASC, scheduled_time ASC`,
    args
  );
  return rows.map(rowToCalendarEvent);
}

/**
 * 维护 event_map 并 upsert 一条 calendar_events,返回 local_id。
 * 抽出 db 参数版,供单条写和批量事务写共用(批量写时复用同一事务连接)。
 *
 * 流程:① 先按 (region,calendar_id,dedup_key) 查 event_map 拿 local_id;
 * 没有则生成新 local_id 并 INSERT...ON CONFLICT(region,calendar_id,dedup_key) 写映射。
 * ② 用拿到的 local_id 作为 calendar_events.id,INSERT...ON CONFLICT(id) DO UPDATE 写事件行。
 * createdAt 保留首次值(ON CONFLICT 不覆盖),updatedAt 每次刷新。
 */
async function upsertCalendarEventOnDb(
  db: Database,
  e: CalendarEvent,
  dedupKey: string
): Promise<string> {
  const now = new Date().toISOString();

  // ① 查/建 event_map 映射,确定 local_id
  const existing = await db.select<Array<{ local_id: string }>>(
    "SELECT local_id FROM event_map WHERE region = $1 AND calendar_id = $2 AND dedup_key = $3",
    [e.region, e.calendarId, dedupKey]
  );
  let localId = existing[0]?.local_id;
  if (!localId) {
    localId = e.id || newCalendarEventId();
    await db.execute(
      `INSERT INTO event_map
        (id, region, calendar_id, remote_event_id, dedup_key, local_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(region, calendar_id, dedup_key) DO UPDATE SET
         remote_event_id = excluded.remote_event_id,
         updated_at = excluded.updated_at`,
      [
        newEventMapId(),
        e.region,
        e.calendarId,
        e.remoteEventId,
        dedupKey,
        localId,
        now,
        now
      ]
    );
    // ON CONFLICT 命中(并发下别的写抢先建了映射)时,以库里既有 local_id 为准
    const after = await db.select<Array<{ local_id: string }>>(
      "SELECT local_id FROM event_map WHERE region = $1 AND calendar_id = $2 AND dedup_key = $3",
      [e.region, e.calendarId, dedupKey]
    );
    localId = after[0]?.local_id ?? localId;
  }

  // ② upsert calendar_events,id = local_id
  await db.execute(
    `INSERT INTO calendar_events
      (id, region, calendar_id, remote_event_id, title, description, location,
       is_all_day, start_ts, end_ts, timezone, scheduled_date, scheduled_time,
       status, is_recurring_instance, recurrence_master_id, instance_start_iso,
       calendar_name, is_writable, local_draft, etag, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     ON CONFLICT(id) DO UPDATE SET
       region = excluded.region,
       calendar_id = excluded.calendar_id,
       remote_event_id = excluded.remote_event_id,
       title = excluded.title,
       description = excluded.description,
       location = excluded.location,
       is_all_day = excluded.is_all_day,
       start_ts = excluded.start_ts,
       end_ts = excluded.end_ts,
       timezone = excluded.timezone,
       scheduled_date = excluded.scheduled_date,
       scheduled_time = excluded.scheduled_time,
       status = excluded.status,
       is_recurring_instance = excluded.is_recurring_instance,
       recurrence_master_id = excluded.recurrence_master_id,
       instance_start_iso = excluded.instance_start_iso,
       calendar_name = excluded.calendar_name,
       is_writable = excluded.is_writable,
       local_draft = excluded.local_draft,
       etag = excluded.etag,
       updated_at = excluded.updated_at`,
    [
      localId,
      e.region,
      e.calendarId,
      e.remoteEventId,
      e.title,
      e.description ?? null,
      e.location ?? null,
      e.isAllDay ? 1 : 0,
      e.startTs ?? null,
      e.endTs ?? null,
      e.timezone ?? null,
      e.scheduledDate ?? null,
      e.scheduledTime ?? null,
      e.status,
      e.isRecurringInstance ? 1 : 0,
      e.recurrenceMasterId ?? null,
      e.instanceStartIso ?? null,
      e.calendarName ?? null,
      e.isWritable ? 1 : 0,
      e.localDraft ? 1 : 0,
      e.etag ?? null,
      e.createdAt ?? now,
      now
    ]
  );
  return localId;
}

/**
 * upsert 一条日历事件(单条,自带 getDb)。
 * dedupKey 由调用方传入(规则见 computeDedupKey);没传则按事件自身算。返回 local_id。
 */
export async function dbUpsertCalendarEvent(
  e: CalendarEvent,
  dedupKey: string = computeDedupKey(e)
): Promise<string> {
  const db = await getDb();
  return upsertCalendarEventOnDb(db, e, dedupKey);
}

/** 批量 upsert,整批走同一事务(任一条失败整批回滚)。 */
export async function dbBulkUpsertCalendarEvents(
  items: CalendarEvent[]
): Promise<void> {
  if (items.length === 0) return;
  await dbTx(async (db) => {
    for (const e of items) {
      await upsertCalendarEventOnDb(db, e, computeDedupKey(e));
    }
  });
}

/**
 * 软删一条事件:按 (region, calendar_id, remote_event_id) 把 status 置 'cancelled'。
 * 不真删行(防增量乱序回插 + 保留 event_map 映射)。
 */
export async function dbSoftDeleteCalendarEvent(
  region: CalRegion,
  calendarId: string,
  remoteEventId: string
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE calendar_events SET status = 'cancelled', updated_at = $1
     WHERE region = $2 AND calendar_id = $3 AND remote_event_id = $4`,
    [new Date().toISOString(), region, calendarId, remoteEventId]
  );
}

/**
 * 本地乐观更新一条日历事件的时段(拖拽改时段:先改本地立刻反映、再入队回写飞书)。按主键 id 定位。
 * 只动 scheduled_date/scheduled_time + updated_at;不碰 etag/freshness(那是远端权威字段,
 * 留给冲突基线与乱序守卫)。
 */
export async function dbUpdateCalendarEventSchedule(
  id: string,
  scheduledDate: string,
  scheduledTime: string | null
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE calendar_events SET scheduled_date = $1, scheduled_time = $2, updated_at = $3
     WHERE id = $4`,
    [scheduledDate, scheduledTime, new Date().toISOString(), id]
  );
}

/** 按去重键查本地 local_id(没有返回 null)。 */
export async function dbFindLocalId(
  region: CalRegion,
  calendarId: string,
  dedupKey: string
): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<Array<{ local_id: string }>>(
    "SELECT local_id FROM event_map WHERE region = $1 AND calendar_id = $2 AND dedup_key = $3",
    [region, calendarId, dedupKey]
  );
  return rows[0]?.local_id ?? null;
}

/* ---------- Sync State(增量同步游标) ---------- */

/** 取某 (region, calendarId) 的同步游标行;没有返回 null。 */
export async function dbGetSyncState(
  region: CalRegion,
  calendarId: string
): Promise<SyncStateRecord | null> {
  const db = await getDb();
  const rows = await db.select<SyncStateRow[]>(
    "SELECT * FROM sync_state WHERE region = $1 AND calendar_id = $2",
    [region, calendarId]
  );
  return rows[0] ? rowToSyncState(rows[0]) : null;
}

/** 列出所有同步游标行(可选限定 region)。 */
export async function dbListSyncStates(
  region?: CalRegion
): Promise<SyncStateRecord[]> {
  const db = await getDb();
  const rows = region
    ? await db.select<SyncStateRow[]>(
        "SELECT * FROM sync_state WHERE region = $1",
        [region]
      )
    : await db.select<SyncStateRow[]>("SELECT * FROM sync_state");
  return rows.map(rowToSyncState);
}

/**
 * upsert 一行同步游标(复合主键 region+calendar_id)。
 * createdAt 保留首次值,其余字段以传入为准,updatedAt 刷新。
 */
export async function dbUpsertSyncState(rec: SyncStateRecord): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.execute(
    `INSERT INTO sync_state
      (region, calendar_id, sync_token, last_synced_at, status, last_error,
       is_writable, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT(region, calendar_id) DO UPDATE SET
       sync_token = excluded.sync_token,
       last_synced_at = excluded.last_synced_at,
       status = excluded.status,
       last_error = excluded.last_error,
       is_writable = excluded.is_writable,
       updated_at = excluded.updated_at`,
    [
      rec.region,
      rec.calendarId,
      rec.syncToken ?? null,
      rec.lastSyncedAt ?? null,
      rec.status,
      rec.lastError ?? null,
      rec.isWritable ? 1 : 0,
      rec.createdAt ?? now,
      now
    ]
  );
}

/**
 * 只更 status(+ 可选 lastError),不动游标/时间戳。
 * 用于把某日历标成 'syncing'/'error',行不存在则建一行最小记录。
 */
export async function dbSetSyncStatus(
  region: CalRegion,
  calendarId: string,
  status: string,
  lastError?: string
): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.execute(
    `INSERT INTO sync_state
      (region, calendar_id, sync_token, last_synced_at, status, last_error,
       is_writable, created_at, updated_at)
     VALUES ($1,$2,NULL,NULL,$3,$4,0,$5,$5)
     ON CONFLICT(region, calendar_id) DO UPDATE SET
       status = excluded.status,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`,
    [region, calendarId, status, lastError ?? null, now]
  );
}

/* ---------- Calendar Change Queue(本地变更队列，Phase 4 写回用) ---------- */

/** 队列项的操作类型。 */
export type ChangeOp = "create" | "update" | "delete";

/**
 * 队列项状态机:
 *  - pending:  待推送(刚入队 / 上次失败可重试)
 *  - sending:  Rust 正在推送(占位，前端基本不写)
 *  - done:     已成功写回远端
 *  - conflict: etag 冲突(base_etag 与远端不一致，走冲突解决)
 *  - failed:   推送失败但可重试(network/5xx 等)
 *  - dead:     重试耗尽，放弃(需人工处理)
 */
export type ChangeState =
  | "pending"
  | "sending"
  | "done"
  | "conflict"
  | "failed"
  | "dead";

/**
 * 一条变更队列记录(camelCase，列名以 SCHEMA_V1 的 calendar_change_queue 为准)。
 *
 * 真相源:本地 SQLite 的 calendar_change_queue 表，前后端共享同库(WAL 并发安全)。
 * 前端只负责"写入队列 + 戳 Rust flush"，真正的 HTTP 写回在 Rust 侧消费这张表。
 *
 * - op:            'create' | 'update' | 'delete'。
 * - localId:       对应 calendar_events.id(本地事件 id)。
 * - calendarId:    远端日历 id(写回时定位日历)。
 * - remoteEventId: 远端 event_id;update/delete 必填，create 时为空(远端还没分配)。
 * - payloadJson:   写回请求体(eventToFeishuPayload 产物的 JSON 字符串)。
 * - baseEtag:      入队那一刻持有的 etag，做冲突基线;远端 etag 与它不一致即冲突。
 * - state:         队列状态机(见 ChangeState)。
 * - retryCount:    已重试次数(Rust 推进)。
 * - lastError:     最近一次失败原因。
 */
export interface ChangeQueueRecord {
  id: string;
  op: ChangeOp;
  localId: string;
  calendarId: string;
  remoteEventId?: string;
  payloadJson: string;
  baseEtag?: string;
  state: ChangeState;
  retryCount: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 入队时的最小入参:id/state/retryCount/时间戳允许省略(由本函数补默认)。
 * 上层 enqueueEventEdit(calendarQueue.ts)组好这个形状交进来。
 */
export interface ChangeQueueInput {
  id?: string;
  op: ChangeOp;
  localId: string;
  calendarId: string;
  remoteEventId?: string;
  payloadJson: string;
  baseEtag?: string;
}

interface ChangeQueueRow {
  id: string;
  op: string;
  local_id: string;
  calendar_id: string;
  remote_event_id: string | null;
  payload_json: string;
  base_etag: string | null;
  state: string;
  retry_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToChangeQueue(row: ChangeQueueRow): ChangeQueueRecord {
  return {
    id: row.id,
    op: row.op as ChangeOp,
    localId: row.local_id,
    calendarId: row.calendar_id,
    remoteEventId: row.remote_event_id ?? undefined,
    payloadJson: row.payload_json,
    baseEtag: row.base_etag ?? undefined,
    state: row.state as ChangeState,
    retryCount: row.retry_count,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** 生成本地变更队列 id(前缀 'cq')。 */
export function newChangeQueueId(): string {
  return `cq${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 入队一条变更。state 固定起始为 'pending'、retry_count=0。返回队列项 id。
 *
 * 注意:调用方应在 await 本函数(execute 已 commit)之后再 invoke('feishu_flush_queue')，
 * 避免 WAL 跨连接可见性窗口让 Rust 漏读刚写的行(P4-3/风险 5)。
 */
export async function dbEnqueueChange(input: ChangeQueueInput): Promise<string> {
  const db = await getDb();
  const now = new Date().toISOString();
  const id = input.id ?? newChangeQueueId();
  await db.execute(
    `INSERT INTO calendar_change_queue
      (id, op, local_id, calendar_id, remote_event_id, payload_json, base_etag,
       state, retry_count, last_error, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',0,NULL,$8,$8)`,
    [
      id,
      input.op,
      input.localId,
      input.calendarId,
      input.remoteEventId ?? null,
      input.payloadJson,
      input.baseEtag ?? null,
      now
    ]
  );
  return id;
}

/**
 * 列出待处理的队列项(state ∈ {'pending','failed'})，按入队时间升序(FIFO)。
 * Rust flush 也按这套口径取，但前端这份用于设置页/调试展示与冗余触发。
 */
export async function dbListPendingChanges(): Promise<ChangeQueueRecord[]> {
  const db = await getDb();
  const rows = await db.select<ChangeQueueRow[]>(
    `SELECT * FROM calendar_change_queue
     WHERE state IN ('pending','failed')
     ORDER BY created_at ASC`
  );
  return rows.map(rowToChangeQueue);
}

/**
 * 更新某队列项的 state(+ 可选 lastError)，刷新 updated_at。
 * failed/conflict/dead 时带上 error 供展示;done/pending 时一般传 null 清掉旧 error。
 */
export async function dbUpdateChangeState(
  id: string,
  state: ChangeState,
  error?: string | null
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE calendar_change_queue
     SET state = $1, last_error = $2, updated_at = $3
     WHERE id = $4`,
    [state, error ?? null, new Date().toISOString(), id]
  );
}

/** 删除一条队列项(done 后清理 / 用户放弃草稿时)。 */
export async function dbDeleteChange(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM calendar_change_queue WHERE id = $1", [id]);
}

/* ---------- Daily Digest(AI 秘书每日纪要，Task 1.3) ---------- */

export interface DailyDigestRow {
  /** YYYY-MM-DD,唯一键 */
  date: string;
  summary: string;
  createdAt: string;
}

/**
 * upsert 一条每日纪要。
 *
 * 语义:同一天重跑/补跑时覆盖而非重复插入——先 DELETE 再 INSERT。
 * 选「删后插」而非「INSERT OR REPLACE」的原因:INSERT OR REPLACE 在 SQLite 里
 * 会先删后插(触发 DELETE 钩子)，语义相同；这里显式写出保证可读性。
 *
 * @param date     YYYY-MM-DD 格式的本地日期
 * @param summary  AI 生成的当日事实性纪要文本
 */
export async function dbUpsertDailyDigest(date: string, summary: string): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await db.execute(
    `INSERT INTO daily_digest (date, summary, created_at)
     VALUES ($1, $2, $3)
     ON CONFLICT(date) DO UPDATE SET summary = excluded.summary, created_at = excluded.created_at`,
    [date, summary, now]
  );
}

/**
 * 取近 N 天纪要,按日期倒序(最新的在前)。
 *
 * 用于注入到 buildChatSystemPrompt,让对话能引用"最近发生了什么"。
 * N 的合理默认值见 dailyScan.ts 的 RECENT_DIGEST_DAYS 常量(默认 7)。
 *
 * @param n 最多返回条数
 */
export async function dbGetRecentDigests(n: number): Promise<DailyDigestRow[]> {
  const db = await getDb();
  const rows = await db.select<Array<{ date: string; summary: string; created_at: string }>>(
    `SELECT date, summary, created_at FROM daily_digest
     ORDER BY date DESC LIMIT $1`,
    [n]
  );
  return rows.map((r) => ({ date: r.date, summary: r.summary, createdAt: r.created_at }));
}

/**
 * 查询某本地日期内发送/收到的消息(供 dailyScan 生成纪要用)。
 *
 * 时区口径:created_at 存 UTC ISO,按 [T00:00:00, T23:59:59.999] 字符串区间比较。
 * 只取 user/assistant 轮次,排除 system/tool 消息(这些不是对话要点)。
 *
 * @param dateKey YYYY-MM-DD 格式,由调用方按本地时区算
 */
export async function dbListMessagesOnDate(
  dateKey: string
): Promise<Array<{ role: string; content: string; created_at: string }>> {
  const db = await getDb();
  return db.select<Array<{ role: string; content: string; created_at: string }>>(
    `SELECT role, content, created_at FROM messages
     WHERE role IN ('user', 'assistant')
       AND created_at >= $1 AND created_at < $2
     ORDER BY created_at ASC`,
    [`${dateKey}T00:00:00`, `${dateKey}T23:59:59.999`]
  );
}

/**
 * 查询某本地日期内有活动的 todos(供 dailyScan 生成纪要用)。
 *
 * "有活动"定义:当天创建(created_at 在该日)或当天完成(completed_at 在该日)。
 * 供 dailyScan 汇总"今天完成了哪些任务/新增了哪些任务"。
 *
 * @param dateKey YYYY-MM-DD 格式
 */
export async function dbListTodosOnDate(dateKey: string): Promise<
  Array<{ title: string; status: string; created_at: string; completed_at: string | null }>
> {
  const db = await getDb();
  return db.select<
    Array<{ title: string; status: string; created_at: string; completed_at: string | null }>
  >(
    `SELECT title, status, created_at, completed_at FROM todos
     WHERE (created_at >= $1 AND created_at < $2)
        OR (completed_at >= $1 AND completed_at < $2)
     ORDER BY created_at ASC`,
    [`${dateKey}T00:00:00`, `${dateKey}T23:59:59.999`]
  );
}
