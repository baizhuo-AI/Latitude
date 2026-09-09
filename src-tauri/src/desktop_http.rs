//! The desktop WebViews use this IPC transport for the two local services.
//! CORS stays a browser boundary: no wildcard origin or external HTTP proxy is
//! introduced just to make the packaged desktop app work.

use std::collections::HashMap;

use reqwest::{header::HeaderName, redirect::Policy, Client, Method, Url};
use serde::Serialize;
use tauri::{Manager, WebviewWindow};

pub struct DesktopHttpClient(Client);

impl DesktopHttpClient {
    pub fn new() -> Result<Self, reqwest::Error> {
        Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .build()
            .map(Self)
    }
}

#[derive(Serialize)]
pub struct DesktopHttpResponse {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

fn local_service_url(raw: &str) -> Result<Url, String> {
    let mut url = Url::parse(raw).map_err(|_| "Invalid local service URL".to_string())?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        || !matches!(url.port(), Some(43120 | 43121))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Desktop HTTP only permits the local Agent and Domain services".into());
    }
    // Resolve localhost ourselves so a proxy or a modified DNS answer cannot
    // turn this narrowly scoped IPC command into an external request.
    url.set_host(Some("127.0.0.1"))
        .map_err(|_| "Invalid loopback host".to_string())?;
    Ok(url)
}

#[tauri::command]
pub async fn desktop_http_request(
    window: WebviewWindow,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<DesktopHttpResponse, String> {
    if !matches!(window.label(), "main" | "pet" | "chatbar" | "pet-notice") {
        return Err("This window does not use the desktop runtime".into());
    }
    let url = local_service_url(&url)?;
    let method = Method::from_bytes(method.as_bytes()).map_err(|_| "Invalid HTTP method")?;
    if !matches!(
        method.as_str(),
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"
    ) {
        return Err("Unsupported local service method".into());
    }
    let client = &window.state::<DesktopHttpClient>().0;
    let mut request = client.request(method, url);
    for (name, value) in headers {
        let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| "Invalid HTTP header")?;
        if matches!(
            name.as_str(),
            "host"
                | "connection"
                | "transfer-encoding"
                | "content-length"
                | "proxy-authorization"
                | "origin"
        ) {
            continue;
        }
        request = request.header(name, value);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.to_string(), value.to_string()))
        })
        .collect();
    let body = response.text().await.map_err(|error| error.to_string())?;
    Ok(DesktopHttpResponse {
        status,
        headers,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_exact_local_service_targets_are_accepted() {
        assert_eq!(
            local_service_url("http://localhost:43120/v1/agent/runs")
                .unwrap()
                .host_str(),
            Some("127.0.0.1")
        );
        assert!(local_service_url("http://127.0.0.1:43121/v1/context?limit=20").is_ok());
        for raw in [
            "https://127.0.0.1:43120/",
            "http://127.0.0.1:80/",
            "http://localhost.example.com:43120/",
            "http://example.com:43120/",
            "http://user@localhost:43120/",
            "http://localhost:43120/#fragment",
            "http://[::1]:43120/",
            "file:///etc/hosts",
        ] {
            assert!(local_service_url(raw).is_err(), "{raw}");
        }
    }
}
