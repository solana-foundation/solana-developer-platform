//! `sdp-intents-service --rpc <url>`: serves the API on `--listen`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use clap::Parser;

use sdp_intents_chain::CachedRpc;
use sdp_intents_service::{router, Metrics, Service, Wallets};

#[derive(Parser)]
#[command(name = "sdp-intents-service", about = "The SDP intents planner behind an HTTP API")]
struct Args {
    #[arg(long, default_value = "http://127.0.0.1:8899")]
    rpc: String,

    /// The websocket of the RPC. The default is the RPC's host at the next port, as a validator
    /// serves it.
    #[arg(long)]
    ws: Option<String>,

    #[arg(long, default_value = "127.0.0.1:8787")]
    listen: SocketAddr,

    /// A folder of keypair files that `POST /v1/send` signs with. Only for a local surfnet.
    #[arg(long)]
    wallets: Option<PathBuf>,

    /// How long the cache serves an account that no subscription covers.
    #[arg(long, default_value_t = 400)]
    max_age_ms: u64,
}

#[tokio::main]
async fn main() -> ExitCode {
    match run(Args::parse()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run(args: Args) -> Result<(), String> {
    let ws = args.ws.clone().map_or_else(|| websocket_url(&args.rpc), Ok)?;
    let wallets = args.wallets.as_deref().map(Wallets::load).transpose()?.unwrap_or_default();
    let service = Service {
        chain: CachedRpc::new(&args.rpc, &ws, Duration::from_millis(args.max_age_ms)),
        wallets,
        metrics: Metrics::default(),
    };

    let listener = tokio::net::TcpListener::bind(args.listen)
        .await
        .map_err(|error| format!("cannot listen on {}: {error}", args.listen))?;
    eprintln!("sdp-intents-service on http://{} over {} and {ws}", args.listen, args.rpc);

    axum::serve(listener, router(Arc::new(service)))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|error| error.to_string())
}

/// `http://host:8899` becomes `ws://host:8900`, and `https` becomes `wss`.
fn websocket_url(rpc: &str) -> Result<String, String> {
    let (scheme, rest) = rpc.split_once("://").ok_or_else(|| format!("`{rpc}` is not a URL"))?;
    let scheme = if scheme == "https" { "wss" } else { "ws" };
    let (host, path) = rest.split_once('/').map_or((rest, ""), |(host, path)| (host, path));

    let host = match host.rsplit_once(':') {
        Some((name, port)) => {
            let port: u16 = port.parse().map_err(|_| format!("`{rpc}` has no valid port"))?;
            format!("{name}:{}", port.checked_add(1).ok_or_else(|| format!("`{rpc}` has the last port"))?)
        }
        None => host.to_owned(),
    };

    Ok(format!("{scheme}://{host}/{path}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_websocket_is_at_the_next_port() {
        assert_eq!(websocket_url("http://127.0.0.1:8899").unwrap(), "ws://127.0.0.1:8900/");
        assert_eq!(websocket_url("https://rpc.example.com/key").unwrap(), "wss://rpc.example.com/key");
    }
}
