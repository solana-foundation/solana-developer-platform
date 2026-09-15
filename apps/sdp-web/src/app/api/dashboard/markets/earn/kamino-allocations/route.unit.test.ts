import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  fetch: vi.fn(),
  catalogue: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/sdp-api", () => ({
  createSdpApiClient: vi.fn(async () => ({
    request: vi.fn(),
    fetch: mocks.catalogue,
  })),
}));

import { kaminoVaultAllocationsSchema } from "@/app/dashboard/markets/treasury-solutions/kamino-allocations-schema";
import { resetAllowedVaultsForTests } from "./kamino-allocations-store";
import { GET } from "./route";

// The route keeps module-level TTL caches (allocations per vault, the vault
// allowlist for the whole catalogue), so every test that reaches the upstream
// read uses its OWN vault address and never collides with another test's
// cache entry; the allowlist itself is reset between tests below.
const VAULTS = {
  happy: "5YxwKgsvyTdT8q2CBgwA4L9BKbnKNrB66K9wUzij5wH",
  ttl: "3pzSpGttmKXtWVAQuksDCbMv5gWcAyLoixJRXCvbAZBc",
  expired: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
  independent1: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  independent2: "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q",
  concurrent: "Concurrent11111111111111111111111111111111",
  inflightFail: "RetryRead111111111111111111111111111111111",
  upstreamFail: "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
  malformed: `Kamino${"1".repeat(33)}`,
  badJson: "So11111111111111111111111111111111111111112",
  passthrough: "Passthrough11111111111111111111111111111111",
  unknown: "UpstreamMiss11111111111111111111111111111111",
  clusterMissing: `C1usterMissing${"1".repeat(23)}`,
  clusterDevnet: `C1usterDevnet${"1".repeat(21)}`,
  clusterTestnet: `C1usterTestnet${"1".repeat(20)}`,
  clusterMainnet: `C1usterMainnet${"1".repeat(20)}`,
  clusterSneaky: `C1usterSneakyMainnetBeta${"1".repeat(11)}`,
  absent: `Absent${"1".repeat(27)}`,
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

function request(vault: string, cluster = "mainnet-beta"): Request {
  const params = new URLSearchParams({ vault });
  if (cluster !== "missing") params.set("cluster", cluster);
  return new Request(`https://dashboard.example.test/api/kamino?${params.toString()}`);
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

  it("answers with the parsed allocations, unwrapped", async () => {
    const response = await GET(request(VAULTS.happy));

    expect(response.status).toBe(200);
    const body = await response.json();
    // The SWR hook re-parses the body it gets from dashboardFetch with this
    // same schema, so an envelope around the payload would fail every cell.
    expect(() => kaminoVaultAllocationsSchema.parse(body)).not.toThrow();
    expect(body.allocations).toHaveLength(1);
    // Nothing beyond the parsed contract leaks through, not even upstream
    // bookkeeping fields the dashboard does not render.
    expect(body.allocations[0]).toEqual({
      reserve: "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q",
      marketName: "SOL/BTC Market",
      actualPct: "23.942398955779318467",
    });
    expect(body.unallocated).toEqual({ pct: "0.061363718634853357161" });
    expect(mocks.fetch).toHaveBeenCalledWith(
      `https://api.kamino.finance/kvaults/vaults/${VAULTS.happy}/allocations`,
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("serves a second read inside the TTL from the in-memory cache", async () => {
    await GET(request(VAULTS.ttl));
    await GET(request(VAULTS.ttl));

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.catalogue).toHaveBeenCalledTimes(1);
  });

  it("re-reads a vault once its cache entry has expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    await GET(request(VAULTS.expired));
    vi.setSystemTime(45_001);
    await GET(request(VAULTS.expired));

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("caches vaults independently", async () => {
    await GET(request(VAULTS.independent1));
    await GET(request(VAULTS.independent2));

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects unauthenticated callers with a JSON 401", async () => {
    mocks.auth.mockResolvedValue({ userId: null, orgId: null });

    const response = await GET(request(VAULTS.happy));

    expect(response.status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("forwards a well-formed vault exactly as sent: the route validates nothing", async () => {
    const response = await GET(request(VAULTS.passthrough));

    expect(response.status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledWith(
      `https://api.kamino.finance/kvaults/vaults/${VAULTS.passthrough}/allocations`,
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it.each([
    "not-a-real-vault",
    "5YxwKgsvyTdT8q2CBgwA4L9BKbnKNrB66K9wUzij5wH!",
    `${"a".repeat(70)}`,
    "",
    "../7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF",
    "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF/allocations?vault=",
    "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF#",
  ])(
    "refuses a vault that is not a bare public key before it can alter the upstream URL",
    async (vault) => {
      const response = await GET(request(vault));

      expect(response.status).toBe(502);
      expect(mocks.fetch).not.toHaveBeenCalled();
    }
  );

  it("answers 502 when the upstream cannot resolve a well-formed vault it was handed", async () => {
    mocks.fetch.mockResolvedValue(new Response("not found", { status: 404 }));

    const response = await GET(request(VAULTS.unknown));

    expect(response.status).toBe(502);
    expect(mocks.fetch).toHaveBeenCalledWith(
      `https://api.kamino.finance/kvaults/vaults/${VAULTS.unknown}/allocations`,
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("answers 502 for a missing vault parameter without an upstream read", async () => {
    const response = await GET(new Request("https://dashboard.example.test/api/kamino"));

    expect(response.status).toBe(502);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", "clusterMissing"],
    ["devnet", "clusterDevnet"],
    ["testnet", "clusterTestnet"],
    ["mainnet", "clusterMainnet"],
    ["sneaky-mainnet-beta", "clusterSneaky"],
  ] as const)(
    "passes a %s cluster parameter through for a listed vault: the cluster is the caller's concern",
    async (cluster, vaultKey) => {
      const response = await GET(request(VAULTS[vaultKey], cluster));

      expect(response.status).toBe(200);
      expect(mocks.fetch).toHaveBeenCalledWith(
        `https://api.kamino.finance/kvaults/vaults/${VAULTS[vaultKey]}/allocations`,
        expect.objectContaining({ cache: "no-store" })
      );
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
    const first = GET(request(VAULTS.concurrent));
    const second = GET(request(VAULTS.concurrent));
    const third = GET(request(VAULTS.concurrent));
    // auth() defers every handler past its first await, so yield until the
    // shared upstream read has actually started before releasing it.
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    releaseUpstream(Response.json(upstreamPayload()));
    const [firstResponse, secondResponse, thirdResponse] = await Promise.all([
      first,
      second,
      third,
    ]);

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(thirdResponse.status).toBe(200);
    // The settled read is cached: the next caller after the burst is a hit.
    await GET(request(VAULTS.concurrent));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("releases a failed concurrent read so a later caller retries upstream", async () => {
    mocks.fetch.mockRejectedValue(new Error("upstream down"));
    const first = GET(request(VAULTS.inflightFail));
    const second = GET(request(VAULTS.inflightFail));
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    // One shared read, and both waiters wear its failure.
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(firstResponse.status).toBe(502);
    expect(secondResponse.status).toBe(502);

    // The failure was neither cached nor left in flight.
    const retry = await GET(request(VAULTS.inflightFail));
    expect(retry.status).toBe(502);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("answers 502 when the upstream read fails, caching nothing", async () => {
    mocks.fetch.mockResolvedValue(new Response("rate limited", { status: 429 }));

    const response = await GET(request(VAULTS.upstreamFail));
    expect(response.status).toBe(502);

    const retry = await GET(request(VAULTS.upstreamFail));
    expect(retry.status).toBe(502);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("answers 502 when the upstream payload does not match the contract", async () => {
    mocks.fetch.mockResolvedValue(
      Response.json({ asOf: "2026-09-14", allocations: [{ symbol: "SOL" }] })
    );

    const response = await GET(request(VAULTS.malformed));

    expect(response.status).toBe(502);
  });

  it("answers 502 when the upstream returns malformed JSON", async () => {
    mocks.fetch.mockResolvedValue(new Response("<html>oops</html>", { status: 200 }));

    const response = await GET(request(VAULTS.badJson));

    expect(response.status).toBe(502);
  });

  it("refuses a vault the catalogue does not list, indistinguishably from any other failure", async () => {
    // A genuine upstream failure, for the shape comparison below. The
    // catalogue is narrowed to only that vault, so `absent` is unlisted.
    mocks.catalogue.mockResolvedValue(cataloguePage([VAULTS.upstreamFail]));
    mocks.fetch.mockResolvedValue(new Response("rate limited", { status: 429 }));
    const upstreamFailure = await GET(request(VAULTS.upstreamFail));
    expect(upstreamFailure.status).toBe(502);

    const refused = await GET(request(VAULTS.absent));

    // A vault absent from the catalogue wears exactly what an upstream outage
    // wears — same status, same envelope, same cache headers — so the browser
    // cannot tell the two apart.
    expect(refused.status).toBe(upstreamFailure.status);
    expect(await refused.json()).toEqual(await upstreamFailure.json());
    expect(refused.headers.get("Cache-Control")).toBe(upstreamFailure.headers.get("Cache-Control"));
    // And it cost no upstream traffic: only the listed vault's read ran.
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the catalogue read fails, without caching the outage", async () => {
    mocks.catalogue.mockRejectedValue(new Error("sdp api unavailable"));

    const response = await GET(request(VAULTS.catalogueDown));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { message: "Vault allocations could not be read" },
    });
    // Fail closed: an unavailable catalogue means no Kamino traffic either.
    expect(mocks.fetch).not.toHaveBeenCalled();

    // The failure was not cached: a recovered catalogue serves the vault.
    mocks.catalogue.mockResolvedValue(cataloguePage([VAULTS.catalogueDown]));
    const retry = await GET(request(VAULTS.catalogueDown));
    expect(retry.status).toBe(200);
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
    const first = GET(request(VAULTS.coalesced));
    const second = GET(request(VAULTS.coalesced));
    await vi.waitFor(() => expect(mocks.catalogue).toHaveBeenCalledTimes(1));
    releaseCatalogue(cataloguePage([VAULTS.coalesced]));
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(mocks.catalogue).toHaveBeenCalledTimes(1);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    // The settled resolution is cached: the caller after the burst re-reads
    // neither the catalogue nor Kamino.
    await GET(request(VAULTS.coalesced));
    expect(mocks.catalogue).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("re-resolves the allowlist once its TTL has expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    await GET(request(VAULTS.allowlistTtl));
    vi.setSystemTime(45_001);
    await GET(request(VAULTS.allowlistTtl));

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

    expect((await GET(request(VAULTS.paged2))).status).toBe(200);
    expect(mocks.catalogue).toHaveBeenCalledTimes(2);
    // A page-one vault is allowlisted by the same resolution.
    expect((await GET(request(VAULTS.paged1))).status).toBe(200);
    expect(mocks.catalogue).toHaveBeenCalledTimes(2);
  });

  it("fails closed when catalogue pagination ends before the reported total", async () => {
    mocks.catalogue.mockResolvedValue(cataloguePage([VAULTS.shortPage], 3));

    const response = await GET(request(VAULTS.shortPage));

    expect(response.status).toBe(502);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
