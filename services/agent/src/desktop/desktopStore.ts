import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { DesktopContent } from "../../../../src/shared/desktopContent.js";
// Vite 5's builtin list predates node:sqlite; resolve it through Node, not Vite.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

// Compatible with the existing Tauri business tables. No graph migrations or
// automatic graph-to-task conversion. Additional provenance lives separately.
export const DESKTOP_SCHEMA = `
CREATE TABLE IF NOT EXISTS todos (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, reason TEXT, deadline TEXT,
 priority TEXT NOT NULL DEFAULT 'none', tags TEXT NOT NULL DEFAULT '[]', est_time TEXT,
 status TEXT NOT NULL DEFAULT 'todo', scheduled_time TEXT, scheduled_date TEXT,
 is_pushback INTEGER NOT NULL DEFAULT 0, is_procrastinated INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS daily_digest (date TEXT PRIMARY KEY, summary TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calendar_events (
 id TEXT PRIMARY KEY, region TEXT NOT NULL, calendar_id TEXT NOT NULL, remote_event_id TEXT NOT NULL,
 title TEXT NOT NULL DEFAULT '', description TEXT, location TEXT, is_all_day INTEGER NOT NULL DEFAULT 0,
 start_ts INTEGER, end_ts INTEGER, timezone TEXT, scheduled_date TEXT, scheduled_time TEXT,
 status TEXT NOT NULL DEFAULT 'confirmed', is_recurring_instance INTEGER NOT NULL DEFAULT 0,
 recurrence_master_id TEXT, instance_start_iso TEXT, calendar_name TEXT,
 is_writable INTEGER NOT NULL DEFAULT 0, local_draft INTEGER NOT NULL DEFAULT 0,
 etag TEXT, freshness INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_publications (
 publication_key TEXT PRIMARY KEY, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
 content_hash TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(kind, entity_id)
);`;

export class DesktopContentError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function desktopDatabasePath(stateDir: string, explicit = process.env.LATITUDE_DESKTOP_DB_PATH): string {
  if (explicit?.trim()) return path.resolve(explicit);
  return process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "com.latitude.desktop", "latitude.db")
    : path.join(path.dirname(stateDir), "latitude.db");
}

