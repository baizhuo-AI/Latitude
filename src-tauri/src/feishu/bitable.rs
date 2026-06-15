//! 飞书 / Lark 多维表格（Bitable）写入 connector 的后端能力。
//!
//! 职责：把用户贴的表格链接解析成可操作的资源句柄（解析 wiki→base）、读表结构与现有记录、
//! 按 upsert 写入。HTTP 细节复用 [`FeishuClient`](crate::feishu::client::FeishuClient)
//! 的 get_json / post_json（带 OAuth Bearer、429 退避、`{code,msg,data}` 壳解读）。
//!
//! 设计取舍：
//! - **不做 trait 抽象**：只有飞书一个实现，直接写自由函数（区别于 sync.rs/writeback.rs 为单测
//!   mock 才用 trait）。
//! - **token 搭日历同步的便车**：本模块只用 keychain 里的当前 access_token，不自己实现刷新。
//!   日历后台同步会自动刷新并落盘同一份 token（见 engine.rs 的 on_refreshed）。万一 token 真过期，
//!   把 [`FeishuError::TokenExpired`](crate::feishu::client::FeishuError) 透传给前端提示重连。
//! - **写入用批量接口**（batch_create / batch_update，均 POST），复用 post_json，无需给 client 加 PUT。
//! - **CellValue 由前端组好**：fields 的值格式（文本→字符串、日期→毫秒时间戳数字、单选→字符串）
//!   由调用方（前端 AI 工具层）按字段 ui_type 转好后传入，本层只透传，不按字段类型做转换。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use url::Url;

use crate::feishu::client::FeishuClient;
use crate::feishu::{config, keychain, Region};

/* ===================== 数据结构（serde 与前端对齐） ===================== */

/// 一个多维表格字段的元信息（喂前端 / AI 做字段映射）。
#[derive(Serialize, Debug, Clone)]
pub struct BitableFieldMeta {
    pub field_id: String,
    pub field_name: String,
    /// 飞书的 UI 类型字符串：`Text` / `DateTime` / `SingleSelect` / `MultiSelect` / `User` 等。
    /// 比数字 `type` 对 AI 更友好，用它判断怎么填值。
    pub ui_type: String,
    /// 是否主字段（表的第一列）。upsert 按主字段匹配，前端据此定"项目"列。
    pub is_primary: bool,
}

/// 一条现有记录（喂 upsert 匹配：按主字段值找该改哪一行）。
#[derive(Serialize, Debug, Clone)]
pub struct BitableRecordRow {
    pub record_id: String,
    /// 字段名 → 值（飞书原始格式）。
    pub fields: Value,
}

/// `feishu_bitable_describe` 的返回：解析 + 读结构 + 读现有行一次给齐。
#[derive(Serialize, Debug, Clone)]
pub struct BitableTableInfo {
    pub app_token: String,
    pub table_id: String,
    pub fields: Vec<BitableFieldMeta>,
    pub records: Vec<BitableRecordRow>,
}

/// 前端传入的一条更新（record_id + 要写的字段值）。
#[derive(Deserialize, Debug, Clone)]
pub struct BitableRecordUpdate {
    pub record_id: String,
    pub fields: Value,
}

/* ===================== 链接解析（纯逻辑，可单测） ===================== */

#[derive(Debug, Clone, PartialEq, Eq)]
enum LinkKind {
    /// `/wiki/{node_token}`：知识库节点，需再解析成 base app_token。
    Wiki,
    /// `/base/{app_token}`：多维表格直链。
    Base,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedLink {
    kind: LinkKind,
    /// wiki 时是 node_token，base 时是 app_token。
    token: String,
    /// URL 里 `?table=tblxxx` 的值（一个 base 可能多表，必须指定）。
    table_id: Option<String>,
}

/// 从用户贴的链接解析出 (kind, token, table_id)。
///
/// **关键决策（已验证的坑）**：按 URL **路径段** `/wiki/` vs `/base/` 分流，**不靠 token 前缀**
/// 判断——新版飞书 wiki 的 node_token 不再以 `wik` 开头，靠前缀会误判成 base token 直接查
/// Bitable 接口、报 131005。路径段才是可靠依据。
fn parse_table_link(raw: &str) -> Result<ParsedLink, String> {
    let url = Url::parse(raw.trim()).map_err(|e| format!("链接不是合法 URL：{e}"))?;
    let segs: Vec<String> = url
        .path_segments()
        .map(|it| it.map(|s| s.to_string()).collect())
        .unwrap_or_default();

    let (kind, token) = if let Some(pos) = segs.iter().position(|s| s == "wiki") {
        (LinkKind::Wiki, segs.get(pos + 1).cloned())
    } else if let Some(pos) = segs.iter().position(|s| s == "base") {
        (LinkKind::Base, segs.get(pos + 1).cloned())
    } else {
        return Err("链接里既没有 /wiki/ 也没有 /base/，无法识别为飞书多维表格".to_string());
    };

    let token = token
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "链接缺少表格/节点 token 段".to_string())?;

