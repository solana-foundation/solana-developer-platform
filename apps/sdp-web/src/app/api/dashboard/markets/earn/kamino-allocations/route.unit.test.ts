import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
}));

import { kaminoVaultAllocationsSchema } from "@/app/dashboard/markets/treasury-solutions/kamino-allocations-schema";
import { GET } from "./route";

// The route keeps a module-level TTL cache, so every test that reaches the
// upstream read uses its OWN vault address and never collides with another
// test's cache entry.
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

describe("GET /api/dashboard/markets/earn/kamino-allocations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.auth.mockResolvedValue({ userId: "user_1", orgId: "org_1" });
    mocks.fetch.mockResolvedValue(Response.json(upstreamPayload()));
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

  it.each([
    "missing",
    "5YxwKgsvyTdT8q2CBgwA4L9BKbnKNrB66K9wUzij5wH!",
    "short",
    `${"a".repeat(70)}`,
  ])("rejects a malformed vault parameter", async (vault) => {
    const response = await GET(
      new Request(`https://dashboard.example.test/api/kamino?vault=${encodeURIComponent(vault)}`)
    );

    expect(response.status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(["missing", "devnet", "testnet", "mainnet", "sneaky-mainnet-beta"])(
    "refuses a %s cluster parameter: the allocations source is mainnet-only",
    async (cluster) => {
      const response = await GET(request(VAULTS.happy, cluster));

      expect(response.status).toBe(400);
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
});