export function localDateKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected an object");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, max = 50_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(`Invalid ${name}`);
  return value.trim();
}
function dateKey(value: unknown): string {
  const date = text(value, "date", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new TypeError("Invalid date");
  return date;
}
function time(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new TypeError("Invalid scheduledTime");
  return value;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Single local business DB, shared with the existing app. Writes and their
 * publication receipts commit together. Missing/failed receipts never mean success. */
export class DesktopStore {
  private connection?: InstanceType<typeof DatabaseSync>;
  constructor(readonly filename: string) {}
  private get db(): InstanceType<typeof DatabaseSync> {
    if (!this.connection) {
      if (this.filename !== ":memory:") mkdirSync(path.dirname(this.filename), { recursive: true });
      const db = new DatabaseSync(this.filename);
      try {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes'").get()) {
          throw new DesktopContentError(409, "便签库路径指向了知识图谱，请配置原业务库 latitude.db。");
        }
        db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
        db.exec(DESKTOP_SCHEMA);
      } catch (error) { db.close(); throw error; }
      this.connection = db;
    }
    return this.connection;
  }
  close() { this.connection?.close(); this.connection = undefined; }

  read(date = localDateKey()): DesktopContent {
    dateKey(date);
    const db = this.db;
    const sources = (kind: string, id: string): string[] => {
      const row = db.prepare("SELECT metadata_json FROM desktop_publications WHERE kind=? AND entity_id=?").get(kind, id);
      return row ? JSON.parse(String(row.metadata_json)).sourceNodeIds ?? [] : [];
    };
    return {
      date,
      todos: db.prepare("SELECT * FROM todos WHERE status IN ('todo','doing') OR (status='done' AND scheduled_date=?) ORDER BY created_at DESC").all(date).map(row => ({
        id: String(row.id), title: String(row.title), status: String(row.status) as DesktopContent["todos"][number]["status"],
        scheduledDate: row.scheduled_date == null ? null : String(row.scheduled_date),
        scheduledTime: row.scheduled_time == null ? null : String(row.scheduled_time),
        updatedAt: String(row.updated_at), sourceNodeIds: sources("todo", String(row.id)),
      })),
      events: db.prepare("SELECT * FROM calendar_events WHERE status != 'cancelled' AND (scheduled_date=? OR (start_ts<? AND COALESCE(end_ts,start_ts)>=?)) ORDER BY start_ts").all(
        date, new Date(`${date}T00:00:00`).setDate(new Date(`${date}T00:00:00`).getDate() + 1) / 1000, new Date(`${date}T00:00:00`).getTime() / 1000,
      ).map(row => ({
        id: String(row.id), title: String(row.title), status: String(row.status),
        scheduledDate: row.scheduled_date == null ? null : String(row.scheduled_date),
        scheduledTime: row.scheduled_time == null ? null : String(row.scheduled_time),
        startTs: row.start_ts == null ? null : Number(row.start_ts), endTs: row.end_ts == null ? null : Number(row.end_ts),
      })),
      digests: db.prepare("SELECT * FROM daily_digest WHERE date<=? ORDER BY date DESC LIMIT 30").all(date).map(row => ({
        date: String(row.date), summary: String(row.summary), sourceNodeIds: sources("digest", String(row.date)),
      })),
    };
  }

  publish(raw: unknown, attribution: { sessionId: string; runId: string; toolCallId: string }) {
    const input = object(raw);
    const kind = text(input.kind, "kind", 20);
    if (!["todo", "digest", "calendar"].includes(kind)) throw new TypeError("Unsupported desktop record kind");
    const publicationKey = text(input.publicationKey, "publicationKey", 250);
    if (!Array.isArray(input.sourceNodeIds) || input.sourceNodeIds.some(id => typeof id !== "string" || !id.trim())) throw new TypeError("sourceNodeIds must list the knowledge used; use [] for a direct user request");
    const sourceNodeIds = [...new Set(input.sourceNodeIds as string[])].sort();
    const date = kind === "digest" ? dateKey(input.date) : input.scheduledDate == null ? null : dateKey(input.scheduledDate);
    const scheduledTime = time(input.scheduledTime);
    const title = kind === "digest" ? null : text(input.title, "title", 1000);
    const summary = kind === "digest" ? text(input.summary, "summary") : null;
    const startTs = kind === "calendar" ? Number(input.startTs) : null;
    const endTs = kind === "calendar" ? Number(input.endTs) : null;
    if (kind === "calendar" && (!Number.isInteger(startTs) || !Number.isInteger(endTs) || !startTs || !endTs || endTs <= startTs || !date)) throw new TypeError("Calendar requires scheduledDate and Unix-second startTs/endTs, with end after start");
    const contentHash = hash({ kind, date, scheduledTime, title, summary, startTs, endTs, sourceNodeIds });
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const previous = db.prepare("SELECT * FROM desktop_publications WHERE publication_key=?").get(publicationKey);
      if (previous) {
        if (previous.content_hash !== contentHash) throw new DesktopContentError(409, "同一发布标识已有不同内容，请先读取原记录，不要覆盖。");
        // Replaying publication never restores an edited/completed/deleted record.
        const table = kind === "digest" ? "daily_digest" : kind === "todo" ? "todos" : "calendar_events";
        const key = kind === "digest" ? "date" : "id";
        if (!db.prepare(`SELECT 1 FROM ${table} WHERE ${key}=?`).get(previous.entity_id)) throw new DesktopContentError(409, "这条已发布记录已被移除，不会自动重建。");
        db.exec("COMMIT");
        return { persisted: true, deduplicated: true, kind, id: String(previous.entity_id) };
      }
      const id = kind === "digest" ? date! : `desk-${randomUUID()}`;
      const now = new Date().toISOString();
      if (kind === "digest") {
        if (db.prepare("SELECT 1 FROM daily_digest WHERE date=?").get(id)) throw new DesktopContentError(409, "这一天已有每日整理，原内容保留；不能用另一个发布标识覆盖。");
        db.prepare("INSERT INTO daily_digest(date,summary,created_at) VALUES(?,?,?)").run(id, summary, now);
      } else if (kind === "todo") {
        db.prepare("INSERT INTO todos(id,title,status,scheduled_date,scheduled_time,created_at,updated_at) VALUES(?,?,'todo',?,?,?,?)").run(id, title, date, scheduledTime, now, now);
      } else {
        // Local-only event: this operation never writes to Feishu or invites anyone.
        db.prepare("INSERT INTO calendar_events(id,region,calendar_id,remote_event_id,title,start_ts,end_ts,scheduled_date,scheduled_time,created_at,updated_at) VALUES(?,'local','latitude-local',?,?,?,?,?,?,?,?)").run(id, id, title, startTs, endTs, date, scheduledTime, now, now);
      }
      db.prepare("INSERT INTO desktop_publications VALUES(?,?,?,?,?,?)").run(publicationKey, kind, id, contentHash, JSON.stringify({ sourceNodeIds, ...attribution }), now);
      db.exec("COMMIT");
      return { persisted: true, deduplicated: false, kind, id };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  updateTodo(raw: unknown) {
    const input = object(raw);
    const id = text(input.id, "id", 250);
    const version = text(input.expectedUpdatedAt, "expectedUpdatedAt", 100);
    const title = input.title === undefined ? null : text(input.title, "title", 1000);
    const status = input.status === undefined ? null : text(input.status, "status", 20);
    if (status && !["todo", "doing", "done", "dropped"].includes(status)) throw new TypeError("Invalid todo status");
    if (!title && !status) throw new TypeError("No todo changes supplied");
    const now = new Date(Math.max(Date.now(), Date.parse(version) + 1 || 0)).toISOString();
    const result = this.db.prepare(`UPDATE todos SET title=COALESCE(?,title),status=COALESCE(?,status),
      completed_at=CASE WHEN ?='done' THEN COALESCE(completed_at,?) WHEN ? IS NOT NULL THEN NULL ELSE completed_at END,
      updated_at=? WHERE id=? AND updated_at=?`).run(title, status, status, now, status, now, id, version);
    if (!result.changes) {
      const row = this.db.prepare("SELECT title,status,updated_at FROM todos WHERE id=?").get(id);
      if (row && (!title || title === row.title) && (!status || status === row.status)) return { saved: true, updatedAt: String(row.updated_at) };
      throw new DesktopContentError(409, "待办已变化或已被移除，请刷新后重试。");
    }
    return { saved: true, updatedAt: now };
  }
}
