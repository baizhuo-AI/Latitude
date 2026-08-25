use axum::http::{HeaderValue, Uri};
use latitude_domain_service::{build_router_for_origins, AppState, Database};
use std::{env, net::SocketAddr, path::PathBuf};
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "latitude_domain_service=info".into()),
        )
        .init();

    let db_path = env::var_os("LATITUDE_DB_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".latitude/latitude-domain.db"));
    let backup_dir = env::var_os("LATITUDE_BACKUP_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".latitude/backups"));
    let address: SocketAddr = env::var("LATITUDE_DOMAIN_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:43121".into())
        .parse()?;
    if !address.ip().is_loopback() {
        return Err("LATITUDE_DOMAIN_ADDR must use a loopback address".into());
    }
    let web_port = env::var("LATITUDE_WEB_PORT")
        .unwrap_or_else(|_| "1420".into())
        .parse::<u16>()
        .map_err(|_| "LATITUDE_WEB_PORT must be an integer from 1 to 65535")?;
    if web_port == 0 {
        return Err("LATITUDE_WEB_PORT must be an integer from 1 to 65535".into());
    }
    let public_web_origin = env::var("LATITUDE_WEB_ORIGIN")
        .ok()
        .map(|raw| parse_public_web_origin(&raw))
        .transpose()?;

    let (database, report) = Database::open(&db_path, &backup_dir).await?;
    tracing::info!(
        schema_version = %report.schema_version,
        backup = ?report.startup_backup,
        startup_backups_pruned = report.startup_backups_pruned.len(),
        "domain database ready"
    );
    let app = build_router_for_origins(AppState::new(database), web_port, public_web_origin);
    let listener = TcpListener::bind(address).await?;
    tracing::info!(%address, "Latitude domain service listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

fn parse_public_web_origin(raw: &str) -> Result<HeaderValue, Box<dyn std::error::Error>> {
    let value = raw.trim();
    let uri: Uri = value.parse()?;
    if uri.scheme_str() != Some("https")
        || uri.authority().is_none()
        || uri
            .authority()
            .is_some_and(|authority| authority.as_str().contains('@'))
        || (uri.path() != "/" && !uri.path().is_empty())
        || uri.query().is_some()
        || value.contains('#')
    {
        return Err("LATITUDE_WEB_ORIGIN must be an origin-only HTTPS URL".into());
    }
    Ok(HeaderValue::from_str(value.trim_end_matches('/'))?)
}
