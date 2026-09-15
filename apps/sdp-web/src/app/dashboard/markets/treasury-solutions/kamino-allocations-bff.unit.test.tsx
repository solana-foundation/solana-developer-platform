// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/dashboard/markets/earn/kamino-allocations/route";
import { useKaminoVaultAllocations } from "./kamino-allocations";

/**
 * Seam test: the REAL BFF route, the REAL `dashboardFetch`, and the REAL SWR
 * hook, wired together the way the browser wires them. The route test and the
 * hook test each mock the other side, so only this file can catch the two
 * disagreeing about the response shape (an envelope around the payload once
 * failed every Information cell while both unit suites stayed green).
 */

// Own vault per test: the route's module-level TTL caches outlive a test.
// Hoisted because the SDP client mock below needs the same vaults.
const VAULTS = vi.hoisted(() => ({
  happy: "A2wsxhA7pF4B2UKVfXocb6TAAP9ipfPJam6oMKgDE5BK",
  upstreamDown: "BoZDRc1RDY9FzUZZ19WT4GbtTnnbXQ8AGSU5ByEw3ut5",
}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
}));

// The route resolves its vault allowlist from the strategy catalogue through
// the SDP API client; the seam stands in for that client with a catalogue
// that fronts this file's vaults. It never touches global fetch, so the
// `seenUrls` assertions below still see exactly the browser→BFF and BFF→
// Kamino hops.
vi.mock("@/lib/sdp-api", () => ({
  createSdpApiClient: async () => ({
    request: () => {
      throw new Error("Unexpected SDP API request");
    },
    fetch: async () => ({
      strategies: Object.values(VAULTS).map((providerReference) => ({
        provider: "kamino",
        providerReference,
        hostCluster: "mainnet-beta",
      })),
      total: Object.keys(VAULTS).length,
    }),
  }),
}));

const BFF_PATH = "/api/dashboard/markets/earn/kamino-allocations";
const UPSTREAM_BASE = "https://api.kamino.finance/kvaults/vaults";

function upstreamPayload() {
  return {
    asOf: "2026-09-14T22:12:44.868Z",
    capitalDeployedUsd: "136300828.17079320021",
    utilizationRatio: "0.84593671596597477748",
    allocations: [
      {
        reserve: "2gc9Dm1eB6UgVYFBUN9bWks6Kes9PbWSaPaa9DqyvEiN",
        market: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
        marketName: "SOL/BTC Market",
        tokenMint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
        symbol: "PYUSD",
        targetWeightPct: "28.052173043927304226",
        actualPct: "28.046545155761449111",
        suppliedTokenAmount: "38241645.052988995378",
        suppliedUsd: "38235337.476053955373",
        capTokenAmount: "18446744073709.551615",
        utilizationRatio: "0.8584926035957584",
        supplyApy: "0.02216865117343203",
        rewardsApy: "0",
        collateral: [{ mint: "So11111111111111111111111111111111111111112", symbol: "SOL" }],
      },
    ],
    unallocated: {
      tokenAmount: "21001.03",
      usd: "20997.56",
      pct: "0.0154",
    },
  };
}

const seenUrls: string[] = [];
let upstreamResponse: () => Response = () => Response.json(upstreamPayload());

/**
 * One global fetch stands in for both hops: the browser's relative call to the
 * BFF is answered by invoking the route handler in-process, and the route's
 * own call to Kamino is answered by the canned upstream payload.
 */
async function wiredFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  seenUrls.push(url);
  if (url.startsWith(BFF_PATH)) {
    return GET(new Request(`https://dashboard.example.test${url}`, init));
  }
  if (url.startsWith(UPSTREAM_BASE)) {
    return upstreamResponse();
  }
  throw new Error(`unexpected fetch: ${url}`);
}

function renderIsolatedHook(vault: string) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
  );
  return renderHook(() => useKaminoVaultAllocations(vault, "mainnet-beta"), { wrapper });
}

describe("Kamino allocations: route → dashboardFetch → hook", () => {
  beforeEach(() => {
    seenUrls.length = 0;
    upstreamResponse = () => Response.json(upstreamPayload());
    mocks.auth.mockResolvedValue({ userId: "user_1", orgId: "org_1" });
    vi.stubGlobal("fetch", vi.fn(wiredFetch));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("renders the route's body in the hook without any client-side reshaping", async () => {
    const { result } = renderIsolatedHook(VAULTS.happy);

    await waitFor(() => expect(result.current.allocations).toBeDefined());

    expect(result.current.error).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
    // Exactly the figures the cell renders, already stripped to the contract.
    expect(result.current.allocations).toEqual({
      asOf: "2026-09-14T22:12:44.868Z",
      allocations: [
        {
          reserve: "2gc9Dm1eB6UgVYFBUN9bWks6Kes9PbWSaPaa9DqyvEiN",
          marketName: "SOL/BTC Market",
          actualPct: "28.046545155761449111",
        },
      ],
      unallocated: { pct: "0.0154" },
    });
    // One browser→BFF hop and one BFF→Kamino hop, nothing else on the wire.
    // The hook states its cluster explicitly for the BFF's mainnet-only gate.
    expect(seenUrls).toEqual([
      `${BFF_PATH}?vault=${VAULTS.happy}&cluster=mainnet-beta`,
      `${UPSTREAM_BASE}/${VAULTS.happy}/allocations`,
    ]);
  });

  it("surfaces an upstream failure to the hook as an error with no data", async () => {
    upstreamResponse = () => new Response("rate limited", { status: 429 });

    const { result } = renderIsolatedHook(VAULTS.upstreamDown);

    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.allocations).toBeUndefined();
    expect(result.current.error?.message).toBe("Vault allocations could not be read");
  });
});
