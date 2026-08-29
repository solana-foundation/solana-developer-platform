import { type ProbeTransport, truncateProbeDetail } from "./transport";
import { parseHttpUrl } from "./url";

const PROBE_TIMEOUT_MS = 5000;

export type SolanaRpcProbeResult =
  | { ok: true; latencyMs: number; version: string }
  | { ok: false; latencyMs: number; error: string };

interface SolanaRpcVersionResponse {
  jsonrpc?: "2.0";
  id?: string | number;
  result?: { "solana-core"?: string; "feature-set"?: number };
  error?: { code?: number; message?: string };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // `AbortSignal.timeout` rejects with a `TimeoutError`; keep `AbortError` too.
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return `Timed out after ${PROBE_TIMEOUT_MS} ms.`;
    }
    return truncateProbeDetail(error.message) || "RPC probe failed.";
  }
  return "RPC probe failed.";
}

/**
 * Probe a Solana JSON-RPC endpoint (mainnet, devnet, custom RPC provider) by
 * issuing `getVersion`. Success returns the reported `solana-core` version.
 * Non-JSON, non-2xx, JSON-RPC errors, and network timeouts all resolve as
 * `{ ok: false }`; never throws.
 *
 * The endpoint is caller-supplied, so the request goes out through `transport`
 * — see `./transport`.
 */
export async function probeSolanaRpc(
  url: string,
  transport: ProbeTransport
): Promise<SolanaRpcProbeResult> {
  const startedAt = Date.now();
  const parsed = parseHttpUrl(url, "Chain RPC URL");
  if ("error" in parsed) {
    return { ok: false, latencyMs: 0, error: parsed.error };
  }
  const target = parsed.url.toString();

  try {
    const res = await transport({
      url: target,
      method: "POST",
      // Set an explicit User-Agent: some public RPC providers reject or
      // throttle requests without one.
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Cache-Control": "no-store",
        "User-Agent": "sdp-private-channels/0.1",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "sdp-private-channels-rpc-probe",
        method: "getVersion",
        params: [],
      }),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const latencyMs = Date.now() - startedAt;

    if (!res.ok) {
      return { ok: false, latencyMs, error: `HTTP ${res.status}` };
    }

    let body: SolanaRpcVersionResponse;
    try {
      body = JSON.parse(res.text) as SolanaRpcVersionResponse;
    } catch {
      return { ok: false, latencyMs, error: "Response was not valid JSON." };
    }

    if (body.error) {
      return {
        ok: false,
        latencyMs,
        error:
          truncateProbeDetail(body.error.message ?? "") ||
          `JSON-RPC error ${body.error.code ?? ""}`.trim(),
      };
    }
    const version = body.result?.["solana-core"];
    if (typeof version !== "string" || !version) {
      return { ok: false, latencyMs, error: "Response missing solana-core version." };
    }
    return { ok: true, latencyMs, version: truncateProbeDetail(version) };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: toErrorMessage(error) };
  }
}
