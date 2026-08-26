import {
  type ConnectionProbeInput,
  type ConnectionProbeResult,
  type GatewayHealthResult,
  probeConnection,
  probeGatewayHealth,
} from "@sdp/private-channels";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { assertValidAddress } from "@sdp/solana/address";
import type {
  PrivateChannelHealth,
  PrivateChannelInstance,
  PrivateChannelInstanceOverview,
} from "@sdp/types";

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

/** Pre-connect gateway probe (candidate URL from the connect form) → wire DTO. */
export async function probeInstanceHealth(gatewayUrl: string): Promise<PrivateChannelHealth> {
  return toHealthDto(await probeGatewayHealth(gatewayUrl));
}

/**
 * Full connect-time verification: gateway (`/health` + `/ready`) AND chain RPC
 * (`getVersion`). Returned raw so the caller can attach both sub-results to a
 * 400 response for the client's status badges.
 */
export async function verifyInstanceConnection(
  input: ConnectionProbeInput
): Promise<ConnectionProbeResult> {
  return probeConnection(input);
}

interface JsonRpcResponse<T> {
  jsonrpc?: string;
  id?: number | string;
  result?: T;
  error?: { code?: number; message?: string };
}

// Minimal JSON-RPC POST to the gateway. Throws on network / non-2xx / error.
async function jsonRpc<T>(
  url: string,
  method: string,
  params: unknown[] = [],
  headers: Record<string, string> = {}
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "sdp-private-channels/0.1",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as JsonRpcResponse<T>;
  if (body.error) throw new Error(body.error.message || `JSON-RPC ${body.error.code ?? ""}`);
  if (body.result === undefined) throw new Error("JSON-RPC response missing result.");
  return body.result;
}

function toError(reason: unknown): string {
  if (reason instanceof Error) {
    if (reason.name === "TimeoutError" || reason.name === "AbortError") {
      return `Timed out after ${RPC_TIMEOUT_MS} ms.`;
    }
    return reason.message || "Request failed.";
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
  input: OverviewInput,
  projectRpc: SolanaRpc
): Promise<PrivateChannelInstanceOverview> {
  const authBase = input.authUrl;
  const escrowInstanceAddress = assertValidAddress(input.escrowInstanceAddr, "escrowInstanceAddr");
  const escrowProgramAddress = assertValidAddress(input.escrowProgramId, "escrowProgramId");

  const [
    gatewayHealth,
    channelSlot,
    latestBlockhash,
    chainRpc,
    escrowInstance,
    escrowProgram,
    auth,
  ] = await Promise.all([
    probeGatewayHealth(input.gatewayUrl),
    settledOrNull(jsonRpc<number>(input.gatewayUrl, "getSlot"), (v) => v),
    settledOrNull(
      jsonRpc<{ context: { slot: number }; value: { blockhash: string } }>(
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
      fetch(`${authBase.replace(/\/$/, "")}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
        headers: { Accept: "application/json" },
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
