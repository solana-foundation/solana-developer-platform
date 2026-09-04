import type { ConnectionProbeResult } from "@sdp/private-channels";

type ConnectionProbeDetails = Omit<ConnectionProbeResult, "ok">;

export function isProjectRpcProbeFailure(probe: ConnectionProbeDetails): boolean {
  return probe.rpc.ok === false;
}

/** Concise server-action fallback for connect-time probe failures. */
export function summarizeProbeFailure(probe: ConnectionProbeDetails): string {
  if (probe.rpc.ok === false) {
    return `Project RPC check failed: ${probe.rpc.error} Fix the project's RPC integration or escrow deployment and try again.`;
  }
  if (probe.auth.ok === false) {
    return `Auth failed: ${probe.auth.error}`;
  }
  if (probe.gateway.status === "degraded") {
    return `Gateway degraded: ${probe.gateway.reason}`;
  }
  if (probe.gateway.status === "unreachable") {
    return `Gateway unreachable: ${probe.gateway.error}`;
  }
  return "Connection check failed.";
}
