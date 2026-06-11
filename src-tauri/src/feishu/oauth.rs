//! 飞书 / Lark OAuth：PKCE 生成、授权 URL 拼装、（后续）授权码换 token / 刷新。
//!
//! 关键事实（已查官方文档确认）：飞书换 token 强制要 `client_secret`，PKCE 只是给
//! 授权码加固、**不能免 secret**，也没有"公开客户端"应用类型。因此本项目采用
//! 「客户自建应用 + 用户自填 app_id/app_secret（存 keychain）+ 零后端」模型，PKCE
//! 仍然加上以缩小授权码被截获的风险。
//!
//! 本文件只放**纯逻辑**（PKCE/URL，可单测）。`exchange_code` / `refresh` 这类需要
//! 真实凭证 + 网络的 HTTP 调用在 P0-6 接入，验证归联调。

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::Rng;
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;

use crate::feishu::Region;

/// token 端点路径（v2，拼在 `Region::api_base()` 之后）。授权用 v1、换/刷新用 v2，
/// 版本号不一致是飞书的设计，别"统一"。
const TOKEN_PATH: &str = "/authen/v2/oauth/token";

/// 申请的 OAuth scope。
///
/// 产品决策：目标是双向同步，**一开始就申请读写**（用户拍板），避免 Phase 4 做写回时
/// 因 scope 变更而被迫重新授权一次。
/// - `calendar:calendar`：读写大权限，一把覆盖日历列表 / 日程列表 / 单日程 / 订阅 / 增删改。
/// - `offline_access`：拿可长期续期的 refresh_token（否则后台同步会掉登录）。
///
/// 代价（注意）：只读阶段（Phase 0-3）就已持有写权限，企业管理员审批门槛比纯只读更高、
/// 可能更慢。若审批受阻，回退方案是先用 `calendar:calendar:readonly` 起步、Phase 4 再升级。
pub const SCOPES: &[&str] = &["calendar:calendar", "offline_access"];

/// 授权页路径（拼在 `Region::api_base()` 之后）。
const AUTHORIZE_PATH: &str = "/authen/v1/authorize";

/// PKCE 一对：`verifier` 自留、`challenge` 放进授权 URL。
#[derive(Debug, Clone)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

/// PKCE code_challenge = base64url-nopad( SHA256( verifier ) )，method S256。
/// 纯函数，便于用 RFC 7636 标准向量单测。
pub fn code_challenge(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(hasher.finalize())
}

/// 生成一对 PKCE。verifier 取 32 字节随机 → base64url-nopad（43 字符，全部落在
/// RFC 7636 的 unreserved 字符集，长度合法 43..=128）。
pub fn gen_pkce() -> Pkce {
    let bytes: [u8; 32] = rand::thread_rng().gen();
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = code_challenge(&verifier);
    Pkce { verifier, challenge }
}

/// 生成防 CSRF 的 state（16 字节随机 → base64url-nopad）。
pub fn gen_state() -> String {
    let bytes: [u8; 16] = rand::thread_rng().gen();
    URL_SAFE_NO_PAD.encode(bytes)
}

/// 拼授权 URL：`https://{host}/open-apis/authen/v1/authorize?...`。
/// 6 个 query：app_id / redirect_uri / scope(空格分隔) / state / code_challenge /
/// code_challenge_method=S256。
///
/// 注意：飞书有 v1(`authen/v1/authorize`) 与 v2(`authen/v2/oauth/authorize`) 两个授权
/// 端点，参数名略有差异（v1 用 app_id）。此处按实施计划取 v1；最终以哪个端点为准
/// 需联调时用真实凭证确认，端点改这一个常量即可。
pub fn build_authorize_url(
    region: Region,
    app_id: &str,
    redirect_uri: &str,
    scopes: &[&str],
    state: &str,
    challenge: &str,
) -> String {
    let mut u = Url::parse(&format!("{}{}", region.api_base(), AUTHORIZE_PATH))
        .expect("api_base 拼授权路径应是合法 URL");
    u.query_pairs_mut()
        .append_pair("app_id", app_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", &scopes.join(" "))
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256");
    u.to_string()
}

/// 换/刷新得到的一组 token。`expires_in` / `refresh_token_expires_in` 是**相对秒数**，
/// 转成绝对过期时间戳由调用方做（保持本层纯粹）。
#[derive(Debug, Clone)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: i64,
    pub refresh_token_expires_in: i64,
}

/// 解析 token 端点响应。对三种形态健壮：成功（有 access_token）、飞书风格错误
/// （code 非 0 + msg）、OAuth2 风格错误（error/error_description）。纯函数，可单测。
/// 注意：v2 的精确响应结构需联调用真实 code 确认；此处按"顶层带 token 字段"解析。
fn parse_token_response(v: &Value) -> Result<TokenSet, String> {
    // 飞书风格错误：code 字段非 0
    if let Some(code) = v.get("code").and_then(Value::as_i64) {
        if code != 0 {
            let msg = v.get("msg").and_then(Value::as_str).unwrap_or("未知错误");
            return Err(format!("换取 token 失败（code {code}）：{msg}"));
        }
    }
    // 成功：顶层有 access_token
    if let Some(at) = v.get("access_token").and_then(Value::as_str) {
        return Ok(TokenSet {
            access_token: at.to_string(),
            refresh_token: v
                .get("refresh_token")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            expires_in: v.get("expires_in").and_then(Value::as_i64).unwrap_or(0),
            refresh_token_expires_in: v
                .get("refresh_token_expires_in")
                .and_then(Value::as_i64)
                .unwrap_or(0),
        });
    }
    // OAuth2 风格错误
    let err = v
        .get("error_description")
        .and_then(Value::as_str)
        .or_else(|| v.get("error").and_then(Value::as_str))
        .or_else(|| v.get("msg").and_then(Value::as_str))
        .unwrap_or("响应缺少 access_token");
    Err(format!("换取 token 失败：{err}"))
}

