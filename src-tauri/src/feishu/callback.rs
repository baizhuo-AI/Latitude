//! OAuth 回调监听：授权完成后飞书把浏览器重定向到本地回环地址，这里起一个一次性
//! 的本地 HTTP 监听把 `code` 接住。
//!
//! 关键决策：飞书后台的 redirect_uri 必须**预注册且精确匹配**、不支持自定义 scheme，
//! 所以只能用固定端口的 `http://127.0.0.1:PORT/...` 回环地址（不能用动态端口）。
//! 端口 [`CALLBACK_PORT`] 的值要逐字写进给用户的"在飞书后台填这个回调地址"说明里。

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// 本地回调端口。避开内嵌 MCP server 的 42800。改这里要同步改给用户的配置说明。
pub const CALLBACK_PORT: u16 = 42801;

/// 完整回调地址，供「拼授权 URL 的 redirect_uri」与「飞书后台预注册」共用同一处常量。
pub fn redirect_uri() -> String {
    format!("http://127.0.0.1:{CALLBACK_PORT}/feishu/callback")
}

/// 回调里解出的授权结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Callback {
    pub code: String,
    pub state: String,
}

/// 从 query 串（如 `code=abc&state=S`）解出 code+state；缺任一为 None。纯函数，可单测。
fn parse_callback(query: &str) -> Option<Callback> {
    let mut code = None;
    let mut state = None;
    for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            _ => {}
        }
    }
    Some(Callback {
        code: code?,
        state: state?,
    })
}

/// 在已绑定的 listener 上等一个回调连接（带超时），校验 state 后返回。测试用注入式
/// listener（临时端口）避免与固定端口冲突、且可并行。
async fn wait_on_listener(
    listener: TcpListener,
    expected_state: &str,
    timeout: Duration,
) -> Result<Callback, String> {
    let accept = async {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| format!("接受回调连接失败：{e}"))?;

        // 请求行在最前，读一段足够覆盖 "GET /feishu/callback?... HTTP/1.1" + 头。
        let mut buf = vec![0u8; 4096];
        let n = stream
            .read(&mut buf)
            .await
            .map_err(|e| format!("读取回调请求失败：{e}"))?;
        let req = String::from_utf8_lossy(&buf[..n]);

        // 第一行第二个 token 是请求目标：/feishu/callback?code=...&state=...
        let target = req
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .ok_or_else(|| "回调请求格式异常".to_string())?;
        let query = target.split_once('?').map(|(_, q)| q).unwrap_or("");
        let cb = parse_callback(query).ok_or_else(|| "回调缺少 code/state".to_string())?;

        // 校验 state 防 CSRF；无论成败都回一个页面让用户知道结果。
        let ok = cb.state == expected_state;
        let body = if ok {
            "<!doctype html><meta charset=utf-8><body style=\"font-family:system-ui;text-align:center;padding-top:64px\"><h2>授权成功 ✅</h2><p>可以关闭此页面，返回 Latitude。</p></body>"
        } else {
            "<!doctype html><meta charset=utf-8><body style=\"font-family:system-ui;text-align:center;padding-top:64px\"><h2>授权校验失败</h2><p>state 不匹配，请回到 Latitude 重试。</p></body>"
        };
        let status = if ok { "200 OK" } else { "400 Bad Request" };
        let resp = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.as_bytes().len()
        );
        let _ = stream.write_all(resp.as_bytes()).await;
        let _ = stream.flush().await;

        if ok {
            Ok(cb)
        } else {
            Err("回调 state 不匹配（可能遭遇 CSRF），已拒绝".to_string())
        }
    };

    match tokio::time::timeout(timeout, accept).await {
        Ok(res) => res,
        Err(_) => Err("等待 OAuth 回调超时".to_string()),
    }
}

/// 绑定固定端口、等浏览器回调、校验 state、回一个友好页面，返回授权 code。
/// 5 分钟超时（与飞书 authorization code 5 分钟有效期对齐）。
pub async fn wait_for_callback(expected_state: &str) -> Result<Callback, String> {
    let listener = TcpListener::bind(("127.0.0.1", CALLBACK_PORT))
        .await
        .map_err(|e| format!("回调端口 {CALLBACK_PORT} 绑定失败：{e}"))?;
    wait_on_listener(listener, expected_state, Duration::from_secs(300)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpStream;

    #[test]
    fn parse_callback_extracts_code_and_state() {
        assert_eq!(
            parse_callback("code=abc&state=xyz"),
            Some(Callback { code: "abc".into(), state: "xyz".into() })
        );
    }

    #[test]
    fn parse_callback_percent_decodes() {
        // 'a+b' 在 query 里编码为 a%2Bb；'+' 字面量解码为空格
        assert_eq!(
            parse_callback("code=a%2Bb&state=s%20t").map(|c| c.code),
            Some("a+b".to_string())
        );
    }

    #[test]
    fn parse_callback_missing_code_is_none() {
        assert_eq!(parse_callback("state=only"), None);
    }

    #[tokio::test]
    async fn wait_on_listener_returns_callback_on_match() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server =
            tokio::spawn(async move { wait_on_listener(listener, "S", Duration::from_secs(5)).await });

        let mut client = TcpStream::connect(addr).await.unwrap();
        client
            .write_all(b"GET /feishu/callback?code=abc&state=S HTTP/1.1\r\nHost: x\r\n\r\n")
            .await
            .unwrap();
        // 读一下响应，确保 server 写了回包
        let mut buf = [0u8; 64];
        let _ = client.read(&mut buf).await;

        let got = server.await.unwrap();
        assert_eq!(got, Ok(Callback { code: "abc".into(), state: "S".into() }));
    }

    #[tokio::test]
    async fn wait_on_listener_rejects_state_mismatch() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            wait_on_listener(listener, "EXPECTED", Duration::from_secs(5)).await
        });

        let mut client = TcpStream::connect(addr).await.unwrap();
        client
            .write_all(b"GET /feishu/callback?code=abc&state=WRONG HTTP/1.1\r\n\r\n")
            .await
            .unwrap();
        let mut buf = [0u8; 64];
        let _ = client.read(&mut buf).await;

        let got = server.await.unwrap();
        assert!(got.is_err(), "state 不匹配应返回 Err，实际 {got:?}");
    }
}
