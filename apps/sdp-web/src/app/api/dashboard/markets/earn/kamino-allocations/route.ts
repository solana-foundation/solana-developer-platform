import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { createSdpApiClient } from "@/lib/sdp-api";
import {
  readVaultAllocations,
  resolveAllowedVaults,
  VAULT_PUBKEY_PATTERN,
} from "./kamino-allocations-store";

/**
 * Treasury Solutions "Information" column data seam: per-vault allocations for
 * Kamino strategies, fetched server-side from Kamino's public REST API.
 *
 * This is the one route in the earn BFF tree that does NOT proxy sdp-api for
 * its payload: the upstream is unauthenticated public market data, and the
 * browser must never call api.kamino.finance directly (CORS, third-party
 * exposure). The proxy middleware (`src/proxy.ts`) already authenticates
 * `/api/dashboard(.*)` and refuses cross-site writes; the auth check below
 * only turns an expired session into a JSON 401 instead of an HTML redirect
 * for fetch().
 *
 * Kamino's endpoint would answer any well-formed mainnet vault, so the
 * handler admits a vault only if the SDP strategy catalogue actually fronts
 * it: the allowlist is resolved from the same authenticated strategies read
 * every other earn BFF route proxies (`/v1/earn/strategies`, provider kamino,
 * mainnet-beta), through `createSdpApiClient`. A vault absent from the
 * catalogue wears the same generic 502 as every other failure — to the
 * browser a refused vault and an upstream outage are indistinguishable, and
 * neither may reflect request internals. A catalogue read that fails or is
 * unavailable also fails closed: the cell degrades to the placeholder it
 * already renders, rather than the allowlist opening up.
 *
 * Kamino's allocations source is mainnet-only, so a request naming any other
 * cluster is refused outright instead of being sent upstream and answering
 * 502 for vaults that could never resolve there.
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
    const apiClient = await createSdpApiClient();
    const allowed = await resolveAllowedVaults(apiClient.fetch);
    // Not listed ≠ a different error: the reason (absent from the catalogue,
    // upstream down, catalogue down) is deliberately not surfaced, because the
    // dashboard renders the same placeholder for every failure and the raw
    // upstream text never belongs in a dashboard response.
    if (!allowed.has(vault)) {
      return jsonError(502, "Vault allocations could not be read");
    }
    // The body IS the contract, with no envelope around it: `dashboardFetch`
    // hands the parsed JSON straight to the SWR hook, which re-parses it with
    // the same schema this route parsed upstream.
    const payload = await readVaultAllocations(vault);
    return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return jsonError(502, "Vault allocations could not be read");
  }
}
