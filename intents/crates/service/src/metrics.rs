//! Request and RPC counters in the Prometheus text format, at `GET /metrics`.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use sdp_intents_chain::RpcCalls;

#[derive(Default)]
pub struct Metrics {
    routes: Mutex<BTreeMap<RouteOutcome, RouteTotals>>,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct RouteOutcome {
    route: &'static str,
    outcome: &'static str,
}

#[derive(Clone, Copy, Default)]
struct RouteTotals {
    requests: u64,
    microseconds: u64,
}

impl Metrics {
    /// `outcome` is `ok`, or the error code.
    pub fn observe(&self, route: &'static str, outcome: &'static str, elapsed: Duration) {
        let mut routes = self.routes.lock().unwrap_or_else(PoisonError::into_inner);
        let totals = routes.entry(RouteOutcome { route, outcome }).or_default();
        let microseconds = u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX);

        totals.requests = totals.requests.saturating_add(1);
        totals.microseconds = totals.microseconds.saturating_add(microseconds);
    }

    pub fn render(&self, calls: RpcCalls) -> String {
        let routes = self.routes.lock().unwrap_or_else(PoisonError::into_inner).clone();
        let mut text = String::from("# TYPE sdp_intents_requests_total counter\n");

        for (key, totals) in &routes {
            let labels = format!("route=\"{}\",outcome=\"{}\"", key.route, key.outcome);
            let _ = writeln!(text, "sdp_intents_requests_total{{{labels}}} {}", totals.requests);
            let _ = writeln!(text, "sdp_intents_request_microseconds_total{{{labels}}} {}", totals.microseconds);
        }

        let rpc = [
            ("getMultipleAccounts", calls.get_multiple_accounts),
            ("simulateTransaction", calls.simulate_transaction),
            ("getLatestBlockhash", calls.get_latest_blockhash),
            ("getProgramAccounts", calls.get_program_accounts),
            ("sendTransaction", calls.send_transaction),
            ("getBlockHeight", calls.get_block_height),
            ("getSignatureStatuses", calls.get_signature_statuses),
        ];
        text.push_str("# TYPE sdp_intents_rpc_calls_total counter\n");
        rpc.iter().for_each(|(method, count)| {
            let _ = writeln!(text, "sdp_intents_rpc_calls_total{{method=\"{method}\"}} {count}");
        });

        let _ = writeln!(text, "sdp_intents_cache_reads_total{{result=\"hit\"}} {}", calls.cache_hits);
        let _ = writeln!(text, "sdp_intents_cache_reads_total{{result=\"miss\"}} {}", calls.cache_misses);
        let _ = writeln!(text, "sdp_intents_subscription_restarts_total {}", calls.subscription_restarts);

        text
    }
}
