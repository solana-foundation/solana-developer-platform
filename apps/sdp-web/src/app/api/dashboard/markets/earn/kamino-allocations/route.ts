import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { BASE58_ADDRESS_PATTERN } from "@/app/dashboard/[projectId]/markets/base58-address";
import { KAMINO_ALLOCATIONS_MAX_VAULTS } from "@/app/dashboard/[projectId]/markets/treasury-solutions/kamino-allocations-schema";
import { readVaultsAllocations } from "./kamino-allocations-store";

/**
 * Treasury Solutions "Information" column data seam: allocations for every
 * Kamino vault on the page in one read (`?vaults=a,b,c`), fetched server-side
 * from Kamino's public REST API, which only serves one vault per path.
 *
 * This is the one route in the earn BFF tree that does NOT proxy sdp-api: the
 * upstream is unauthenticated public market data, and the browser must never
 * call api.kamino.finance directly (CORS, third-party exposure). The proxy
 * middleware (`src/proxy.ts`) already authenticates `/api/dashboard(.*)` and
 * refuses cross-site writes; the auth check below only turns an expired
 * session into a JSON 401 instead of an HTML redirect for fetch().
 *
 * The handler refuses a request naming any cluster other than mainnet-beta
 * outright — Kamino's allocations source is mainnet-only, and a devnet answer
 * does not exist to forward. A vault list holding anything that is not a
 * public key, or more vaults than one page of the catalogue, is a client bug
 * rather than an upstream miss, so it answers 400 before anything downstream
 * runs. Everything else about the vaults travels to the store exactly as the
 * client sent them: the store is the server boundary that polices them —
 * refusing anything that is not a public key and anything the SDP strategy
 * catalogue does not front before it can reach the upstream URL. A refused or
 * failed vault is simply absent from the answer, so an unlisted address looks
 * like any other miss. The TTL cache, the in-flight read dedup, and every
 * other piece of module state live in the store module, a private memoization
 * of this public read rather than a client-visible side effect.
 */

/**
 * The query, parsed at the boundary: a mainnet-only cluster, and 1 to
 * `KAMINO_ALLOCATIONS_MAX_VAULTS` distinct public keys, comma-separated.
 */
const allocationsQuerySchema = z.object({
  cluster: z.literal("mainnet-beta"),
  vaults: z
    .string()
    .transform((value) => [...new Set(value.split(","))])
    .pipe(
      z.array(z.string().regex(BASE58_ADDRESS_PATTERN)).min(1).max(KAMINO_ALLOCATIONS_MAX_VAULTS)
    ),
});

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
  const query = allocationsQuerySchema.safeParse({
    cluster: params.get("cluster"),
    vaults: params.get("vaults"),
  });
  // Refused before anything downstream: the catalogue allowlist and Kamino
  // are never asked about another cluster or a value that cannot name one
  // vault. The store re-checks the keys (it is the server boundary), but the
  // caller deserves the client-error status, not an answer that reads like an
  // outage.
  if (!query.success) {
    return jsonError(
      400,
      query.error.issues.some((issue) => issue.path[0] === "cluster")
        ? "Vault allocations are available for mainnet-beta vaults only"
        : `vaults must list 1 to ${KAMINO_ALLOCATIONS_MAX_VAULTS} Solana public keys`
    );
  }

  try {
    // The body IS the contract, with no envelope around it: `dashboardFetch`
    // hands the parsed JSON straight to the SWR hook, which re-parses it with
    // the same schema module the store parsed upstream with. Upstream and
    // catalogue failures are already folded into the batch as absent vaults.
    const payload = await readVaultsAllocations(query.data.vaults);
    return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    // The reason is deliberately not surfaced: the dashboard renders the same
    // placeholder for every failure, and raw internals never belong in a
    // dashboard response.
    return jsonError(502, "Vault allocations could not be read");
  }
}
