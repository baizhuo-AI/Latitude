//! 飞书/Lark 的**非敏感**配置落盘（`feishu_config.json`，与 latitude.db 同目录）。
//!
//! 关键决策：敏感/非敏感分家——`app_id`（公开）、连接状态、token 过期时间走这份明文
//! JSON；`app_secret`、access/refresh token 走 OS keychain（见 keychain.rs），绝不进这里。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::feishu::Region;

/// 配置文件名（放在 app config 目录下）。
const CONFIG_FILE: &str = "feishu_config.json";

/// 单个区域的非敏感配置。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegionConfig {
    /// 应用 App ID（公开信息，可明文）。secret 不在这里，存 keychain。
    pub app_id: Option<String>,
    /// 是否已完成 OAuth 授权（钥匙串里有有效 token）。
    pub connected: bool,
    /// access_token 绝对过期时间（Unix 秒），用于判断是否需要刷新。
    pub token_expires_at: Option<i64>,
    /// 最近一次错误（授权/刷新/同步失败原因），供设置页展示。
    pub last_error: Option<String>,
}

/// 全部飞书配置：当前激活区域 + 两个区域各自的配置。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeishuConfig {
    pub active_region: Option<Region>,
    pub feishu: RegionConfig,
    pub lark: RegionConfig,
}

impl FeishuConfig {
    /// 取某区域配置的可变引用，便于按 region 改写。
    pub fn region_mut(&mut self, region: Region) -> &mut RegionConfig {
        match region {
            Region::Feishu => &mut self.feishu,
            Region::Lark => &mut self.lark,
        }
    }

    /// 取某区域配置的只读引用。
    pub fn region(&self, region: Region) -> &RegionConfig {
        match region {
            Region::Feishu => &self.feishu,
            Region::Lark => &self.lark,
        }
    }
}

fn config_path(config_dir: &Path) -> PathBuf {
    config_dir.join(CONFIG_FILE)
}

/// 读配置。文件缺失或损坏一律返回默认值（不让"没配置过"或"手抖改坏 json"变成报错）。
pub fn load(config_dir: &Path) -> FeishuConfig {
    match std::fs::read_to_string(config_path(config_dir)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => FeishuConfig::default(),
    }
}

/// 写配置（pretty JSON）。父目录不存在则创建。
pub fn save(config_dir: &Path, cfg: &FeishuConfig) -> Result<(), String> {
    std::fs::create_dir_all(config_dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    let json = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化飞书配置失败：{e}"))?;
    std::fs::write(config_path(config_dir), json).map_err(|e| format!("写飞书配置文件失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个测试用独立临时目录，避免相互干扰、可并行。
    fn tmp_dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("latitude_feishu_cfg_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn load_missing_returns_default() {
        let dir = tmp_dir();
        let cfg = load(&dir);
        assert_eq!(cfg, FeishuConfig::default());
        assert!(cfg.active_region.is_none());
        assert!(!cfg.feishu.connected);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = tmp_dir();
        let mut cfg = FeishuConfig::default();
        cfg.active_region = Some(Region::Lark);
        cfg.region_mut(Region::Lark).app_id = Some("cli_abc".into());
        cfg.region_mut(Region::Lark).connected = true;
        cfg.region_mut(Region::Lark).token_expires_at = Some(1_900_000_000);

        save(&dir, &cfg).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded, cfg);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_corrupt_returns_default() {
        let dir = tmp_dir();
        std::fs::write(config_path(&dir), b"{ not valid json ").unwrap();
        assert_eq!(load(&dir), FeishuConfig::default());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn region_mut_targets_correct_side() {
        let mut cfg = FeishuConfig::default();
        cfg.region_mut(Region::Feishu).app_id = Some("f".into());
        cfg.region_mut(Region::Lark).app_id = Some("l".into());
        assert_eq!(cfg.region(Region::Feishu).app_id.as_deref(), Some("f"));
        assert_eq!(cfg.region(Region::Lark).app_id.as_deref(), Some("l"));
    }
}