    let table_id = url
        .query_pairs()
        .find(|(k, _)| k == "table")
        .map(|(_, v)| v.to_string());

    Ok(ParsedLink {
        kind,
        token,
        table_id,
    })
}

/* ===================== Bitable / Wiki REST 调用 ===================== */

/// 解析 wiki node_token → base app_token；base 直链原样返回。
///
/// wiki 解析调 `GET /wiki/v2/spaces/get_node?token={node_token}&obj_type=wiki`，
/// 取 `data.node.obj_token`。注意：第一个参数 `token` 是 OAuth access_token，URL query 里的
/// `token` 才是 node_token，两者别混。
async fn resolve_app_token(
    api: &FeishuClient,
    access_token: &str,
    parsed: &ParsedLink,
) -> Result<String, String> {
    match parsed.kind {
        LinkKind::Base => Ok(parsed.token.clone()),
        LinkKind::Wiki => {
            let body = api
                .get_json(
                    access_token,
                    "/wiki/v2/spaces/get_node",
                    &[("token", parsed.token.as_str()), ("obj_type", "wiki")],
                )
                .await
                .map_err(|e| format!("解析 wiki 链接失败：{e}"))?;
            body.get("data")
                .and_then(|d| d.get("node"))
                .and_then(|n| n.get("obj_token"))
                .and_then(Value::as_str)
                .map(|s| s.to_string())
                .ok_or_else(|| "wiki 节点未返回 obj_token（可能不是多维表格节点）".to_string())
        }
    }
}

