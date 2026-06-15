import { invoke } from "@tauri-apps/api/core";
import type { FeishuRegion } from "./settings";

/**
 * 飞书多维表格 connector — 前端薄封装层
 *
 * 把 Rust 的 3 个 bitable command 包成有类型的 async 函数。字段名与 Rust `bitable.rs`
 * 的 Serialize 结构逐字对齐（snake_case）。本层零副作用、不 try/catch，抛错交调用方
 * （与 calendarSync.ts 一致）。token 失效时 Rust 会返回中文错误「飞书 access_token 已失效…」，
 * 调用方据此提示用户重新授权。
 */

/** 一个表字段的元信息（与 Rust BitableFieldMeta 对齐）。 */
export interface BitableFieldMeta {
  field_id: string;
  field_name: string;
  /** "Text" | "DateTime" | "SingleSelect" | "MultiSelect" | "User" 等。 */
  ui_type: string;
  /** 是否主字段（表第一列）。upsert 按它匹配。 */
  is_primary: boolean;
}

/** 一条现有记录（与 Rust BitableRecordRow 对齐）。fields 是飞书原始格式。 */
export interface BitableRecordRow {
  record_id: string;
  fields: Record<string, unknown>;
}

/** describe 的返回：解析 + 读结构 + 读现有行一次给齐。 */
export interface BitableTableInfo {
  app_token: string;
  table_id: string;
  fields: BitableFieldMeta[];
  records: BitableRecordRow[];
}

/** 一条更新（与 Rust BitableRecordUpdate 对齐；record_id 是 snake_case，由 serde 反序列化）。 */
export interface BitableRecordUpdate {
  record_id: string;
  fields: Record<string, unknown>;
}

/**
 * 解析表格链接 + 读字段结构 + 读现有记录。
 * 前端「测试连接 / 读取表结构」与 AI 预览同步都用它。
 */
export async function describeBitable(
  region: FeishuRegion,
  link: string
): Promise<BitableTableInfo> {
  return invoke<BitableTableInfo>("feishu_bitable_describe", { region, link });
}

/** 批量新建记录，返回新建的 record_id 列表。rows 每项是「字段名→CellValue」。 */
export async function createBitableRecords(
  region: FeishuRegion,
  appToken: string,
  tableId: string,
  rows: Record<string, unknown>[]
): Promise<string[]> {
  return invoke<string[]>("feishu_bitable_create", {
    region,
    appToken,
    tableId,
    rows
  });
}

/** 批量更新记录（按 record_id）。 */
export async function updateBitableRecords(
  region: FeishuRegion,
  appToken: string,
  tableId: string,
  updates: BitableRecordUpdate[]
): Promise<void> {
  return invoke("feishu_bitable_update", { region, appToken, tableId, updates });
}
