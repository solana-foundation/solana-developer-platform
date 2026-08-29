import { type GatewayHealthResult, probeGatewayHealth } from "./health";
import type { SolanaRpcProbeResult } from "./rpc";
import { type ProbeTransport, truncateProbeDetail } from "./transport";

/** Timeout for the auth `/health` probe. Matches the rest of the connect probes. */
const AUTH_PROBE_TIMEOUT_MS = 5000;

export interface ConnectionProbeInput {
  gatewayUrl: string;
  authUrl: string;
  /** Supplied by the API so project RPC traffic uses its guarded egress transport. */
  probeRpc: () => Promise<SolanaRpcProbeResult>;
}

export type AuthProbeResult =
  | { ok: true; latencyMs: number }
  | { ok: false; latencyMs: number; error: string };

export interface ConnectionProbeResult {
  gateway: GatewayHealthResult;
  rpc: SolanaRpcProbeResult;
  auth: AuthProbeResult;
  ok: boolean;
}

async function probeAuth(authUrl: string, transport: ProbeTransport): Promise<AuthProbeResult> {
  const started = Date.now();
  try {
    const res = await transport({
      url: `${authUrl.trim().replace(/\/$/, "")}/health`,
      method: "GET",
      headers: { Accept: "application/json" },
      timeoutMs: AUTH_PROBE_TIMEOUT_MS,
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return { ok: false, latencyMs, error: `HTTP ${res.status}` };
    }
    return { ok: true, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const message =
      error instanceof Error
        ? error.name === "TimeoutError" || error.name === "AbortError"
          ? `Timed out after ${AUTH_PROBE_TIMEOUT_MS} ms.`
          : truncateProbeDetail(error.message) || "Request failed."
        : "Request failed.";
    return { ok: false, latencyMs, error: message };
  }
}

/**
 * Probe every endpoint the connect form cares about, in parallel. `ok` is true
 * only when the gateway reports `ready`, the chain RPC responds to `getVersion`,
 * and the auth service's `/health` returns 2xx.
 *
 * `transport` covers the two SPC-owned URLs the project supplies; the chain RPC
 * arrives already bound to the project's own guarded transport as `probeRpc`.
 */
export async function probeConnection(
  input: ConnectionProbeInput,
  transport: ProbeTransport
): Promise<ConnectionProbeResult> {
  const [gateway, rpc, auth] = await Promise.all([
    probeGatewayHealth(input.gatewayUrl, transport),
    input.probeRpc(),
    probeAuth(input.authUrl, transport),
  ]);
  return { gateway, rpc, auth, ok: gateway.status === "ready" && rpc.ok && auth.ok };
}
