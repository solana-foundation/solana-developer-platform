import type { EgressReadiness } from "@sdp/types/health";
import { getLogger } from "@/runtime/logger";
import { waitForEgress } from "@/services/jobs/egress-warmup";

export interface EgressGate {
  /** Synchronous, so a startup probe with a 2 s timeout never waits on the network. */
  state(): EgressReadiness;
  /** Resolves once egress is proven or the deadline passes, even mid-probe. Never rejects. */
  settled: Promise<void>;
}

/**
 * A fresh Cloud Run instance spends its first ~30-40 s with no working external
 * egress while Cloud NAT programs ports for it, and every outbound call fails
 * until then. Probing until one call succeeds lets readiness and the first
 * scheduled work wait out that window instead of failing inside it. Past the
 * deadline the instance serves anyway: a dependency outage must not keep every
 * new instance out of rotation. A probe that succeeds later still reports `ok`.
 */
export function startEgressGate(params: {
  probe: () => Promise<void>;
  deadlineMs: number;
  intervalMs: number;
}): EgressGate {
  const startedAt = Date.now();
  let state: EgressReadiness = "pending";
  let attempts = 0;
  const fields = () => ({ elapsed_ms: Date.now() - startedAt, attempts });

  const proven = waitForEgress({
    ...params,
    probe: () => {
      attempts += 1;
      return params.probe();
    },
  }).then(({ ready }) => {
    if (!ready) {
      return;
    }
    state = "ok";
    getLogger().info({ event: "sdp_api_egress_ready", ...fields() }, "egress ready");
  });

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(resolve, params.deadlineMs);
  });

  const settled = Promise.race([proven, deadline]).then(() => {
    clearTimeout(deadlineTimer);
    if (state !== "pending") {
      return;
    }
    state = "unverified";
    getLogger().error(
      { event: "sdp_api_egress_unverified", ...fields() },
      "egress warmup deadline reached, serving anyway"
    );
  });
  return { state: () => state, settled };
}