/// 用授权码换 user_access_token。强制带 client_secret（飞书无免密公开客户端）。
/// HTTP 调用，需真实 code，端到端验证归联调。
pub async fn exchange_code(
    client: &reqwest::Client,
    region: Region,
    app_id: &str,
    app_secret: &str,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<TokenSet, String> {
    let url = format!("{}{}", region.api_base(), TOKEN_PATH);
    let body = serde_json::json!({
        "grant_type": "authorization_code",
        "client_id": app_id,
        "client_secret": app_secret,
        "code": code,
        "code_verifier": code_verifier,
        "redirect_uri": redirect_uri,
    });
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求 token 接口失败：{e}"))?;
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("解析 token 响应 JSON 失败：{e}"))?;
    parse_token_response(&v)
}

/// 用 refresh_token 刷新 user_access_token。响应会带**新的** refresh_token（飞书
/// refresh_token 一次性、旧的立即失效），调用方必须把新值落库覆盖旧值。
/// HTTP 调用，需真实 refresh_token，端到端验证归联调。
pub async fn refresh(
    client: &reqwest::Client,
    region: Region,
    app_id: &str,
    app_secret: &str,
    refresh_token: &str,
) -> Result<TokenSet, String> {
    let url = format!("{}{}", region.api_base(), TOKEN_PATH);
    let body = serde_json::json!({
        "grant_type": "refresh_token",
        "client_id": app_id,
        "client_secret": app_secret,
        "refresh_token": refresh_token,
    });
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求刷新 token 失败：{e}"))?;
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("解析刷新 token 响应 JSON 失败：{e}"))?;
    parse_token_response(&v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// RFC 7636 Appendix B 标准测试向量：verifier → challenge 必须一字不差。
    #[test]
    fn code_challenge_matches_rfc7636_vector() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        assert_eq!(code_challenge(verifier), expected);
    }

    #[test]
    fn gen_pkce_verifier_is_valid_and_challenge_matches() {
        let p = gen_pkce();
        // 长度合法
        assert!(
            p.verifier.len() >= 43 && p.verifier.len() <= 128,
            "verifier len {} out of [43,128]",
            p.verifier.len()
        );
        // 全部是 unreserved 字符（base64url 集合 + 不含 padding）
        assert!(
            p.verifier
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "verifier has non-unreserved chars: {}",
            p.verifier
        );
        // challenge 与 verifier 自洽
        assert_eq!(p.challenge, code_challenge(&p.verifier));
    }

    #[test]
    fn gen_state_is_nonempty_and_varies() {
        let a = gen_state();
        let b = gen_state();
        assert!(!a.is_empty());
        assert_ne!(a, b, "两次 state 不应相同（随机性）");
    }

    #[test]
    fn authorize_url_has_correct_host_path_and_params() {
        let url = build_authorize_url(
            Region::Lark,
            "cli_app123",
            "http://127.0.0.1:42801/feishu/callback",
            &["calendar:calendar:readonly", "offline_access"],
            "st4te",
            "chal_lenge",
        );
        let parsed = Url::parse(&url).expect("应是合法 URL");
        assert_eq!(parsed.host_str(), Some("open.larksuite.com"));
        assert_eq!(parsed.path(), "/open-apis/authen/v1/authorize");

        let q: HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(q.get("app_id").map(String::as_str), Some("cli_app123"));
        assert_eq!(
            q.get("redirect_uri").map(String::as_str),
            Some("http://127.0.0.1:42801/feishu/callback")
        );
        // scope 空格分隔，解码后还原
        assert_eq!(
            q.get("scope").map(String::as_str),
            Some("calendar:calendar:readonly offline_access")
        );
        assert_eq!(q.get("state").map(String::as_str), Some("st4te"));
        assert_eq!(q.get("code_challenge").map(String::as_str), Some("chal_lenge"));
        assert_eq!(
            q.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
    }

    /// host 随 region 切换。
    #[test]
    fn authorize_url_switches_host_by_region() {
        let u = build_authorize_url(Region::Feishu, "a", "http://x/cb", &["s"], "st", "ch");
        assert_eq!(Url::parse(&u).unwrap().host_str(), Some("open.feishu.cn"));
    }

    #[test]
    fn parse_token_response_reads_success() {
        let v = serde_json::json!({
            "code": 0,
            "access_token": "u-abc",
            "refresh_token": "r-xyz",
            "expires_in": 7200,
            "refresh_token_expires_in": 604800
        });
        let t = parse_token_response(&v).expect("应解析成功");
        assert_eq!(t.access_token, "u-abc");
        assert_eq!(t.refresh_token, "r-xyz");
        assert_eq!(t.expires_in, 7200);
        assert_eq!(t.refresh_token_expires_in, 604800);
    }

    #[test]
    fn parse_token_response_feishu_style_error() {
        let v = serde_json::json!({ "code": 20037, "msg": "invalid authorization code" });
        let e = parse_token_response(&v).unwrap_err();
        assert!(e.contains("20037") && e.contains("invalid authorization code"), "{e}");
    }

    #[test]
    fn parse_token_response_oauth2_style_error() {
        let v = serde_json::json!({ "error": "invalid_grant", "error_description": "code expired" });
        let e = parse_token_response(&v).unwrap_err();
        assert!(e.contains("code expired"), "{e}");
    }
}
