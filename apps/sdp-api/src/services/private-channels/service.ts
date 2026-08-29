import {
  type ConnectionProbeInput,
  type ConnectionProbeResult,
  type GatewayHealthResult,
  probeConnection,
  probeGatewayHealth,
} from "@sdp/private-channels";
import { type ProbeTransport, truncateProbeDetail } from "@sdp/private-channels/transport";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import type {
  PrivateChannelHealth,
  PrivateChannelInstance,
  PrivateChannelInstanceOverview,
  PrivateChannelProbeResult,
} from "@sdp/types";
import type { Env } from "@/types/env";
import { createPrivateChannelProbeTransport } from "./egress";

const RPC_TIMEOUT_MS = 5000;

/** Map the engine probe result to the JSON-safe wire DTO (drops sub-responses). */
function toHealthDto(result: GatewayHealthResult): PrivateChannelHealth {
  if (result.status === "degraded") {
    return { status: "degraded", latencyMs: result.latencyMs, reason: result.reason };
  }
  if (result.status === "unreachable") {
    return { status: "unreachable", latencyMs: result.latencyMs, error: result.error };
  }
  return { status: "ready", latencyMs: result.latencyMs };
}

/**
 * The connect-time probe as it goes over the wire. The engine result carries
 * per-endpoint sub-results; this keeps the status, the latency and a truncated
 * reason, which is everything the connect form's badges render. Returning the
 * engine result directly would relay whatever the candidate gateway put in its
 * `/health` body back to the caller who chose that gateway.
 */
export function toProbeResultDto(result: ConnectionProbeResult): PrivateChannelProbeResult {
  return {
    ok: result.ok,
    gateway: toHealthDto(result.gateway),
    rpc: result.rpc.ok
      ? { ok: true, latencyMs: result.rpc.latencyMs, version: result.rpc.version }
      : { ok: false, latencyMs: result.rpc.latencyMs, error: result.rpc.error },
    auth: result.auth.ok
      ? { ok: true, latencyMs: result.auth.latencyMs }
      : { ok: false, latencyMs: result.auth.latencyMs, error: result.auth.error },
  };
}

/** Pre-connect gateway probe (candidate URL from the connect form) → wire DTO. */
export async function probeInstanceHealth(
  env: Env,
  gatewayUrl: string
): Promise<PrivateChannelHealth> {
  return toHealthDto(await probeGatewayHealth(gatewayUrl, createPrivateChannelProbeTransport(env)));
}

/**
 * Full connect-time verification: gateway (`/health` + `/ready`) AND chain RPC
 * (`getVersion`). Returned raw so the caller can attach both sub-results to a
 * 400 response for the client's status badges — pass it through
 * {@link toProbeResultDto} before it leaves the API.
 */
export async function verifyInstanceConnection(
  env: Env,
  input: ConnectionProbeInput
): Promise<ConnectionProbeResult> {
  return probeConnection(input, createPrivateChannelProbeTransport(env));
}

interface JsonRpcResponse<T> {
  jsonrpc?: string;
  id?: number | string;
  result?: T;
  error?: { code?: number; message?: string };
}

