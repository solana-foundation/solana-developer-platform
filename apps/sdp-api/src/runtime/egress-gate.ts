import { getLogger } from "@/runtime/logger";
import { waitForEgress } from "@/services/jobs/egress-warmup";

export type EgressReadiness = "pending" | "ok" | "unverified";

export interface EgressGate {
  /** Synchronous, so a startup probe with a 2 s timeout never waits on the network. */
  state(): EgressReadiness;
  /** Resolves once egress is proven or the deadline passes. Never rejects. */
  settled: Promise<void>;
}

/**
 * A fresh Cloud Run instance spends its first ~30-40 s with no working external
 * egress while Cloud NAT programs ports for it, and every outbound call fails
 * until then. Probing until one call succeeds lets readiness and the first
 * scheduled work wait out that window instead of failing inside it. Past the
 * deadline the instance serves anyway: a dependency outage must not keep every
 * new instance out of rotation.
 */
export function startEgressGate(params: {
  probe: () => Promise<unknown>;
  deadlineMs: number;
  intervalMs: number;
}): EgressGate {
  let state: EgressReadiness = "pending";
  const settled = waitForEgress(params).then((result) => {
    state = result.ready ? "ok" : "unverified";
    const fields = { elapsed_ms: result.elapsedMs, attempts: result.attempts };
    if (result.ready) {
      getLogger().info({ event: "sdp_api_egress_ready", ...fields }, "egress ready");
    } else {
      getLogger().error(
        { event: "sdp_api_egress_unverified", ...fields },
        "egress warmup deadline reached, serving anyway"
      );
    }
  });
  return { state: () => state, settled };
}
