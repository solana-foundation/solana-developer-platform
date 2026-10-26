import { AsyncLocalStorage } from "node:async_hooks";
import { GENESIS_HASH_BY_CLUSTER, type SolanaCluster } from "@sdp/types/well-known-tokens";
import {
  isJsonRpcPayload,
  isSolanaError,
  type RpcTransport,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from "@solana/kit";
import { z } from "zod";
import { MANAGED_RPC_ENV_KEYS } from "./managed-rpc-env-keys";

/** Provider attempts and pool decisions, without endpoint URLs or payloads. */
export interface RpcTelemetryEvent {
  event: "sdp_rpc_attempt" | "sdp_rpc_failover" | "sdp_rpc_cooldown";
  surface: "managed_pool" | "earn_pinned";
  provider: string;
  cluster: SolanaCluster;
  method: string;
  outcome?: "succeeded" | "failed" | "http_success_unverified";
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
      const key = `${event.surface}:${event.provider}:${event.cluster}:${event.method}`;
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

/** Record one Earn operation moving from its pinned endpoint to the next provider. */
export function emitPinnedRpcFailover(): void {
  const scope = pinnedRpcScopes.getStore();
  if (!scope?.provider || !scope.cluster) return;
  emitRpcTelemetry({
    event: "sdp_rpc_failover",
    surface: "earn_pinned",
    provider: scope.provider,
    cluster: scope.cluster,
    method: "provider_operation",
  });
}

function pinnedEndpoint(endpointUrl: string): { provider: string; cluster: SolanaCluster } | null {
  const scope = pinnedRpcScopes.getStore();
  if (!scope || scope.endpointUrl !== endpointUrl || !scope.provider || !scope.cluster) return null;
  return { provider: scope.provider, cluster: scope.cluster };
}

function rpcMethod(payload: unknown): string {
  return isJsonRpcPayload(payload) ? payload.method : "batch";
}

// Inspect only the envelope. RPC result payloads stay opaque to telemetry.
const rpcEnvelopeStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("error") }),
  z.object({ kind: z.literal("unverified") }),
  z.object({ kind: z.literal("result"), result: z.unknown() }),
]);
const rpcEnvelopeSchema = z
  .object({ result: z.unknown().optional(), error: z.unknown().optional() })
  .transform((response): z.input<typeof rpcEnvelopeStateSchema> => {
    if (response.error !== undefined) return { kind: "error" };
    return response.result === undefined
      ? { kind: "unverified" }
      : { kind: "result", result: response.result };
  })
  .pipe(rpcEnvelopeStateSchema)
  .catch({ kind: "unverified" });
const rpcResponsesSchema = z.preprocess(
  (value) => (Array.isArray(value) ? value : [value]),
  z.array(rpcEnvelopeSchema).nonempty()
);

function pinnedResponseOutcome(
  responses: z.infer<typeof rpcResponsesSchema> | null,
  method: string,
  cluster: SolanaCluster
): NonNullable<RpcTelemetryEvent["outcome"]> {
  if (responses === null) return "http_success_unverified";
  let outcome: NonNullable<RpcTelemetryEvent["outcome"]> = "succeeded";
  for (const response of responses) {
    switch (response.kind) {
      case "error":
        return "failed";
      case "unverified":
        outcome = "http_success_unverified";
        break;
      case "result":
        if (method === "getGenesisHash" && response.result !== GENESIS_HASH_BY_CLUSTER[cluster]) {
          return "failed";
        }
        break;
      default: {
        const unreachable: never = response;
        return unreachable;
      }
    }
  }
  return outcome;
}

function httpStatusOf(error: unknown): number | undefined {
  return isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)
    ? error.context.statusCode
    : undefined;
}

function emitPinnedAttempt(
  endpoint: { provider: string; cluster: SolanaCluster },
  method: string,
  outcome: NonNullable<RpcTelemetryEvent["outcome"]>,
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

const MAX_RPC_CLASSIFICATION_BYTES = 64 * 1024;
const RPC_CLASSIFICATION_TIMEOUT_MS = 1_000;

async function boundedRpcResponse(
  response: Response
): Promise<z.infer<typeof rpcResponsesSchema> | null> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_RPC_CLASSIFICATION_BYTES) {
    return null;
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.clone().body?.getReader();
  } catch {
    return null;
  }
  if (!reader) return null;

  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => undefined);
  }, RPC_CLASSIFICATION_TIMEOUT_MS);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || expired) break;
      size += value.byteLength;
      if (size > MAX_RPC_CLASSIFICATION_BYTES) return null;
      chunks.push(value);
    }
    if (expired) return null;
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed = rpcResponsesSchema.safeParse(JSON.parse(new TextDecoder().decode(body)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function reportPinnedFetchResponse(
  response: Response,
  endpoint: { provider: string; cluster: SolanaCluster },
  method: string,
  startedAt: number
): Promise<void> {
  const body = await boundedRpcResponse(response);
  const outcome = pinnedResponseOutcome(body, method, endpoint.cluster);
  emitPinnedAttempt(
    endpoint,
    method,
    outcome,
    startedAt,
    outcome === "succeeded" ? undefined : response.status
  );
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
      const parsed = rpcResponsesSchema.safeParse(response);
      emitPinnedAttempt(
        endpoint,
        method,
        pinnedResponseOutcome(parsed.success ? parsed.data : null, method, endpoint.cluster),
        startedAt
      );
      return response;
    } catch (error) {
      emitPinnedAttempt(endpoint, method, "failed", startedAt, httpStatusOf(error));
      throw error;
    }
  };
}

/** Count each physical web3.js or direct-fetch request; inspect only a bounded clone. */
export async function fetchWithPinnedRpcTelemetry(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit
): Promise<Response> {
  const endpointUrl = input instanceof Request ? input.url : input.toString();
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
    if (response.ok) {
      // Classify a bounded clone in the background. The SDK owns the original body.
      void reportPinnedFetchResponse(response, endpoint, method, startedAt).catch(() => {
        emitPinnedAttempt(endpoint, method, "http_success_unverified", startedAt, response.status);
      });
    } else {
      emitPinnedAttempt(endpoint, method, "failed", startedAt, response.status);
    }
    return response;
  } catch (error) {
    emitPinnedAttempt(endpoint, method, "failed", startedAt, httpStatusOf(error));
    throw error;
  }
}
