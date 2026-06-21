//! 飞书 / Lark 日历同步模块。
//!
//! 子模块按职责拆分（详见仓库内实施计划文档的「模块落点」一节）。本文件持有跨
//! 子模块共享的 [`Region`]：域名只在这里定义一处，杜绝硬编码散落到各处。

use serde::{Deserialize, Serialize};

pub mod bitable;
pub mod callback;
pub mod client;
pub mod commands;
pub mod config;
pub mod db;
pub mod engine;
pub mod inbound;
pub mod keychain;
pub mod normalize;
pub mod oauth;
pub mod outbound;
pub mod sync;
pub mod writeback;

/// 部署区域。
///
/// 飞书（国内，open.feishu.cn）与 Lark（国际，open.larksuite.com）是两套**相互
/// 独立**的平台：不同域名、不同应用凭证、不同数据中心。用户在连接时显式选择，
/// 运行时按此切换 host 与对应凭证。序列化成小写字符串与前端 `"feishu"|"lark"` 对齐。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Region {
    Feishu,
    Lark,
}

impl Region {
    /// 开放平台主机名。所有飞书 OpenAPI 都挂在 `https://{host}/open-apis/...` 下。
    pub fn host(self) -> &'static str {
        match self {
            Region::Feishu => "open.feishu.cn",
            Region::Lark => "open.larksuite.com",
        }
    }

    /// API 基址（含 scheme + `/open-apis` 前缀），业务接口在其后接 `/<service>/<version>/<resource>`。
    pub fn api_base(self) -> String {
        format!("https://{}/open-apis", self.host())
    }

    /// 字符串标签 → Region（从前端入参 / 配置文件读取 `"feishu"|"lark"`）。
    pub fn from_tag(tag: &str) -> Option<Region> {
        match tag {
            "feishu" => Some(Region::Feishu),
            "lark" => Some(Region::Lark),
            _ => None,
        }
    }

    /// Region → 字符串标签（落库 / 传前端 / keychain account key 用）。
    pub fn tag(self) -> &'static str {
        match self {
            Region::Feishu => "feishu",
            Region::Lark => "lark",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_maps_per_region() {
        assert_eq!(Region::Feishu.host(), "open.feishu.cn");
        assert_eq!(Region::Lark.host(), "open.larksuite.com");
    }

    #[test]
    fn api_base_wraps_host() {
        assert_eq!(Region::Feishu.api_base(), "https://open.feishu.cn/open-apis");
        assert_eq!(Region::Lark.api_base(), "https://open.larksuite.com/open-apis");
    }

    #[test]
    fn tag_roundtrips() {
        for r in [Region::Feishu, Region::Lark] {
            assert_eq!(Region::from_tag(r.tag()), Some(r));
        }
        assert_eq!(Region::from_tag("feishu"), Some(Region::Feishu));
        assert_eq!(Region::from_tag("lark"), Some(Region::Lark));
        assert_eq!(Region::from_tag("nope"), None);
    }
}
