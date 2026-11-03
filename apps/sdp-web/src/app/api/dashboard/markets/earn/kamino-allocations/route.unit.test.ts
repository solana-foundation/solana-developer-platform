import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  fetch: vi.fn(),
  catalogue: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
}));
vi.mock("next/headers", () => import("@/test/next-headers"));

import { kaminoVaultAllocationsBatchSchema } from "@/app/dashboard/[projectId]/markets/treasury-solutions/kamino-allocations-schema";
import * as sdpApi from "@/lib/sdp-api";
import { resetAllowedVaultsForTests } from "./kamino-allocations-store";
import { GET } from "./route";

// The route keeps module-level TTL caches (allocations per vault, the vault
// allowlist for the whole catalogue), so every test that reaches the upstream
// read uses its OWN vault addresses and never collides with another test's
// cache entry; the allowlist itself is reset between tests below.
const VAULTS = {
  happy: "5YxwKgsvyTdT8q2CBgwA4L9BKbnKNrB66K9wUzij5wH",
  ttl: "3pzSpGttmKXtWVAQuksDCbMv5gWcAyLoixJRXCvbAZBc",
  expired: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
  batch1: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  batch2: "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q",
  repeated: `Repeated${"1".repeat(26)}`,
  concurrent: "Concurrent11111111111111111111111111111111",
  inflightFail: "RetryRead111111111111111111111111111111111",
  upstreamFail: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
  malformed: `Kamino${"1".repeat(33)}`,
  badJson: "So11111111111111111111111111111111111111112",
  passthrough: "Passthrough11111111111111111111111111111111",
  unknown: "UpstreamMiss11111111111111111111111111111111",
  absent: `Absent${"1".repeat(27)}`,
  partner: `Partner${"1".repeat(26)}`,
  catalogueDown: `FrontDeskDown${"1".repeat(19)}`,
  coalesced: `Merged${"1".repeat(27)}`,
  allowlistTtl: `GateTimer${"1".repeat(24)}`,
  paged1: `FirstRow${"1".repeat(26)}`,
  paged2: `PagedTwo${"1".repeat(25)}`,
  shortPage: `ShortPage${"1".repeat(24)}`,
} as const;

function upstreamPayload() {
  return {
    asOf: "2026-09-14T17:53:52.895Z",
    capitalDeployedUsd: "569275.60242794083163",
    utilizationRatio: "0.9137506640412387656",
    allocations: [
      {
        reserve: "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q",
        market: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
        marketName: "SOL/BTC Market",
        tokenMint: "So11111111111111111111111111111111111111112",
        symbol: "SOL",
        targetWeightPct: "23.95715235153837132",
        actualPct: "23.942398955779318467",
        suppliedTokenAmount: "1324.0069549910007462",
        suppliedUsd: "136381.92491188545657",
        capTokenAmount: "1000000",
        utilizationRatio: "0.8941889760598444",
        supplyApy: "0.044979844106186606",
        rewardsApy: "0",
        collateral: [],
      },
    ],
    unallocated: {
      tokenAmount: "3.393393887",
      usd: "349.54317161908771822",
      pct: "0.061363718634853357161",
    },
  };
}

function request(vaults: string | readonly string[], cluster = "mainnet-beta"): Request {
  const params = new URLSearchParams();
  if (vaults !== "missing")
    params.set("vaults", typeof vaults === "string" ? vaults : vaults.join(","));
  if (cluster !== "missing") params.set("cluster", cluster);
  return new Request(`https://dashboard.example.test/api/kamino?${params.toString()}`);
}

async function readVaults(response: Response) {
  expect(response.status).toBe(200);
  return kaminoVaultAllocationsBatchSchema.parse(await response.json()).vaults;
}

function upstreamUrl(vault: string): string {
  return `https://api.kamino.finance/kvaults/vaults/${vault}/allocations`;
}

/**
 * The strategy-catalogue page the allowlist resolver reads through the SDP
 * API client: every named vault surfaced as a Kamino mainnet-beta strategy.
 * Deliberately minimal — the resolver parses this shape, not a full strategy.
 */
