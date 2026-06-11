//! 时区归一 + 远端事件 → 行映射（Phase 2 的 P2-2）。
//!
//! 这是整个日历同步里**最高危**的一块：全天事件的「零偏移」一旦写反，UTC+8 用户看到
//! 的所有全天事件都会前移一天，且如果开发者本地恰好也是 UTC+8，测试会一起漂、把 bug
//! 藏住。所以这个文件先写测试、强制在 ≥2 个时区下验证，再谈实现。
//!
//! 与前端 `src/lib/calendar.ts` 的 `normalizeEventTiming` **行为必须逐字一致**——两端各
//! 算一次（Rust 落库时算、前端兜底也能算），算出来的 `scheduled_date` / `scheduled_time`
//! 不一致就会串天 / 漂钟点。产物格式被 `parseScheduledTime`（calendar.ts:100）钉死：
//! `scheduled_time` 须匹配 `^\d{1,2}:\d{2}-\d{1,2}:\d{2}$` 且 endMin>startMin、均 ≤1440。
//!
//! 两条独立路径，**绝不混用**：
//!  - 全天：飞书 `start.date`（"YYYY-MM-DD"）是 **UTC+0 日历日**，直接当本地
//!    `scheduled_date`，绝不做 `Utc→Local` 转换；`scheduled_time = None`。
//!  - 定时：飞书 `start.timestamp`（UTC 秒）+ `timezone`（IANA，缺省 Asia/Shanghai）
//!    按事件时区折算本地钟点。跨天（end 落在不同本地日）或 end<=start 时，因
//!    `parseScheduledTime` 无法表达跨天，`scheduled_time` 落起始日、end 截到 23:59
//!    （已知近似）。

use chrono::{DateTime, Timelike};
use chrono_tz::Tz;
use serde_json::Value;

use crate::feishu::Region;

/// 飞书定时日程缺省时区。飞书的 TimeInfo 在某些场景可能不带 timezone，按官方默认补这个。
const DEFAULT_TZ: &str = "Asia/Shanghai";

/// 远端事件的一个时间端点（start 或 end）。
///
/// 飞书 TimeInfo 二选一：全天事件给 `date`（"YYYY-MM-DD"，UTC+0 日历日），定时事件给
/// `timestamp`（UTC 秒）+ `timezone`（IANA）。两者互斥——`date.is_some()` 即判定为全天。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RawTime {
    /// 全天事件日期 "YYYY-MM-DD"（UTC+0 日历日；定时事件为 None）。
    pub date: Option<String>,
    /// 定时事件 Unix 秒（UTC；全天事件为 None）。
    pub timestamp: Option<i64>,
    /// 定时事件 IANA 时区（缺省按 Asia/Shanghai）。
    pub timezone: Option<String>,
}

/// 归一产物：喂日历视图的 `scheduled_*` + 保留的原始时间戳。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedTime {
    /// 'YYYY-MM-DD'（本地）；喂月/周视图。全天 = start.date 原样；定时 = 起始本地日。
    pub scheduled_date: Option<String>,
    /// 'HH:MM-HH:MM'；全天为 None。能被前端 parseScheduledTime 解析。
    pub scheduled_time: Option<String>,
    pub is_all_day: bool,
    /// 原始 UTC 秒（全天为 None，与 calendar_events 表「全天 start_ts NULL」对齐）。
    pub start_ts: Option<i64>,
    pub end_ts: Option<i64>,
}

/// 远端事件归一后、映射到一行的结果（上层据此组 CalendarEventInput）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MappedEvent {
    /// 远端 event_id（母事件 id）。
    pub remote_event_id: String,
    /// 去重唯一键：非重复 = remote_event_id；重复实例 = "{master}:{original_start}"。
    pub dedup_key: String,
    pub title: String,
    /// 'confirmed' | 'cancelled'（飞书 status 字段映射，cancelled 走软删）。
    pub status: String,
    pub time: NormalizedTime,
    /// 重复事件母 id（非重复为 None）。
    pub master_event_id: Option<String>,
    /// 重复实例原始起始（UTC 秒；非重复为 None）。去重键的另一半。
    pub original_start_ts: Option<i64>,
    /// 远端版本号（冲突三态判定用；列表响应可能不带，则 None）。
    pub etag: Option<String>,
    /// 该日历是否可写（逐日历探测结果，冗余到事件行）。
    pub is_writable: bool,
}

