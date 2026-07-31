import { type GatewayHealthResult, probeGatewayHealth } from "./health";
import { probeSolanaRpc, type SolanaRpcProbeResult } from "./rpc";

/** Timeout for the auth `/health` probe. Matches the rest of the connect probes. */
const AUTH_PROBE_TIMEOUT_MS = 5000;

export interface ConnectionProbeInput {
  gatewayUrl: string;
  chainRpcUrl: string;
  authUrl: string;
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

async function probeAuth(authUrl: string): Promise<AuthProbeResult> {
  const started = Date.now();
  try {
    const res = await fetch(`${authUrl.replace(/\/$/, "")}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(AUTH_PROBE_TIMEOUT_MS),
      headers: { Accept: "application/json" },
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
          : error.message || "Request failed."
        : "Request failed.";
    return { ok: false, latencyMs, error: message };
  }
}

/**
 * Probe every endpoint the connect form cares about, in parallel. `ok` is true
 * only when the gateway reports `ready`, the chain RPC responds to `getVersion`,
 * and the auth service's `/health` returns 2xx.
 */
export async function probeConnection(input: ConnectionProbeInput): Promise<ConnectionProbeResult> {
  const [gateway, rpc, auth] = await Promise.all([
    probeGatewayHealth(input.gatewayUrl),
    probeSolanaRpc(input.chainRpcUrl),
    probeAuth(input.authUrl),
  ]);
  return { gateway, rpc, auth, ok: gateway.status === "ready" && rpc.ok && auth.ok };
}