function cataloguePage(providerReferences: readonly string[], total = providerReferences.length) {
  return {
    strategies: providerReferences.map((providerReference) => ({
      provider: "kamino",
      providerReference,
      hostCluster: "mainnet-beta",
    })),
    total,
  };
}

describe("GET /api/dashboard/markets/earn/kamino-allocations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
    // The allowlist's catalogue read goes through the shared SDP API client.
    vi.spyOn(sdpApi, "createSdpApiClient").mockResolvedValue({
      request: vi.fn(),
      fetch: mocks.catalogue,
    });
    resetAllowedVaultsForTests();
    mocks.auth.mockResolvedValue({ userId: "user_1", orgId: "org_1" });
    // A fresh Response per upstream call: one Response body is consumable
    // exactly once, and several tests below read the same vault twice.
    mocks.fetch.mockImplementation(async () => Response.json(upstreamPayload()));
    // Default: the catalogue fronts every vault a test might reach for.
    mocks.catalogue.mockResolvedValue(cataloguePage(Object.values(VAULTS)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("answers with the parsed allocations keyed by vault, unwrapped", async () => {
    const response = await GET(request([VAULTS.happy]));

    const vaults = await readVaults(response);
    // The SWR hook re-parses the body it gets from dashboardFetch with this
    // same schema, so an envelope around the batch would fail every cell.
    // Nothing beyond the parsed contract leaks through, not even upstream
    // bookkeeping fields the dashboard does not render.
    expect(vaults[VAULTS.happy]?.allocations).toEqual([
      {
        reserve: "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q",
        marketName: "SOL/BTC Market",
        actualPct: "23.942398955779318467",
      },
    ]);
    expect(vaults[VAULTS.happy]?.unallocated).toEqual({ pct: "0.061363718634853357161" });
    expect(mocks.fetch).toHaveBeenCalledWith(
      upstreamUrl(VAULTS.happy),
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("reads a batch with one upstream read per vault and one catalogue read", async () => {
    const vaults = await readVaults(await GET(request([VAULTS.batch1, VAULTS.batch2])));

    expect(Object.keys(vaults).sort()).toEqual([VAULTS.batch1, VAULTS.batch2].sort());
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.catalogue).toHaveBeenCalledTimes(1);

    // Both now sit in the per-vault cache: the next batch costs Kamino nothing.
    await readVaults(await GET(request([VAULTS.batch2, VAULTS.batch1])));
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("reads a repeated vault once", async () => {
    const vaults = await readVaults(await GET(request([VAULTS.repeated, VAULTS.repeated])));

    expect(Object.keys(vaults)).toEqual([VAULTS.repeated]);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("serves a second read inside the TTL from the in-memory cache", async () => {
    await GET(request([VAULTS.ttl]));
    await GET(request([VAULTS.ttl]));

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.catalogue).toHaveBeenCalledTimes(1);
  });

  it("re-reads a vault once its cache entry has expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    await GET(request([VAULTS.expired]));
    vi.setSystemTime(45_001);
    await GET(request([VAULTS.expired]));

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects unauthenticated callers with a JSON 401", async () => {
    mocks.auth.mockResolvedValue({ userId: null, orgId: null });

    const response = await GET(request([VAULTS.happy]));

    expect(response.status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("forwards a well-formed vault exactly as sent: the route validates nothing else", async () => {
    const vaults = await readVaults(await GET(request([VAULTS.passthrough])));

    expect(vaults[VAULTS.passthrough]).toBeDefined();
    expect(mocks.fetch).toHaveBeenCalledWith(
      upstreamUrl(VAULTS.passthrough),
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it.each([
    "not-a-real-vault",
    "5YxwKgsvyTdT8q2CBgwA4L9BKbnKNrB66K9wUzij5wH!",
    `${"a".repeat(70)}`,
    "../7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
    "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF/allocations?vault=",
    "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF#",
  ])(
    "answers 400 for a batch holding a vault that is not a bare public key (%s)",
    async (vault) => {
      const response = await GET(request([VAULTS.happy, vault]));

      // A malformed vault is a client bug, not an upstream miss: 400, and
      // neither the catalogue allowlist nor Kamino is asked about any vault.
      expect(response.status).toBe(400);
      expect(mocks.catalogue).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    }
  );

  it.each(["missing", "", ","])("answers 400 for no vault at all (%j)", async (vaults) => {
    const response = await GET(request(vaults));

    expect(response.status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("answers 400 for more vaults than one catalogue page", async () => {
    // 101 distinct, well-formed keys: only the count can refuse them.
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const tooMany = Array.from(
      { length: 101 },
      (_, index) =>
        `Many${alphabet[index % 58]}${alphabet[Math.floor(index / 58)]}${"1".repeat(30)}`
    );

    const response = await GET(request(tooMany));

    expect(response.status).toBe(400);
    expect(mocks.catalogue).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("leaves a vault the upstream cannot resolve out of the answer", async () => {
    mocks.fetch.mockResolvedValue(new Response("not found", { status: 404 }));

    const vaults = await readVaults(await GET(request([VAULTS.unknown])));

    expect(vaults).toEqual({});
    expect(mocks.fetch).toHaveBeenCalledWith(
      upstreamUrl(VAULTS.unknown),
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it.each(["missing", "devnet", "testnet", "mainnet", "sneaky-mainnet-beta"])(
    "refuses a %s cluster parameter: the allocations source is mainnet-only",
    async (cluster) => {
      const response = await GET(request([VAULTS.happy], cluster));

      expect(response.status).toBe(400);
      // Refused before anything downstream: neither the catalogue allowlist
      // nor Kamino is asked about a vault on a cluster that cannot resolve.
      expect(mocks.catalogue).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    }
  );

  it("coalesces concurrent misses for one vault into a single upstream read", async () => {
    // Hold the first upstream response open so every caller piles onto the
    // same in-flight read instead of starting its own.
    let releaseUpstream: (payload: Response) => void = () => {};
    mocks.fetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releaseUpstream = resolve;
        })
    );
    const first = GET(request([VAULTS.concurrent]));
    const second = GET(request([VAULTS.concurrent]));
    const third = GET(request([VAULTS.concurrent]));
    // auth() defers every handler past its first await, so yield until the
    // shared upstream read has actually started before releasing it.
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    releaseUpstream(Response.json(upstreamPayload()));
    const responses = await Promise.all([first, second, third]);

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    for (const response of responses) {
      expect((await readVaults(response))[VAULTS.concurrent]).toBeDefined();
    }
    // The settled read is cached: the next caller after the burst is a hit.
    await GET(request([VAULTS.concurrent]));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("releases a failed concurrent read so a later caller retries upstream", async () => {
    mocks.fetch.mockRejectedValue(new Error("upstream down"));
    const first = GET(request([VAULTS.inflightFail]));
    const second = GET(request([VAULTS.inflightFail]));
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    // One shared read, and both waiters wear its failure as an absent vault.
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(await readVaults(firstResponse)).toEqual({});
    expect(await readVaults(secondResponse)).toEqual({});

    // The failure was neither cached nor left in flight.
    expect(await readVaults(await GET(request([VAULTS.inflightFail])))).toEqual({});
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("leaves an upstream failure out of the answer, caching nothing", async () => {
    mocks.fetch.mockResolvedValue(new Response("rate limited", { status: 429 }));

    expect(await readVaults(await GET(request([VAULTS.upstreamFail])))).toEqual({});
    expect(await readVaults(await GET(request([VAULTS.upstreamFail])))).toEqual({});
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("leaves a vault out when the upstream payload does not match the contract", async () => {
    mocks.fetch.mockResolvedValue(
      Response.json({ asOf: "2026-09-14", allocations: [{ symbol: "SOL" }] })
    );

    expect(await readVaults(await GET(request([VAULTS.malformed])))).toEqual({});
  });

  it("leaves a vault out when the upstream returns malformed JSON", async () => {
    mocks.fetch.mockResolvedValue(new Response("<html>oops</html>", { status: 200 }));

    expect(await readVaults(await GET(request([VAULTS.badJson])))).toEqual({});
  });

  it("leaves a vault the catalogue does not list out, indistinguishably from any other failure", async () => {
    // Only `partner` is listed; `absent` is not.
    mocks.catalogue.mockResolvedValue(cataloguePage([VAULTS.partner]));

    const vaults = await readVaults(await GET(request([VAULTS.partner, VAULTS.absent])));

    // An unlisted vault wears exactly what an upstream outage wears: it is
    // simply not in the answer, so the browser cannot tell the two apart.
    expect(Object.keys(vaults)).toEqual([VAULTS.partner]);
    // And it cost no upstream traffic: only the listed vault's read ran.
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledWith(upstreamUrl(VAULTS.partner), expect.anything());
  });

  it("fails closed when the catalogue read fails, without caching the outage", async () => {
    mocks.catalogue.mockRejectedValue(new Error("sdp api unavailable"));

    // Fail closed: an unavailable catalogue means no vault and no Kamino traffic.
    expect(await readVaults(await GET(request([VAULTS.catalogueDown])))).toEqual({});
    expect(mocks.fetch).not.toHaveBeenCalled();

    // The failure was not cached: a recovered catalogue serves the vault.
    mocks.catalogue.mockResolvedValue(cataloguePage([VAULTS.catalogueDown]));
    const vaults = await readVaults(await GET(request([VAULTS.catalogueDown])));
    expect(vaults[VAULTS.catalogueDown]).toBeDefined();
  });

  it("coalesces concurrent allowlist resolutions into one catalogue read", async () => {
    // Hold the catalogue answer open so every caller piles onto the same
    // in-flight resolution instead of starting its own.
    let releaseCatalogue: (page: unknown) => void = () => {};
    mocks.catalogue.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCatalogue = resolve;
        })
    );
    const first = GET(request([VAULTS.coalesced]));
    const second = GET(request([VAULTS.coalesced]));
    await vi.waitFor(() => expect(mocks.catalogue).toHaveBeenCalledTimes(1));
    releaseCatalogue(cataloguePage([VAULTS.coalesced]));
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(mocks.catalogue).toHaveBeenCalledTimes(1);
    expect((await readVaults(firstResponse))[VAULTS.coalesced]).toBeDefined();
    expect((await readVaults(secondResponse))[VAULTS.coalesced]).toBeDefined();
    // The settled resolution is cached: the caller after the burst re-reads
    // neither the catalogue nor Kamino.
    await GET(request([VAULTS.coalesced]));
    expect(mocks.catalogue).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("re-resolves the allowlist once its TTL has expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    await GET(request([VAULTS.allowlistTtl]));
    vi.setSystemTime(45_001);
    await GET(request([VAULTS.allowlistTtl]));

    expect(mocks.catalogue).toHaveBeenCalledTimes(2);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("allowlists vaults from every page of a multi-page catalogue", async () => {
    // Page one is exactly one full window; total pushes the resolver to page
    // two, where the vault under test actually lives. Filler entries never
    // reach a request, so only the vaults under test need real key shapes.
    const firstPage = cataloguePage(
      [...Array.from({ length: 99 }, (_, index) => `filler-${index}`), VAULTS.paged1],
      101
    );
    mocks.catalogue.mockImplementation(async (path: string) => {
      const page = Number(new URL(path, "https://sdp-api.test").searchParams.get("page"));
      return page === 1 ? firstPage : cataloguePage([VAULTS.paged2], 101);
    });

    expect((await readVaults(await GET(request([VAULTS.paged2]))))[VAULTS.paged2]).toBeDefined();
    expect(mocks.catalogue).toHaveBeenCalledTimes(2);
    // A page-one vault is allowlisted by the same resolution.
    expect((await readVaults(await GET(request([VAULTS.paged1]))))[VAULTS.paged1]).toBeDefined();
    expect(mocks.catalogue).toHaveBeenCalledTimes(2);
  });

  it("fails closed when catalogue pagination ends before the reported total", async () => {
    mocks.catalogue.mockResolvedValue(cataloguePage([VAULTS.shortPage], 3));

    expect(await readVaults(await GET(request([VAULTS.shortPage])))).toEqual({});
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