/// 把一个 UTC 秒时间戳按目标时区折算成 { 本地日期 "YYYY-MM-DD", 当日分钟数 0-1439 }。
///
/// 对齐前端 `localParts`（calendar.ts:144）：用事件时区把 UTC 瞬间投影到本地墙钟。
/// 时区字符串解析失败时回退 UTC（不 panic——脏数据不应让整轮同步崩）。
fn local_parts(ts: i64, tz_str: &str) -> (String, u32) {
    let tz: Tz = tz_str.parse().unwrap_or(Tz::UTC);
    // from_timestamp 在合法 Unix 秒上不会失败；极端越界值兜底 epoch。
    let utc = DateTime::from_timestamp(ts, 0).unwrap_or_else(|| DateTime::from_timestamp(0, 0).unwrap());
    let local = utc.with_timezone(&tz);
    let date = local.format("%Y-%m-%d").to_string();
    let min = local.hour() * 60 + local.minute();
    (date, min)
}

/// "HH:MM"（分钟数 → 零填充时分）。对齐前端 formatHM（calendar.ts:117）。
fn format_hm(minutes: u32) -> String {
    format!("{:02}:{:02}", minutes / 60, minutes % 60)
}

/// 归一一个事件的起止时间 → NormalizedTime。
///
/// **与前端 normalizeEventTiming（calendar.ts:170）逐行对齐**，任何分支差异都会让两端
/// 算出不同结果。全天 / 定时两条路径互斥：
///  - `start.date.is_some()` → 全天：date 原样落 scheduled_date（零偏移），time=None。
///  - 否则定时：timestamp(UTC)+timezone 折本地；end 缺/跨天/<=start 时截到 23:59 落起始日。
pub fn normalize(start: &RawTime, end: &RawTime) -> NormalizedTime {
    // —— 全天路径：零偏移。直接拿 UTC+0 日历日当本地日期，绝不 Utc→Local 转。 ——
    if let Some(date) = &start.date {
        return NormalizedTime {
            scheduled_date: Some(date.clone()),
            scheduled_time: None,
            is_all_day: true,
            // 全天事件不保留 UTC 秒（表里 start_ts/end_ts 为 NULL）。
            start_ts: None,
            end_ts: None,
        };
    }

    // —— 定时路径：没有 timestamp 就无从折算，返回空壳（极端脏数据兜底）。 ——
    let Some(start_ts) = start.timestamp else {
        return NormalizedTime {
            scheduled_date: None,
            scheduled_time: None,
            is_all_day: false,
            start_ts: None,
            end_ts: None,
        };
    };

    let tz = start.timezone.as_deref().filter(|s| !s.is_empty()).unwrap_or(DEFAULT_TZ);
    let (start_date, start_min) = local_parts(start_ts, tz);

    // end 分钟数计算，严格对齐 TS：
    //  - end 缺失 → start_min + 60，封顶 1439。
    //  - end 存在且与 start 同一本地日且 end_min > start_min → 用 end_min。
    //  - 否则（跨天 / end<=start）→ 1439（截到 23:59，已知近似）。
    let mut end_min: u32 = match end.timestamp {
        None => (start_min + 60).min(1439),
        Some(end_ts) => {
            let (end_date, em) = local_parts(end_ts, tz);
            if end_date == start_date && em > start_min {
                em
            } else {
                1439
            }
        }
    };
    // 与 TS 的尾部保护一致：仅当 start_min==1439 时才会触发（1439<=1439）→ 抬到 1440。
    if end_min <= start_min {
        end_min = (start_min + 1).min(1440);
    }

    NormalizedTime {
        scheduled_date: Some(start_date),
        scheduled_time: Some(format!("{}-{}", format_hm(start_min), format_hm(end_min))),
        is_all_day: false,
        start_ts: Some(start_ts),
        end_ts: end.timestamp,
    }
}

/* ===================== JSON 取值 helper ===================== */

/// 从 Value 读非空字符串字段（去掉空串，等同 None）。
fn str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

