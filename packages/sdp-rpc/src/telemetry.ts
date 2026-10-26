import { AsyncLocalStorage } from "node:async_hooks";
import { GENESIS_HASH_BY_CLUSTER, type SolanaCluster } from "@sdp/types/well-known-tokens";
import {
  isJsonRpcPayload,
  isSolanaError,
  type RpcTransport,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from "@solana/kit";
import { MANAGED_RPC_ENV_KEYS } from "./managed-rpc-env-keys";

/** Provider attempts and pool decisions, without endpoint URLs or payloads. */
export interface RpcTelemetryEvent {
  event: "sdp_rpc_attempt" | "sdp_rpc_failover" | "sdp_rpc_cooldown";
  surface: "managed_pool" | "earn_pinned";
  provider: string;
  cluster: SolanaCluster;
  method: string;
  outcome?: "succeeded" | "failed";
  status_code?: number;
  duration_ms?: number;
  sample_weight?: number;
  genesis_probe_required?: boolean;
}

let rpcTelemetrySink: ((event: RpcTelemetryEvent) => void) | null = null;
const successSequences = new Map<string, number>();

/** The API supplies its structured logger; telemetry must never change an RPC outcome. */
export function setRpcTelemetrySink(sink: ((event: RpcTelemetryEvent) => void) | null): void {
  rpcTelemetrySink = sink;
  if (sink === null) successSequences.clear();
}

/** Emit every failure and pool decision; retain ten warmup successes per provider. */
export function emitRpcTelemetry(event: RpcTelemetryEvent): void {
  const sink = rpcTelemetrySink;
  if (!sink) return;
  if (event.event === "sdp_rpc_attempt") {
    let weight = 1;
    if (event.outcome === "succeeded") {
      const key = `${event.surface}:${event.provider}:${event.cluster}`;
      const sequence = successSequences.get(key) ?? 0;
      successSequences.set(key, sequence < 19 ? sequence + 1 : 10);
      if (sequence >= 10) {
        if (sequence !== 19) return;
        weight = 10;
      }
    }
    event = { ...event, sample_weight: weight };
  }
  try {
    sink(event);
  } catch {
    // A broken monitoring sink cannot change an RPC or money-movement outcome.
  }
}

/** The managed endpoint's configured provider name, never its secret-bearing URL. */
export function rpcProviderForEndpoint(cluster: SolanaCluster, endpointUrl: string): string {
  return (
    Object.entries(MANAGED_RPC_ENV_KEYS[cluster]).find(
      ([, key]) => process.env[key] === endpointUrl
    )?.[0] ?? "unknown"
  );
}

interface PinnedRpcScope {
  endpointUrl: string | null;
  provider: string | null;
  cluster: SolanaCluster | null;
}

const pinnedRpcScopes = new AsyncLocalStorage<PinnedRpcScope>();

/** Keep one Earn operation's pinned endpoint separate from concurrent operations. */
export function runWithPinnedRpcTelemetry<T>(work: () => T): T {
  return pinnedRpcScopes.run({ endpointUrl: null, provider: null, cluster: null }, work);
}

/** Name the configured endpoint before proof so failed proof attempts are visible. */
export function pinRpcTelemetryEndpoint(cluster: SolanaCluster, endpointUrl: string): void {
  const scope = pinnedRpcScopes.getStore();
  if (!scope) return;
  scope.endpointUrl = endpointUrl;
  scope.provider = rpcProviderForEndpoint(cluster, endpointUrl);
  scope.cluster = cluster;
}

function pinnedEndpoint(endpointUrl: string): { provider: string; cluster: SolanaCluster } | null {
  const scope = pinnedRpcScopes.getStore();
  if (!scope || scope.endpointUrl !== endpointUrl || !scope.provider || !scope.cluster) return null;
  return { provider: scope.provider, cluster: scope.cluster };
}

function rpcMethod(payload: unknown): string {
  return isJsonRpcPayload(payload) ? payload.method : "batch";
}

function hasJsonRpcError(response: unknown): boolean {
  if (Array.isArray(response)) return response.some(hasJsonRpcError);
  return typeof response === "object" && response !== null && "error" in response;
}

function isSuccessfulPinnedResponse(
  response: unknown,
  method: string,
  cluster: SolanaCluster
): boolean {
  if (hasJsonRpcError(response)) return false;
  if (method !== "getGenesisHash") return true;
  return (
    typeof response === "object" &&
    response !== null &&
    "result" in response &&
    response.result === GENESIS_HASH_BY_CLUSTER[cluster]
  );
}

function httpStatusOf(error: unknown): number | undefined {
  return isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)
    ? error.context.statusCode
    : undefined;
}

function emitPinnedAttempt(
  endpoint: { provider: string; cluster: SolanaCluster },
  method: string,
  outcome: "succeeded" | "failed",
  startedAt: number,
  statusCode?: number
): void {
  emitRpcTelemetry({
    event: "sdp_rpc_attempt",
    surface: "earn_pinned",
    ...endpoint,
    method,
    outcome,
    status_code: statusCode,
    duration_ms: performance.now() - startedAt,
  });
}

/** Count each physical Kit request, including genesis proof and socket retries. */
export function withPinnedRpcTelemetry(transport: RpcTransport, endpointUrl: string): RpcTransport {
  return async <TResponse>(request: Parameters<RpcTransport>[0]) => {
    const endpoint = pinnedEndpoint(endpointUrl);
    if (!endpoint) return transport<TResponse>(request);
    const method = rpcMethod(request.payload);
    const startedAt = performance.now();
    try {
      const response = await transport<TResponse>(request);
      emitPinnedAttempt(
        endpoint,
        method,
        isSuccessfulPinnedResponse(response, method, endpoint.cluster) ? "succeeded" : "failed",
        startedAt
      );
      return response;
    } catch (error) {
      emitPinnedAttempt(endpoint, method, "failed", startedAt, httpStatusOf(error));
      throw error;
    }
  };
}

/** Count each physical web3.js or direct-fetch request without reading its body. */
export async function fetchWithPinnedRpcTelemetry(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit
): Promise<Response> {
  const endpointUrl =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const endpoint = pinnedEndpoint(endpointUrl);
  if (!endpoint) return fetch(input, init);
  let payload: unknown;
  if (typeof init?.body === "string") {
    try {
      payload = JSON.parse(init.body);
    } catch {
      payload = null;
    }
  }
  const method = rpcMethod(payload);
  const startedAt = performance.now();
  try {
    const response = await fetch(input, init);
    emitPinnedAttempt(
      endpoint,
      method,
      response.ok ? "succeeded" : "failed",
      startedAt,
      response.ok ? undefined : response.status
    );
    return response;
  } catch (error) {
    emitPinnedAttempt(endpoint, method, "failed", startedAt, httpStatusOf(error));
    throw error;
  }
}