/// 读表字段结构。
async fn list_fields(
    api: &FeishuClient,
    access_token: &str,
    app_token: &str,
    table_id: &str,
) -> Result<Vec<BitableFieldMeta>, String> {
    let path = format!("/bitable/v1/apps/{app_token}/tables/{table_id}/fields");
    let body = api
        .get_json(access_token, &path, &[("page_size", "200")])
        .await
        .map_err(|e| format!("读取表字段失败：{e}"))?;
    let items = body
        .get("data")
        .and_then(|d| d.get("items"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(items
        .iter()
        .map(|it| BitableFieldMeta {
            field_id: it
                .get("field_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            field_name: it
                .get("field_name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            ui_type: it
                .get("ui_type")
                .and_then(Value::as_str)
                .unwrap_or("Unknown")
                .to_string(),
            is_primary: it
                .get("is_primary")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
        .collect())
}

/// 读现有记录（upsert 匹配前提）。首期读单页 500 条（项目进展表通常远小于此）。
/// 注：若超过 500 条需翻页（page_token），属后续增强；当前单页足够日报/项目表场景。
async fn list_records(
    api: &FeishuClient,
    access_token: &str,
    app_token: &str,
    table_id: &str,
) -> Result<Vec<BitableRecordRow>, String> {
    let path = format!("/bitable/v1/apps/{app_token}/tables/{table_id}/records");
    let body = api
        .get_json(access_token, &path, &[("page_size", "500")])
        .await
        .map_err(|e| format!("读取表记录失败：{e}"))?;
    let items = body
        .get("data")
        .and_then(|d| d.get("items"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(items
        .iter()
        .map(|it| BitableRecordRow {
            record_id: it
                .get("record_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            fields: it.get("fields").cloned().unwrap_or(Value::Null),
        })
        .collect())
}

/// 批量新建记录，返回新建的 record_id 列表。单批 ≤200（飞书限制）。
async fn create_records(
    api: &FeishuClient,
    access_token: &str,
    app_token: &str,
    table_id: &str,
    rows: &[Value],
) -> Result<Vec<String>, String> {
    if rows.is_empty() {
        return Ok(vec![]);
    }
    let path = format!("/bitable/v1/apps/{app_token}/tables/{table_id}/records/batch_create");
    let records: Vec<Value> = rows.iter().map(|f| json!({ "fields": f })).collect();
    let body = json!({ "records": records });
    let resp = api
        .post_json(access_token, &path, &body)
        .await
        .map_err(|e| format!("新建记录失败：{e}"))?;
    Ok(resp
        .get("data")
        .and_then(|d| d.get("records"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|r| r.get("record_id").and_then(Value::as_str))
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default())
}

/// 批量更新记录（按 record_id）。单批 ≤200。
async fn update_records(
    api: &FeishuClient,
    access_token: &str,
    app_token: &str,
    table_id: &str,
    updates: &[BitableRecordUpdate],
) -> Result<(), String> {
    if updates.is_empty() {
        return Ok(());
    }
    let path = format!("/bitable/v1/apps/{app_token}/tables/{table_id}/records/batch_update");
    let records: Vec<Value> = updates
        .iter()
        .map(|u| json!({ "record_id": u.record_id, "fields": u.fields }))
        .collect();
    let body = json!({ "records": records });
    api.post_json(access_token, &path, &body)
        .await
        .map_err(|e| format!("更新记录失败：{e}"))?;
    Ok(())
}

/* ===================== 取凭证（复刻 engine.rs KeychainEnv::prepare 的逻辑） ===================== */

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("解析配置目录失败：{e}"))
}

/// 拿 (client, access_token)。app_id 来自明文 config，token 来自 keychain；三者不全视为未连接。
/// 与 engine.rs 的 `KeychainEnv::prepare` 同逻辑——那是私有的，这里复刻三行避免暴露其可见性。
fn prepare(app: &AppHandle, region: Region) -> Result<(FeishuClient, String), String> {
    let dir = config_dir(app)?;
    let cfg = config::load(&dir);
    let app_id = cfg
        .region(region)
        .app_id
        .clone()
        .ok_or_else(|| "尚未配置飞书 app_id，请先在设置里连接飞书账号".to_string())?;
    let creds = keychain::load_credentials(region, &app_id)?
        .ok_or_else(|| "尚未连接飞书账号（凭证不全），请先在设置里完成连接/授权".to_string())?;
    Ok((FeishuClient::new(region), creds.access_token))
}

/* ===================== Tauri command ===================== */

/// 解析链接 + 读表结构 + 读现有记录，一次返回。前端「测试连接 / 读取表结构」与 AI 预览都用它。
#[tauri::command]
pub async fn feishu_bitable_describe(
    app: AppHandle,
    region: Region,
    link: String,
) -> Result<BitableTableInfo, String> {
    let parsed = parse_table_link(&link)?;
    let table_id = parsed
        .table_id
        .clone()
        .ok_or_else(|| "链接缺少 ?table=tblxxx 参数，请用带具体表格的链接".to_string())?;
    let (api, token) = prepare(&app, region)?;

    let app_token = resolve_app_token(&api, &token, &parsed).await?;
    let fields = list_fields(&api, &token, &app_token, &table_id).await?;
    let records = list_records(&api, &token, &app_token, &table_id).await?;

    Ok(BitableTableInfo {
        app_token,
        table_id,
        fields,
        records,
    })
}

/// 批量新建记录。`rows` 每项是一个 fields map（字段名→CellValue，由前端按 ui_type 组好）。
#[tauri::command]
pub async fn feishu_bitable_create(
    app: AppHandle,
    region: Region,
    app_token: String,
    table_id: String,
    rows: Vec<Value>,
) -> Result<Vec<String>, String> {
    let (api, token) = prepare(&app, region)?;
    create_records(&api, &token, &app_token, &table_id, &rows).await
}

/// 批量更新记录（按 record_id）。
#[tauri::command]
pub async fn feishu_bitable_update(
    app: AppHandle,
    region: Region,
    app_token: String,
    table_id: String,
    updates: Vec<BitableRecordUpdate>,
) -> Result<(), String> {
    let (api, token) = prepare(&app, region)?;
    update_records(&api, &token, &app_token, &table_id, &updates).await
}

/* ===================== 单测：链接解析（纯逻辑） ===================== */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_wiki_link_with_table() {
        // 真实测试链接形态：/wiki/{node_token}?table=tblxxx&view=vewxxx
        let p = parse_table_link(
            "https://juzihudong.feishu.cn/wiki/VK0YwAMq7iKir7kUDHccLxZKnGf?table=tblLBu6pqWs9Bf5L&view=vewGEoQ3Ds",
        )
        .expect("应解析成功");
        assert_eq!(p.kind, LinkKind::Wiki);
        assert_eq!(p.token, "VK0YwAMq7iKir7kUDHccLxZKnGf");
        assert_eq!(p.table_id.as_deref(), Some("tblLBu6pqWs9Bf5L"));
    }

    #[test]
    fn parses_base_direct_link() {
        let p = parse_table_link("https://example.feishu.cn/base/BaseAppToken123?table=tblABC")
            .expect("应解析成功");
        assert_eq!(p.kind, LinkKind::Base);
        assert_eq!(p.token, "BaseAppToken123");
        assert_eq!(p.table_id.as_deref(), Some("tblABC"));
    }

    /// 关键回归：node_token 不以 `wik` 开头时，仍按 /wiki/ 路径判定为 Wiki（不靠前缀）。
    #[test]
    fn wiki_kind_decided_by_path_not_token_prefix() {
        let p = parse_table_link("https://x.feishu.cn/wiki/ZZZnotWikPrefix?table=tblX").unwrap();
        assert_eq!(p.kind, LinkKind::Wiki);
    }

    #[test]
    fn missing_table_param_is_none() {
        let p = parse_table_link("https://x.feishu.cn/wiki/Node123").unwrap();
        assert_eq!(p.table_id, None);
    }

    #[test]
    fn unrecognized_link_errors() {
        let e = parse_table_link("https://x.feishu.cn/docx/SomeDoc").unwrap_err();
        assert!(e.contains("无法识别"), "{e}");
    }

    #[test]
    fn non_url_errors() {
        assert!(parse_table_link("not a url").is_err());
    }
}
