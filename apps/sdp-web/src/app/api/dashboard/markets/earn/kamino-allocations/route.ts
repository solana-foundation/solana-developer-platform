import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { readVaultAllocations, VAULT_PUBKEY_PATTERN } from "./kamino-allocations-store";

/**
 * Treasury Solutions "Information" column data seam: per-vault allocations for
 * Kamino strategies, fetched server-side from Kamino's public REST API.
 *
 * This is the one route in the earn BFF tree that does NOT proxy sdp-api: the
 * upstream is unauthenticated public market data, and the browser must never
 * call api.kamino.finance directly (CORS, third-party exposure). The proxy
 * middleware (`src/proxy.ts`) already authenticates `/api/dashboard(.*)` and
 * refuses cross-site writes; the auth check below only turns an expired
 * session into a JSON 401 instead of an HTML redirect for fetch().
 *
 * The handler itself only validates and forwards: the TTL cache, the in-flight
 * read dedup, and every other piece of module state live in the store module,
 * a private memoization of this public read rather than a client-visible side
 * effect. Kamino's allocations source is mainnet-only, so a request naming any
 * other cluster is refused outright instead of being sent upstream and
 * answering 502 for vaults that could never resolve there.
 */

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json(
    { error: { message } },
    // Public market data, but per-request: freshness is the cache's job.
    { headers: { "Cache-Control": "private, no-store" }, status }
  );
}

export async function GET(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return jsonError(401, "Authentication required");
  }

  const params = new URL(request.url).searchParams;
  const vault = params.get("vault") ?? "";
  if (!VAULT_PUBKEY_PATTERN.test(vault)) {
    return jsonError(400, "vault must be a Solana public key");
  }
  const cluster = params.get("cluster") ?? "";
  if (cluster !== "mainnet-beta") {
    return jsonError(400, "Vault allocations are available for mainnet-beta vaults only");
  }

  try {
    const payload = await readVaultAllocations(vault);
    return NextResponse.json(
      { data: payload },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch {
    // The reason (network, status, schema) is deliberately not surfaced: the
    // dashboard renders the same placeholder for every failure, and the raw
    // upstream text never belongs in a dashboard response.
    return jsonError(502, "Vault allocations could not be read");
  }
}
