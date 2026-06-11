//! 飞书凭证与 token 的安全存储：一律进 macOS 系统钥匙串（Keychain），不落明文文件。
//!
//! 这是对历史欠债的修正：现状 LLM key 明文存 localStorage、MCP token 明文存
//! mcp_token.txt。飞书的 app_secret / refresh_token 尤其敏感（refresh_token 一次性、
//! 关系到长期后台同步不掉线），必须走 keychain。
//!
//! account key = `{region}:{kind}`，service 固定。同一区域的三类密钥分三条记录。

use keyring::Entry;

use crate::feishu::Region;

/// 钥匙串 service 名（同一 App 下飞书相关密钥的命名空间）。
const KEYRING_SERVICE: &str = "com.daybreak.desktop.feishu";

/// 三类要进钥匙串的密钥。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Secret {
    /// 应用密钥（用户在设置页填，换 token 时必带）。
    AppSecret,
    /// user_access_token（约 2 小时过期）。
    AccessToken,
    /// refresh_token（一次性，每次刷新换新的，必须可靠持久化）。
    RefreshToken,
}

impl Secret {
    /// 落进 account key 的稳定字符串。
    fn kind(self) -> &'static str {
        match self {
            Secret::AppSecret => "app_secret",
            Secret::AccessToken => "access_token",
            Secret::RefreshToken => "refresh_token",
        }
    }
}

/// keychain account key：`{region}:{kind}`，如 `lark:access_token`。纯函数，可单测。
fn account_key(region: Region, secret: Secret) -> String {
    format!("{}:{}", region.tag(), secret.kind())
}

/// 写入一条密钥（覆盖式）。
pub fn set_secret(region: Region, secret: Secret, value: &str) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, &account_key(region, secret))
        .map_err(|e| format!("打开钥匙串条目失败：{e}"))?;
    entry
        .set_password(value)
        .map_err(|e| format!("写入钥匙串失败：{e}"))
}

/// 读一条密钥。**没存过返回 `Ok(None)`**（上层靠"有没有 token"判连接态，不能让
/// "没存过"变成报错）。
pub fn get_secret(region: Region, secret: Secret) -> Result<Option<String>, String> {
    let entry = Entry::new(KEYRING_SERVICE, &account_key(region, secret))
        .map_err(|e| format!("打开钥匙串条目失败：{e}"))?;
    match entry.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("读取钥匙串失败：{e}")),
    }
}

/// 删一条密钥。没存过也算成功（幂等）。
pub fn delete_secret(region: Region, secret: Secret) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, &account_key(region, secret))
        .map_err(|e| format!("打开钥匙串条目失败：{e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("删除钥匙串条目失败：{e}")),
    }
}

/// 清空某区域全部三类密钥（断开连接时用）。
pub fn clear_region(region: Region) -> Result<(), String> {
    delete_secret(region, Secret::AppSecret)?;
    delete_secret(region, Secret::AccessToken)?;
    delete_secret(region, Secret::RefreshToken)?;
    Ok(())
}

/// 同步引擎要用的聚合凭证。app_id 来自明文 config（非密钥），由调用方传入。
#[derive(Debug, Clone)]
pub struct Credentials {
    pub app_id: String,
    pub app_secret: String,
    pub access_token: String,
    pub refresh_token: String,
}

/// 读齐一个区域的全套凭证；只有 app_secret + access + refresh **三者都在**才算可用
/// （否则尚未授权 / 已断开），返回 None。
pub fn load_credentials(region: Region, app_id: &str) -> Result<Option<Credentials>, String> {
    let app_secret = get_secret(region, Secret::AppSecret)?;
    let access_token = get_secret(region, Secret::AccessToken)?;
    let refresh_token = get_secret(region, Secret::RefreshToken)?;
    Ok(match (app_secret, access_token, refresh_token) {
        (Some(app_secret), Some(access_token), Some(refresh_token)) => Some(Credentials {
            app_id: app_id.to_string(),
            app_secret,
            access_token,
            refresh_token,
        }),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_kind_strings_are_stable() {
        assert_eq!(Secret::AppSecret.kind(), "app_secret");
        assert_eq!(Secret::AccessToken.kind(), "access_token");
        assert_eq!(Secret::RefreshToken.kind(), "refresh_token");
    }

    #[test]
    fn account_key_combines_region_and_kind() {
        assert_eq!(account_key(Region::Lark, Secret::AccessToken), "lark:access_token");
        assert_eq!(account_key(Region::Feishu, Secret::AppSecret), "feishu:app_secret");
        assert_eq!(
            account_key(Region::Feishu, Secret::RefreshToken),
            "feishu:refresh_token"
        );
    }

    /// 真实钥匙串读写往返。涉及系统钥匙串、可能弹权限框，默认不在 CI/自动测试里跑；
    /// 手动验证用：`cargo test --lib feishu::keychain -- --ignored`。
    #[test]
    #[ignore = "touches the real macOS keychain; run manually"]
    fn live_roundtrip() {
        let r = Region::Feishu;
        set_secret(r, Secret::AccessToken, "tok-xyz").unwrap();
        assert_eq!(get_secret(r, Secret::AccessToken).unwrap().as_deref(), Some("tok-xyz"));
        delete_secret(r, Secret::AccessToken).unwrap();
        assert_eq!(get_secret(r, Secret::AccessToken).unwrap(), None);
    }
}
