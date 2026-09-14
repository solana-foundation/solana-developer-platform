import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import {
  type KaminoVaultAllocations,
  kaminoVaultAllocationsSchema,
} from "@/app/dashboard/markets/treasury-solutions/kamino-allocations-schema";

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
 * Failures are honest and cached NEVER: an upstream outage, a non-2xx, or a
 * payload that does not parse answers 502, and the cell degrades to the same
 * placeholder a non-Kamino row shows. Nothing here logs request internals or
 * upstream payloads.
 */

const KAMINO_ALLOCATIONS_BASE = "https://api.kamino.finance/kvaults/vaults";
/** Kamino's own site re-reads allocations frequently; 45s keeps one upstream
 * read per vault across every dashboard tab without serving stale weights. */
const ALLOCATIONS_TTL_MS = 45_000;
const UPSTREAM_TIMEOUT_MS = 10_000;
const CACHE_MAX_ENTRIES = 128;
/** Base58 Solana public key, bounded to the 32-byte ed25519 range. */
const VAULT_PUBKEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface AllocationsCacheEntry {
  expiresAt: number;
  payload: KaminoVaultAllocations;
}

const allocationsCache = new Map<string, AllocationsCacheEntry>();

function jsonError(status: number, message: string): NextResponse {
  return NextResponse.json(
    { error: { message } },
    // Public market data, but per-request: freshness is the cache's job.
    { headers: { "Cache-Control": "private, no-store" }, status }
  );
}

function cacheAllocations(vault: string, payload: KaminoVaultAllocations): void {
  // The catalogue holds tens of vaults; the bound only exists so a pathological
  // caller cycling addresses cannot grow the map without end. Insertion order
  // makes the first key the oldest, expired or not.
  if (allocationsCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = allocationsCache.keys().next().value;
    if (oldest !== undefined) allocationsCache.delete(oldest);
  }
  allocationsCache.set(vault, { expiresAt: Date.now() + ALLOCATIONS_TTL_MS, payload });
}

async function readKaminoAllocations(vault: string): Promise<KaminoVaultAllocations> {
  const response = await fetch(`${KAMINO_ALLOCATIONS_BASE}/${vault}/allocations`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Kamino allocations request failed (${response.status})`);
  }
  return kaminoVaultAllocationsSchema.parse(await response.json());
}

export async function GET(request: Request) {
  const { userId } = await auth();
  if (!userId) {
    return jsonError(401, "Authentication required");
  }

  const vault = new URL(request.url).searchParams.get("vault") ?? "";
  if (!VAULT_PUBKEY_PATTERN.test(vault)) {
    return jsonError(400, "vault must be a Solana public key");
  }

  const cached = allocationsCache.get(vault);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(
      { data: cached.payload },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  }

  let payload: KaminoVaultAllocations;
  try {
    payload = await readKaminoAllocations(vault);
  } catch {
    // The reason (network, status, schema) is deliberately not surfaced: the
    // dashboard renders the same placeholder for every failure, and the raw
    // upstream text never belongs in a dashboard response.
    return jsonError(502, "Vault allocations could not be read");
  }

  cacheAllocations(vault, payload);
  return NextResponse.json(
    { data: payload },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
