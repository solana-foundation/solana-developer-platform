import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { readVaultAllocations } from "./kamino-allocations-store";

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
 * The handler is a pure passthrough and validates nothing: the vault travels
 * to the upstream read exactly as the client sent it, and the store refuses
 * anything that is not a public key when it builds the upstream URL, so a
 * malformed or unknown address answers 502 like any other miss. The TTL
 * cache, the in-flight read dedup, and every other piece of module state live
 * in the store module, a private memoization of this public read rather than
 * a client-visible side effect.
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

  const vault = new URL(request.url).searchParams.get("vault") ?? "";

  try {
    // The body IS the contract, with no envelope around it: `dashboardFetch`
    // hands the parsed JSON straight to the SWR hook, which re-parses it with
    // the same schema this route parsed upstream.
    const payload = await readVaultAllocations(vault);
    return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    // The reason (network, status, schema) is deliberately not surfaced: the
    // dashboard renders the same placeholder for every failure, and the raw
    // upstream text never belongs in a dashboard response.
    return jsonError(502, "Vault allocations could not be read");
  }
}