/// 飞书 timestamp 可能是字符串（"1700000000"）或数字，两种都解析成 i64 秒。
fn as_unix_secs(v: &Value) -> Option<i64> {
    match v {
        Value::String(s) => s.parse::<i64>().ok(),
        Value::Number(n) => n.as_i64(),
        _ => None,
    }
}

/// 解析一个 TimeInfo（start_time / end_time）→ RawTime。
fn parse_time_info(info: &Value) -> RawTime {
    RawTime {
        date: str_field(info, "date"),
        timestamp: info.get("timestamp").and_then(as_unix_secs),
        timezone: str_field(info, "timezone"),
    }
}

/// 把一条飞书远端事件 JSON 映射成 MappedEvent（拿不到 event_id 则 None，无法去重/落库）。
///
/// 关键决策（务必与表/前端对齐）：
///  ① status：飞书 `status == "cancelled"` → 'cancelled'（软删），否则一律 'confirmed'。
///     飞书还有 'tentative'/'confirmed'，我们只关心「是否已取消」，其余都当 confirmed。
///  ② dedup_key 三态：
///     - 非重复实例 → dedup_key = remote_event_id。
///     - 重复实例（带 recurring_event_id）→ dedup_key = "{master}:{original_start_secs}"。
///       original_start 取 `original_time`（UTC 秒）；缺失时退回事件自身起始 timestamp，
///       再缺退回 0（保证键稳定可复现，不至于 panic）。
///  ③ is_writable 不从事件里读，由调用方（逐日历探测结果）传入，冗余到行。
pub fn map_event(
    region: Region,
    _calendar_id: &str,
    is_writable: bool,
    ev: &Value,
) -> Option<MappedEvent> {
    // region 目前不参与字段解析（飞书/Lark 事件结构一致），保留入参是为了让上层签名统一、
    // 且未来若两平台字段分叉可在此分支；用一下避免 unused 警告。
    let _ = region;

    let remote_event_id = str_field(ev, "event_id")?;

    let title = str_field(ev, "summary").unwrap_or_default();

    let status = match ev.get("status").and_then(Value::as_str) {
        Some("cancelled") => "cancelled",
        _ => "confirmed",
    }
    .to_string();

    let start = ev.get("start_time").map(parse_time_info).unwrap_or_default();
    let end = ev.get("end_time").map(parse_time_info).unwrap_or_default();
    let time = normalize(&start, &end);

    // 重复实例：带非空 recurring_event_id 即为某母事件的展开实例。
    let master_event_id = str_field(ev, "recurring_event_id");

    let (dedup_key, original_start_ts) = match &master_event_id {
        Some(master) => {
            // 实例原始起始：优先 original_time（飞书给的 UTC 秒），否则退回本实例 start_ts，再退 0。
            let original = ev
                .get("original_time")
                .and_then(as_unix_secs)
                .or(start.timestamp)
                .unwrap_or(0);
            (format!("{}:{}", master, original), Some(original))
        }
        None => (remote_event_id.clone(), None),
    };

    // etag：列表响应通常不带；若飞书给了 etag / sequence 就采上，用于后续冲突三态判定。
    let etag = str_field(ev, "etag").or_else(|| {
        ev.get("sequence")
            .and_then(|s| s.as_i64())
            .map(|n| n.to_string())
    });

    Some(MappedEvent {
        remote_event_id,
        dedup_key,
        title,
        status,
        time,
        master_event_id,
        original_start_ts,
        etag,
        is_writable,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 构造定时端点（UTC 秒 + 时区）。
    fn timed(ts: i64, tz: &str) -> RawTime {
        RawTime { date: None, timestamp: Some(ts), timezone: Some(tz.into()) }
    }

    /// 构造全天端点（UTC+0 日历日）。
    fn all_day(date: &str) -> RawTime {
        RawTime { date: Some(date.into()), timestamp: None, timezone: None }
    }

    /* ---------- 铁律①：全天事件零偏移，跨时区都不漂日期 ---------- */

    /// 全天事件：start.date 原样落 scheduled_date，无论「测试时区」是什么都不偏移。
    /// 这里不依赖进程时区——normalize 对全天根本不碰时区，所以 Asia/Shanghai(UTC+8)
    /// 与 America/New_York(UTC-5) 两种 timezone 入参都该得到同一个原样日期。
    #[test]
    fn all_day_zero_offset_no_date_shift() {
        let n = normalize(&all_day("2026-05-29"), &all_day("2026-05-29"));
        assert_eq!(n.scheduled_date.as_deref(), Some("2026-05-29"), "全天日期必须原样，绝不前移一天");
        assert_eq!(n.scheduled_time, None, "全天事件 scheduled_time 必须为 None");
        assert!(n.is_all_day);
        assert_eq!(n.start_ts, None, "全天事件不保留 UTC 秒（表里 NULL）");
        assert_eq!(n.end_ts, None);

        // 即便端点带了时区字段（理论上全天不该带，但脏数据要稳），date 仍原样。
        let dirty = RawTime { date: Some("2026-01-01".into()), timestamp: None, timezone: Some("America/New_York".into()) };
        let n2 = normalize(&dirty, &dirty);
        assert_eq!(n2.scheduled_date.as_deref(), Some("2026-01-01"), "脏数据带时区也不许转换全天日期");
    }

    /* ---------- 铁律②：定时事件按事件时区折算，同一 UTC 不同时区得不同本地钟点 ---------- */

    /// 同一个 UTC 瞬间，用不同事件时区折算 → 不同的本地日期/钟点。
    /// 取 2026-01-01 00:00:00 UTC（= 1767225600）：
    ///  - Asia/Shanghai(UTC+8) → 当地 2026-01-01 08:00
    ///  - America/New_York(UTC-5，冬令) → 当地 2025-12-31 19:00
    #[test]
    fn timed_same_utc_different_tz_different_wallclock() {
        let utc_midnight = 1_767_225_600; // 2026-01-01T00:00:00Z
        let one_hour = utc_midnight + 3600;

        let sh = normalize(&timed(utc_midnight, "Asia/Shanghai"), &timed(one_hour, "Asia/Shanghai"));
        assert_eq!(sh.scheduled_date.as_deref(), Some("2026-01-01"));
        assert_eq!(sh.scheduled_time.as_deref(), Some("08:00-09:00"));
        assert!(!sh.is_all_day);
        assert_eq!(sh.start_ts, Some(utc_midnight), "定时事件保留原始 UTC 秒");
        assert_eq!(sh.end_ts, Some(one_hour));

        let ny = normalize(&timed(utc_midnight, "America/New_York"), &timed(one_hour, "America/New_York"));
        assert_eq!(ny.scheduled_date.as_deref(), Some("2025-12-31"), "纽约时区该回到前一天");
        assert_eq!(ny.scheduled_time.as_deref(), Some("19:00-20:00"));
    }

    /// 缺省时区：定时事件不带 timezone → 按 Asia/Shanghai 折算。
    #[test]
    fn timed_missing_tz_defaults_shanghai() {
        let ts = 1_767_225_600; // 2026-01-01T00:00:00Z → 上海 08:00
        let start = RawTime { date: None, timestamp: Some(ts), timezone: None };
        let end = RawTime { date: None, timestamp: Some(ts + 1800), timezone: None };
        let n = normalize(&start, &end);
        assert_eq!(n.scheduled_date.as_deref(), Some("2026-01-01"));
        assert_eq!(n.scheduled_time.as_deref(), Some("08:00-08:30"));
    }

    /* ---------- 铁律②续：跨天截断 + end<=start 截断 ---------- */

    /// 跨天定时事件：end 落在不同本地日 → scheduled_time 落起始日、end 截到 23:59。
    /// 上海时间 2026-01-01 22:00 → 次日 02:00：起始日 01-01，end 截 23:59。
    #[test]
    fn timed_cross_day_truncates_to_2359() {
        // 2026-01-01 22:00 +08:00 = 2026-01-01T14:00:00Z = 1767276000
        let start_ts = 1_767_276_000;
        // +4h = 2026-01-02 02:00 +08:00（跨到次日本地）
        let end_ts = start_ts + 4 * 3600;
        let n = normalize(&timed(start_ts, "Asia/Shanghai"), &timed(end_ts, "Asia/Shanghai"));
        assert_eq!(n.scheduled_date.as_deref(), Some("2026-01-01"));
        assert_eq!(n.scheduled_time.as_deref(), Some("22:00-23:59"), "跨天必须截到当日 23:59");
        // 原始 UTC 秒仍如实保留（跨天只影响 scheduled_*，不动 start_ts/end_ts）。
        assert_eq!(n.start_ts, Some(start_ts));
        assert_eq!(n.end_ts, Some(end_ts));
    }

    /// end <= start（同日但 end 不晚于 start）→ 同样截到 23:59。
    #[test]
    fn timed_end_not_after_start_truncates() {
        // 上海 10:00 起，end 给成同一秒（end==start）。
        let start_ts = 1_767_225_600 + 2 * 3600; // 上海 10:00
        let n = normalize(&timed(start_ts, "Asia/Shanghai"), &timed(start_ts, "Asia/Shanghai"));
        assert_eq!(n.scheduled_time.as_deref(), Some("10:00-23:59"));
    }

    /// end 缺失 → start+60min，封顶 1439。
    #[test]
    fn timed_missing_end_adds_one_hour() {
        let start_ts = 1_767_225_600 + 2 * 3600; // 上海 10:00
        let end = RawTime::default(); // 无 date 无 timestamp
        let n = normalize(&timed(start_ts, "Asia/Shanghai"), &end);
        assert_eq!(n.scheduled_time.as_deref(), Some("10:00-11:00"));
    }

    /* ---------- 产物必须能被前端 parseScheduledTime 解析 ---------- */

    /// 用与 calendar.ts:100 parseScheduledTime 等价的校验：格式正则 + endMin>startMin + ≤1440。
    /// 覆盖普通、跨天截断两种产物，确保都能往返解析。
    #[test]
    fn scheduled_time_is_parseable_by_frontend() {
        fn parse_ok(s: &str) -> bool {
            // ^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$
            let parts: Vec<&str> = s.split('-').collect();
            if parts.len() != 2 {
                return false;
            }
            let to_min = |hm: &str| -> Option<u32> {
                let (h, m) = hm.split_once(':')?;
                Some(h.parse::<u32>().ok()? * 60 + m.parse::<u32>().ok()?)
            };
            let (Some(sm), Some(em)) = (to_min(parts[0]), to_min(parts[1])) else {
                return false;
            };
            sm < 1440 && em > sm && em <= 1440
        }

        let normal = normalize(&timed(1_767_225_600, "Asia/Shanghai"), &timed(1_767_225_600 + 3600, "Asia/Shanghai"));
        assert!(parse_ok(normal.scheduled_time.as_deref().unwrap()));

        let cross = normalize(&timed(1_767_276_000, "Asia/Shanghai"), &timed(1_767_276_000 + 4 * 3600, "Asia/Shanghai"));
        assert!(parse_ok(cross.scheduled_time.as_deref().unwrap()), "跨天截断产物也必须可解析");
    }

    /* ---------- 铁律③：dedup_key 三态 + 铁律④：cancelled ---------- */

    /// 非重复事件：dedup_key = remote_event_id，master/original_start 均为 None。
    #[test]
    fn map_event_non_recurring_dedup_key() {
        let ev = json!({
            "event_id": "ev_123",
            "summary": "周会",
            "status": "confirmed",
            "start_time": { "timestamp": "1767225600", "timezone": "Asia/Shanghai" },
            "end_time":   { "timestamp": "1767229200", "timezone": "Asia/Shanghai" }
        });
        let m = map_event(Region::Feishu, "cal_1", true, &ev).unwrap();
        assert_eq!(m.remote_event_id, "ev_123");
        assert_eq!(m.dedup_key, "ev_123", "非重复事件去重键就是 event_id");
        assert_eq!(m.master_event_id, None);
        assert_eq!(m.original_start_ts, None);
        assert_eq!(m.status, "confirmed");
        assert_eq!(m.title, "周会");
        assert!(m.is_writable);
        assert_eq!(m.time.scheduled_time.as_deref(), Some("08:00-09:00"));
    }

    /// 重复实例：dedup_key = "{master}:{original_start}"，original_start_ts 落 original_time。
    #[test]
    fn map_event_recurring_instance_dedup_key() {
        let ev = json!({
            "event_id": "ev_inst_1",
            "summary": "每日站会",
            "recurring_event_id": "master_abc",
            "original_time": 1767225600_i64,
            "start_time": { "timestamp": "1767225600", "timezone": "Asia/Shanghai" },
            "end_time":   { "timestamp": "1767226200", "timezone": "Asia/Shanghai" }
        });
        let m = map_event(Region::Feishu, "cal_1", false, &ev).unwrap();
        assert_eq!(m.dedup_key, "master_abc:1767225600", "重复实例去重键 = master:original_start");
        assert_eq!(m.master_event_id.as_deref(), Some("master_abc"));
        assert_eq!(m.original_start_ts, Some(1767225600));
        assert!(!m.is_writable);
    }

    /// 重复实例缺 original_time → 退回本实例 start_ts 作为 original_start（键仍稳定）。
    #[test]
    fn map_event_recurring_fallback_to_start_ts() {
        let ev = json!({
            "event_id": "ev_inst_2",
            "recurring_event_id": "master_xyz",
            "start_time": { "timestamp": "1767311999", "timezone": "Asia/Shanghai" },
            "end_time":   { "timestamp": "1767315599", "timezone": "Asia/Shanghai" }
        });
        let m = map_event(Region::Feishu, "cal_1", true, &ev).unwrap();
        assert_eq!(m.dedup_key, "master_xyz:1767311999");
        assert_eq!(m.original_start_ts, Some(1767311999));
    }

    /// cancelled：飞书 status=="cancelled" → 'cancelled'（其余值都当 confirmed）。
    #[test]
    fn map_event_cancelled_status() {
        let ev = json!({
            "event_id": "ev_del",
            "status": "cancelled",
            "start_time": { "timestamp": "1767225600", "timezone": "Asia/Shanghai" },
            "end_time":   { "timestamp": "1767229200", "timezone": "Asia/Shanghai" }
        });
        let m = map_event(Region::Feishu, "cal_1", true, &ev).unwrap();
        assert_eq!(m.status, "cancelled");

        // tentative 等其它状态 → confirmed。
        let ev2 = json!({
            "event_id": "ev_t",
            "status": "tentative",
            "start_time": { "timestamp": "1767225600", "timezone": "Asia/Shanghai" }
        });
        assert_eq!(map_event(Region::Feishu, "cal_1", true, &ev2).unwrap().status, "confirmed");
    }

    /// 全天事件经 map_event：is_all_day=true、scheduled_date 原样、scheduled_time=None。
    #[test]
    fn map_event_all_day_round_trip() {
        let ev = json!({
            "event_id": "ev_allday",
            "summary": "国庆假期",
            "start_time": { "date": "2026-10-01" },
            "end_time":   { "date": "2026-10-01" }
        });
        let m = map_event(Region::Feishu, "cal_1", false, &ev).unwrap();
        assert!(m.time.is_all_day);
        assert_eq!(m.time.scheduled_date.as_deref(), Some("2026-10-01"));
        assert_eq!(m.time.scheduled_time, None);
        assert_eq!(m.time.start_ts, None);
    }

    /// 缺 event_id → None（无法去重/落库，整条丢弃而非 panic）。
    #[test]
    fn map_event_missing_id_returns_none() {
        let ev = json!({ "summary": "无 id 的脏数据" });
        assert!(map_event(Region::Feishu, "cal_1", true, &ev).is_none());
    }

    /// timestamp 既支持字符串也支持数字（飞书有时给字符串秒）。
    #[test]
    fn map_event_accepts_numeric_timestamp() {
        let ev = json!({
            "event_id": "ev_num",
            "start_time": { "timestamp": 1767225600_i64, "timezone": "Asia/Shanghai" },
            "end_time":   { "timestamp": 1767229200_i64, "timezone": "Asia/Shanghai" }
        });
        let m = map_event(Region::Feishu, "cal_1", true, &ev).unwrap();
        assert_eq!(m.time.scheduled_time.as_deref(), Some("08:00-09:00"));
        assert_eq!(m.time.start_ts, Some(1767225600));
    }
}
