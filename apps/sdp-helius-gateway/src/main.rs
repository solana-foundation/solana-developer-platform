//! Binary entrypoint. Everything substantive lives in the library so that
//! `tests/` can exercise the real router; see the crate docs in `lib.rs`.

use std::process::ExitCode;

use sdp_helius_gateway::config::Config;
use sdp_helius_gateway::state::AppState;
use sdp_helius_gateway::{routes, zolana};
use tokio::net::TcpListener;
use tokio::signal;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> ExitCode {
    // Container HEALTHCHECK path. Implemented in-process rather than by installing
    // curl into the runtime image: one fewer package to keep patched and to answer
    // for in the Trivy scan that gates every tagged release.
    if std::env::args().any(|arg| arg == "--health-check") {
        return health_check().await;
    }

    init_tracing();

    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            // Fail at boot rather than on the first real operation.
            tracing::error!(%error, "configuration is invalid");
            return ExitCode::FAILURE;
        }
    };

    let protocol_config = match zolana::preflight::run(&config).await {
        Ok(snapshot) => snapshot,
        Err(error) => {
            tracing::error!(%error, "preflight failed; refusing to serve");
            return ExitCode::FAILURE;
        }
    };

    let port = config.port;
    let state = AppState::new(config, protocol_config);

    let listener = match TcpListener::bind(("0.0.0.0", port)).await {
        Ok(listener) => listener,
        Err(error) => {
            tracing::error!(%error, port, "could not bind");
            return ExitCode::FAILURE;
        }
    };

    tracing::info!(port, "sdp-helius-gateway listening");

    if let Err(error) = axum::serve(listener, routes::app(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        tracing::error!(%error, "server error");
        return ExitCode::FAILURE;
    }

    ExitCode::SUCCESS
}

/// Probes our own `/health` over loopback and maps the status line to an exit code.
///
/// Liveness only, so any response below 500 counts as alive — matching the
/// convention in `apps/sdp-api/Dockerfile`. It reads the port from the same
/// variable the server binds, so the two cannot drift. Connect, write and read
/// share one wall-clock bound so a stalled accept queue cannot outrun Docker's
/// `HEALTHCHECK --timeout`.
async fn health_check() -> ExitCode {
    match tokio::time::timeout(PROBE_TIMEOUT, probe_health()).await {
        Ok(code) => code,
        Err(_) => {
            eprintln!("health: probe timed out after {PROBE_TIMEOUT:?}");
            ExitCode::FAILURE
        }
    }
}

async fn probe_health() -> ExitCode {
    use tokio::io::AsyncWriteExt as _;

    let port = std::env::var("HELIUS_GATEWAY_PORT")
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .unwrap_or(8788);

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

    // Read until the status line is complete rather than trusting one `read` to
    // deliver it. TCP is a stream: a short read is legal even on loopback, and
    // treating a fragmented response as a bad one would restart a healthy
    // container.
    let Some(status_line) = read_status_line(&mut stream).await else {
        eprintln!("health: connection closed before a status line arrived");
        return ExitCode::FAILURE;
    };

    let alive = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .is_some_and(|code| code < 500);

    if alive {
        ExitCode::SUCCESS
    } else {
        eprintln!("health: unexpected response {status_line:?}");
        ExitCode::FAILURE
    }
}

/// Wall-clock bound on the whole probe, comfortably inside the Dockerfile's
/// `HEALTHCHECK --timeout=3s` so that our own message is what gets logged rather
/// than the runtime's kill.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Accumulates bytes until the first CRLF and returns the status line.
///
/// `None` means the peer closed before sending one. The cap is what keeps a server
/// that streams headers forever from growing this buffer without bound; 8 KiB is far
/// more than the ~15 bytes a status line needs and matches the usual header-line
/// limit, so hitting it means the response is not HTTP.
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
            // Clean close. If a status line had arrived we would have returned above,
            // so anything buffered here is a partial line and not an answer.
            Ok(0) => return None,
            Ok(read) => buffer.extend_from_slice(&chunk[..read]),
            Err(_) => return None,
        }
    }
}

/// JSON to stdout, because Cloud Logging parses structured stdout into queryable
/// fields. Level comes from `RUST_LOG`, defaulting to `info`.
fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,tower_http=info"));

    tracing_subscriber::fmt()
        .json()
        .with_env_filter(filter)
        .with_current_span(false)
        .init();
}

/// Resolves on SIGTERM, which is how Cloud Run asks a revision to stop, or on
/// Ctrl-C for local runs.
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