// Minimal JSON-RPC POST to the gateway. Throws on network / non-2xx / error.
// The gateway URL is the project's own input, so this goes through the guarded
// probe transport rather than `fetch` — see ./egress.
async function jsonRpc<T>(
  transport: ProbeTransport,
  url: string,
  method: string,
  params: unknown[] = [],
  headers: Record<string, string> = {}
): Promise<T> {
  const res = await transport({
    url,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "sdp-private-channels/0.1",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    timeoutMs: RPC_TIMEOUT_MS,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  let body: JsonRpcResponse<T>;
  try {
    body = JSON.parse(res.text) as JsonRpcResponse<T>;
  } catch {
    throw new Error("JSON-RPC response was not valid JSON.");
  }
  if (body.error) {
    throw new Error(
      truncateProbeDetail(body.error.message ?? "") || `JSON-RPC ${body.error.code ?? ""}`
    );
  }
  if (body.result === undefined) throw new Error("JSON-RPC response missing result.");
  return body.result;
}

function toError(reason: unknown): string {
  if (reason instanceof Error) {
    if (reason.name === "TimeoutError" || reason.name === "AbortError") {
      return `Timed out after ${RPC_TIMEOUT_MS} ms.`;
    }
    return truncateProbeDetail(reason.message) || "Request failed.";
  }
  return "Request failed.";
}

type OverviewInput = Pick<
  PrivateChannelInstance,
  "gatewayUrl" | "escrowProgramId" | "escrowInstanceAddr" | "authUrl"
>;

function settledOrNull<T, U>(p: Promise<T>, map: (v: T) => U): Promise<U | null> {
  return Promise.allSettled([p]).then(([r]) => (r.status === "fulfilled" ? map(r.value) : null));
}

// Post-connect overview. Gateway JSON-RPC = SPC channel chain; projectRpc =
// Solana L1 (where the escrow program + instance actually live).
export async function getInstanceOverview(
  env: Env,
  input: OverviewInput,
  projectRpc: SolanaRpc
): Promise<PrivateChannelInstanceOverview> {
  const authBase = input.authUrl;
  const escrowInstanceAddress = assertValidAddress(input.escrowInstanceAddr, "escrowInstanceAddr");
  const escrowProgramAddress = assertValidAddress(input.escrowProgramId, "escrowProgramId");
  // The stored gateway and auth URLs were allowlisted when the instance was
  // connected, but the allowlist is deployment config and can change: a row
  // written before an origin was removed must not keep its reach, so the
  // overview re-checks through the same transport rather than trusting the row.
  const transport = createPrivateChannelProbeTransport(env);

  const [
    gatewayHealth,
    channelSlot,
    latestBlockhash,
    chainRpc,
    escrowInstance,
    escrowProgram,
    auth,
  ] = await Promise.all([
    probeGatewayHealth(input.gatewayUrl, transport),
    settledOrNull(jsonRpc<number>(transport, input.gatewayUrl, "getSlot"), (v) => v),
    settledOrNull(
      jsonRpc<{ context: { slot: number }; value: { blockhash: string } }>(
        transport,
        input.gatewayUrl,
        "getLatestBlockhash"
      ),
      (v) => v.value.blockhash
    ),
    Promise.allSettled([projectRpc.getVersion().send()]).then(
      ([r]): PrivateChannelInstanceOverview["chainRpc"] =>
        r.status === "fulfilled"
          ? { ok: true, solanaVersion: r.value["solana-core"] ?? null }
          : { ok: false, error: toError(r.reason) }
    ),
    Promise.allSettled([
      projectRpc
        .getAccountInfo(escrowInstanceAddress, {
          encoding: "base64",
          dataSlice: { offset: 0, length: 0 },
        })
        .send(),
    ]).then(([r]): PrivateChannelInstanceOverview["escrowInstance"] => {
      if (r.status === "rejected") return { present: false, error: toError(r.reason) };
      if (r.value.value === null) return { present: false, error: "Account not found on-chain." };
      return {
        present: true,
        owner: r.value.value.owner,
        ownerMatchesProgram: r.value.value.owner === input.escrowProgramId,
        lamports: Number(r.value.value.lamports),
      };
    }),
    Promise.allSettled([
      projectRpc
        .getAccountInfo(escrowProgramAddress, {
          encoding: "base64",
          dataSlice: { offset: 0, length: 0 },
        })
        .send(),
    ]).then(([r]): PrivateChannelInstanceOverview["escrowProgram"] => {
      if (r.status === "rejected") return { present: false, error: toError(r.reason) };
      if (r.value.value === null)
        return { present: false, error: "Program not deployed on-chain." };
      return { present: true, executable: r.value.value.executable };
    }),
    Promise.allSettled([
      transport({
        url: `${authBase.trim().replace(/\/$/, "")}/health`,
        method: "GET",
        headers: { Accept: "application/json" },
        timeoutMs: RPC_TIMEOUT_MS,
      }),
    ]).then(([r]): PrivateChannelInstanceOverview["auth"] => {
      if (r.status === "rejected") {
        return { reachable: false, error: toError(r.reason) };
      }
      return r.value.ok
        ? { reachable: true, error: null }
        : { reachable: false, error: `HTTP ${r.value.status}` };
    }),
  ]);

  return {
    gateway: {
      health: toHealthDto(gatewayHealth),
      channelSlot,
      latestBlockhash,
    },
    chainRpc,
    escrowInstance,
    escrowProgram,
    auth,
  };
}
