//! Binary entrypoint for the Rings key authority.

use std::process::ExitCode;

use sdp_rings_key_auth::config::Config;
use sdp_rings_key_auth::routes;
use sdp_rings_key_auth::state::AppState;
use tokio::net::TcpListener;
use tokio::signal;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> ExitCode {
    if std::env::args().any(|argument| argument == "--health-check") {
        return health_check().await;
    }

    init_tracing();

    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            tracing::error!(%error, "configuration is invalid");
            return ExitCode::FAILURE;
        }
    };

    let port = config.port;
    let listener = match TcpListener::bind(("0.0.0.0", port)).await {
        Ok(listener) => listener,
        Err(error) => {
            tracing::error!(%error, port, "could not bind");
            return ExitCode::FAILURE;
        }
    };

    tracing::info!(port, "sdp-rings-key-auth listening");

    if let Err(error) = axum::serve(listener, routes::app(AppState::new(config)))
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        tracing::error!(%error, "server error");
        return ExitCode::FAILURE;
    }

    ExitCode::SUCCESS
}

async fn health_check() -> ExitCode {
    use tokio::io::AsyncWriteExt as _;

    let port = match Config::from_env() {
        Ok(config) => config.port,
        Err(error) => {
            eprintln!("health: invalid configuration: {error}");
            return ExitCode::FAILURE;
        }
    };

    let Ok(mut stream) = tokio::net::TcpStream::connect(("127.0.0.1", port)).await else {
        eprintln!("health: could not connect on port {port}");
        return ExitCode::FAILURE;
    };

    let request =
        format!("GET /health HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).await.is_err() {
        eprintln!("health: could not send request");
        return ExitCode::FAILURE;
    }

    let status_line = match tokio::time::timeout(PROBE_TIMEOUT, read_status_line(&mut stream)).await
    {
        Ok(Some(line)) => line,
        Ok(None) => {
            eprintln!("health: connection closed before a status line arrived");
            return ExitCode::FAILURE;
        }
        Err(_) => {
            eprintln!("health: probe timed out");
            return ExitCode::FAILURE;
        }
    };

    let alive = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .is_some_and(|code| code == 200);

    if alive {
        ExitCode::SUCCESS
    } else {
        eprintln!("health: unexpected response {status_line:?}");
        ExitCode::FAILURE
    }
}

const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

async fn read_status_line(stream: &mut tokio::net::TcpStream) -> Option<String> {
    use tokio::io::AsyncReadExt as _;

    const MAX_STATUS_LINE: usize = 8 * 1024;
    let mut buffer = Vec::with_capacity(64);
    let mut chunk = [0u8; 64];

    loop {
        if let Some(end) = buffer.windows(2).position(|pair| pair == b"\r\n") {
            return Some(String::from_utf8_lossy(&buffer[..end]).into_owned());
        }
        if buffer.len() >= MAX_STATUS_LINE {
            return None;
        }

        match stream.read(&mut chunk).await {
            Ok(0) => return None,
            Ok(read) => buffer.extend_from_slice(&chunk[..read]),
            Err(_) => return None,
        }
    }
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,tower_http=info"));

    tracing_subscriber::fmt()
        .json()
        .with_env_filter(filter)
        .with_current_span(false)
        .init();
}

async fn shutdown_signal() {
    let interrupt = async {
        let _ = signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match signal::unix::signal(signal::unix::SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(error) => tracing::error!(%error, "could not install SIGTERM handler"),
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = interrupt => tracing::info!("received interrupt; draining"),
        () = terminate => tracing::info!("received SIGTERM; draining"),
    }
}
