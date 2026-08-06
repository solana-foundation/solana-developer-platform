import type { EarnStrategy } from "@sdp/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchEarnStrategies } from "./earn-program-data";

const TIMESTAMP = "2026-07-18T09:00:00.000Z";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function strategy(id: string): EarnStrategy {
  return {
    id,
    provider: "ground",
    providerReference: `${id}-ref`,
    name: id,
    sourceKind: "defi",
    depositMints: [USDC],
    apyType: "variable",
    currentApy: "0.05",
    liquidityTerm: "instant",
    status: "active",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

/** Stubs the BFF with a fixed catalogue, paging it the way the API would. */
function stubCatalogue(total: number, pageSize = 100) {
  const all = Array.from({ length: total }, (_, index) => strategy(`s${index}`));
  const calls: string[] = [];

  const fetchMock = vi.fn(async (input: string) => {
    calls.push(input);
    const page = Number(new URL(input, "https://sdp.test").searchParams.get("page") ?? "1");
    const slice = all.slice((page - 1) * pageSize, page * pageSize);
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { strategies: slice, total, page, pageSize } }),
    } as unknown as Response;
  });

  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchEarnStrategies", () => {
  it("returns a single short page without asking for a second", async () => {
    const { calls } = stubCatalogue(12);
    const strategies = await fetchEarnStrategies();
    expect(strategies).toHaveLength(12);
    expect(calls).toHaveLength(1);
  });

  it("pages past the API's 100-row cap instead of silently truncating", async () => {
    // The regression this guards: one unpaged request dropped every strategy
    // past the first 100, with no error anywhere.
    const { calls } = stubCatalogue(250);
    const strategies = await fetchEarnStrategies();
    expect(strategies).toHaveLength(250);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("page=1");
    expect(calls[2]).toContain("page=3");
    expect(new Set(strategies.map((entry) => entry.id)).size).toBe(250);
  });

  it("stops on an exactly-full final page rather than fetching an empty one", async () => {
    const { calls } = stubCatalogue(200);
    const strategies = await fetchEarnStrategies();
    expect(strategies).toHaveLength(200);
    expect(calls).toHaveLength(2);
  });

  it("stops on a short page even when the reported total is too high", async () => {
    // A wrong `total` must not spin the loop; the short page is authoritative.
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { strategies: [strategy("only")], total: 9_999, page: 1, pageSize: 100 },
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const strategies = await fetchEarnStrategies();
    expect(strategies).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caps the loop when every page stays full and the total never resolves", async () => {
    // Pathological provider/API response: full pages forever. The cap keeps the
    // dashboard from hanging on an unbounded fetch.
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            strategies: Array.from({ length: 100 }, (_, index) => strategy(`x${index}`)),
            total: Number.MAX_SAFE_INTEGER,
            page: 1,
            pageSize: 100,
          },
        }),
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchEarnStrategies();
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it("throws with the API's message when a page fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: { message: "Ground is not configured for sandbox mode." } }),
        } as unknown as Response;
      })
    );

    await expect(fetchEarnStrategies()).rejects.toThrow(
      "Ground is not configured for sandbox mode."
    );
  });
});
