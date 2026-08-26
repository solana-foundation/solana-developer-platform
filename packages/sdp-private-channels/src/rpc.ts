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
    return error.message || "RPC probe failed.";
  }
  return "RPC probe failed.";
}

/**
 * Probe a Solana JSON-RPC endpoint (mainnet, devnet, custom RPC provider) by
 * issuing `getVersion`. Success returns the reported `solana-core` version.
 * Non-JSON, non-2xx, JSON-RPC errors, and network timeouts all resolve as
 * `{ ok: false }`; never throws.
 */
export async function probeSolanaRpc(url: string): Promise<SolanaRpcProbeResult> {
  const startedAt = Date.now();
  const parsed = parseHttpUrl(url, "Chain RPC URL");
  if ("error" in parsed) {
    return { ok: false, latencyMs: 0, error: parsed.error };
  }
  const target = parsed.url.toString();

  try {
    const res = await fetch(target, {
      method: "POST",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
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
    });
    const latencyMs = Date.now() - startedAt;
    const text = await res.text();

    if (!res.ok) {
      return { ok: false, latencyMs, error: `HTTP ${res.status}` };
    }

    let body: SolanaRpcVersionResponse;
    try {
      body = JSON.parse(text) as SolanaRpcVersionResponse;
    } catch {
      return { ok: false, latencyMs, error: "Response was not valid JSON." };
    }

    if (body.error) {
      return {
        ok: false,
        latencyMs,
        error: body.error.message?.trim() || `JSON-RPC error ${body.error.code ?? ""}`.trim(),
      };
    }
    const version = body.result?.["solana-core"];
    if (typeof version !== "string" || !version) {
      return { ok: false, latencyMs, error: "Response missing solana-core version." };
    }
    return { ok: true, latencyMs, version };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: toErrorMessage(error) };
  }
}
