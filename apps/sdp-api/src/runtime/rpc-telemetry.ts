import { type RpcTelemetryEvent, setRpcTelemetrySink } from "@sdp/rpc/telemetry";
import { getLogContext, rootLogger } from "./logger";

const SUCCESS_WARMUP = 10;
const SUCCESS_SAMPLE_INTERVAL = 10;

/** Successful attempts seen per sampling key in this process. */
const successCounts = new Map<string, number>();

/**
 * The weight a line carries, or `null` to drop it. Successes are counted per caller (route or
 * cron), so summing `sample_weight` by caller stays a request count; everything else is exact.
 */
function sampleWeight(event: RpcTelemetryEvent): number | null {
  if (event.event !== "sdp_rpc_attempt" || event.outcome !== "succeeded") return 1;
  const { route, cron } = getLogContext();
  const key = `${event.surface}:${event.provider}:${event.cluster}:${event.method}:${route ?? cron}`;
  const count = (successCounts.get(key) ?? 0) + 1;
  successCounts.set(key, count);
  if (count <= SUCCESS_WARMUP) return 1;
  return (count - SUCCESS_WARMUP) % SUCCESS_SAMPLE_INTERVAL === 0 ? SUCCESS_SAMPLE_INTERVAL : null;
}

/** Route `@sdp/rpc` telemetry to the structured logger; `route` / `cron` arrive via the log context. */
export function installRpcTelemetrySink(): void {
  setRpcTelemetrySink((event) => {
    const weight = sampleWeight(event);
    if (weight === null) return;
    rootLogger.info({ ...event, sample_weight: weight });
  });
}
