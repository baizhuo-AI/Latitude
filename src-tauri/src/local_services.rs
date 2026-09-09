//! Installed Latitude owns its local Domain and Agent processes. Development
//! can keep using the existing services; a closed port starts the bundled host.
use std::{
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::Manager;
#[derive(Default)]
pub struct LocalServices {
    child: Mutex<Option<Child>>,
}
impl Drop for LocalServices {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}
pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(LocalServices::default());
    let state_root = app.path().app_data_dir()?;
    std::fs::create_dir_all(&state_root)?;
    let resources = app.path().resource_dir()?;
    let app = app.handle().clone();
    // Migration futures borrow SQLite statements. Keep their root future on
    // this service thread; axum connections can still use the runtime workers.
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Runtime::new().expect("local service runtime");
        runtime.block_on(async move {
            let domain_address = "127.0.0.1:43121";
            if tokio::net::TcpStream::connect(domain_address)
                .await
                .is_err()
            {
                let opened = latitude_domain_service::Database::open(
                    state_root.join("latitude-domain.db"),
                    state_root.join("backups"),
                )
                .await;
                match opened {
                    Ok((db, _)) => {
                        if let Ok(listener) = tokio::net::TcpListener::bind(domain_address).await {
                            let router = latitude_domain_service::build_router(
                                latitude_domain_service::AppState::new(db),
                            );
                            tauri::async_runtime::spawn(async move {
                                if let Err(error) = axum::serve(listener, router).await {
                                    eprintln!("[domain] local service stopped: {error}");
                                }
                            });
                        }
                    }
                    Err(error) => eprintln!("[domain] startup: {error}"),
                }
            }
            if tokio::net::TcpStream::connect("127.0.0.1:43120")
                .await
                .is_err()
            {
                let bundle = resources.join("agent");
                if bundle.join("node").is_file() && bundle.join("agent.mjs").is_file() {
                    let command = Command::new(bundle.join("node"))
                        .arg("--env-file-if-exists=.env.local")
                        .arg(bundle.join("agent.mjs"))
                        .current_dir(&state_root)
                        .env("LATITUDE_STATE_DIR", state_root.join("agent"))
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::inherit())
                        .spawn();
                    match command {
                        Ok(child) => {
                            if let Ok(mut state) = app.state::<LocalServices>().child.lock() {
                                *state = Some(child);
                            }
                        }
                        Err(error) => eprintln!("[agent] startup: {error}"),
                    }
                }
            }
            std::future::pending::<()>().await;
        });
    });
    Ok(())
}
pub fn stop(app: &tauri::AppHandle) {
    if let Ok(mut state) = app.state::<LocalServices>().child.lock() {
        if let Some(mut child) = state.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
