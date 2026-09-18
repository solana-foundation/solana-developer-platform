import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { BASE58_ADDRESS_PATTERN } from "@/app/dashboard/markets/base58-address";
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
 * The handler refuses a request naming any cluster other than mainnet-beta
 * outright — Kamino's allocations source is mainnet-only, and a devnet answer
 * does not exist to forward. A vault that is not even a public key is a client
 * bug rather than an upstream miss, so it answers 400 before anything
 * downstream runs. Everything else about the vault travels to the upstream
 * read exactly as the client sent it: the store is the server boundary that
 * polices it — refusing anything that is not a public key and anything the
 * SDP strategy catalogue does not front before it can reach the upstream URL,
 * so an unlisted address answers 502 like any other miss. The TTL cache, the
 * in-flight read dedup, and every other piece of module state live in the
 * store module, a private memoization of this public read rather than a
 * client-visible side effect.
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

  const cluster = new URL(request.url).searchParams.get("cluster") ?? "";
  if (cluster !== "mainnet-beta") {
    return jsonError(400, "Vault allocations are available for mainnet-beta vaults only");
  }
  const vault = new URL(request.url).searchParams.get("vault") ?? "";
  // Refused before anything downstream: the catalogue allowlist and Kamino
  // are never asked about a value that cannot name one vault. The store
  // re-checks this (it is the server boundary), but the caller deserves the
  // client-error status, not a 502 that reads like an outage.
  if (!BASE58_ADDRESS_PATTERN.test(vault)) {
    return jsonError(400, "vault must be a Solana public key");
  }

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
