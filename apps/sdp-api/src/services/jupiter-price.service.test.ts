import { runInClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENVIRONMENT_CLUSTER_CASES } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import { required } from "@/test/helpers/required";
import type { Env } from "@/types/env";
import { clearJupiterPriceCacheForTests, fetchJupiterUsdPrices } from "./jupiter-price.service";

type JupiterPriceBody = Readonly<
  Record<string, { readonly usdPrice: number | string; readonly decimals?: number } | null>
>;

function fetchPricesIn(
  environment: SdpEnvironment,
  priceEnv: Env,
  mints: string[]
): Promise<Map<string, number>> {
  return runInClusterScope({ projectId: null, environment }, () =>
    fetchJupiterUsdPrices(priceEnv, mints)
  );
}

function priceResponse(body: JupiterPriceBody, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestedMints(input: Parameters<typeof fetch>[0]): string[] {
  const requestUrl = input instanceof Request ? input.url : input;
  return required(new URL(requestUrl).searchParams.get("ids")).split(",");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearJupiterPriceCacheForTests();
});

describe("fetchJupiterUsdPrices", () => {
  it("reads usdPrice per mint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      priceResponse(
        {
          MintA: { usdPrice: 1.0001, decimals: 6 },
          MintB: { usdPrice: 74.19, decimals: 9 },
        },
        200
      )
    );

    const prices = await fetchPricesIn("sandbox", env, ["MintA", "MintB"]);

    expect(prices.get("MintA")).toBeCloseTo(1.0001);
    expect(prices.get("MintB")).toBeCloseTo(74.19);
  });

  it("omits a mint Jupiter could not price rather than pricing it at zero", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(priceResponse({ MintA: { usdPrice: 2 } }, 200));

    const prices = await fetchPricesIn("sandbox", env, ["MintA", "MintUnknown"]);

    expect(prices.get("MintA")).toBe(2);
    expect(prices.has("MintUnknown")).toBe(false);
  });

  it("returns an empty map instead of throwing when the request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    await expect(fetchPricesIn("sandbox", env, ["MintA"])).resolves.toEqual(new Map());
  });

  it("returns an empty map on a non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(priceResponse({}, 429));

    await expect(fetchPricesIn("sandbox", env, ["MintA"])).resolves.toEqual(new Map());
  });

  it("ignores non-numeric and negative prices", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      priceResponse(
        {
          MintA: { usdPrice: "1.5" },
          MintB: { usdPrice: -3 },
          MintC: { usdPrice: Number.NaN },
          MintD: null,
        },
        200
      )
    );

    await expect(
      fetchPricesIn("sandbox", env, ["MintA", "MintB", "MintC", "MintD"])
    ).resolves.toEqual(new Map());
  });

  it("chunks large mint lists and merges the results", async () => {
    const mints = Array.from({ length: 120 }, (_, index) => `Mint${index}`);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      return priceResponse(
        Object.fromEntries(requestedMints(input).map((id) => [id, { usdPrice: 1 }])),
        200
      );
    });

    const prices = await fetchPricesIn("sandbox", env, mints);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(prices.size).toBe(120);
  });

  it("keeps prices from the batches that succeeded when one batch fails", async () => {
    const mints = Array.from({ length: 60 }, (_, index) => `Mint${index}`);
    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      call += 1;
      if (call === 1) {
        throw new Error("first batch failed");
      }
      return priceResponse(
        Object.fromEntries(requestedMints(input).map((id) => [id, { usdPrice: 5 }])),
        200
      );
    });

    const prices = await fetchPricesIn("sandbox", env, mints);

    expect(prices.size).toBe(10);
  });

  it("sends the api key only when one is configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(priceResponse({}, 200));

    await fetchPricesIn("sandbox", env, ["MintA"]);
    expect(required(required(fetchSpy.mock.calls[0])[1]).headers).toBeUndefined();

    await fetchPricesIn(
      "sandbox",
      { ...env, JUPITER_PRICE_API_URL: "https://api.jup.ag/price/v3", JUPITER_PRICE_API_KEY: "k" },
      ["MintA"]
    );
    const [url, init] = required(fetchSpy.mock.calls[1]);
    expect(String(url)).toContain("https://api.jup.ag/price/v3");
    expect(required(init).headers).toEqual({ "x-api-key": "k" });
  });

  it("makes no request when there is nothing to price", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(fetchPricesIn("sandbox", env, ["", "   "])).resolves.toEqual(new Map());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reuses a price for 30 seconds, then asks again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => priceResponse({ MintA: { usdPrice: 2 } }, 200));

    await fetchPricesIn("sandbox", env, ["MintA"]);
    vi.advanceTimersByTime(29_000);
    await expect(fetchPricesIn("sandbox", env, ["MintA"])).resolves.toEqual(
      new Map([["MintA", 2]])
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    await fetchPricesIn("sandbox", env, ["MintA"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("asks again after a failed request instead of remembering no price", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("network down"))
      .mockImplementation(async () => priceResponse({ MintA: { usdPrice: 2 } }, 200));

    await expect(fetchPricesIn("sandbox", env, ["MintA"])).resolves.toEqual(new Map());
    await expect(fetchPricesIn("sandbox", env, ["MintA"])).resolves.toEqual(
      new Map([["MintA", 2]])
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("sends one request for two callers pricing the same mint at once", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => priceResponse({ MintA: { usdPrice: 2 } }, 200));

    const [first, second] = await Promise.all([
      fetchPricesIn("sandbox", env, ["MintA"]),
      fetchPricesIn("sandbox", env, ["MintA"]),
    ]);

    expect(first).toEqual(new Map([["MintA", 2]]));
    expect(second).toEqual(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("prices a mint again on another cluster instead of reusing the first cluster's price", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(priceResponse({ MintA: { usdPrice: 2 } }, 200))
      .mockResolvedValueOnce(priceResponse({ MintA: { usdPrice: 3 } }, 200));

    const pricesByEnvironment: Map<string, number>[] = [];
    for (const { environment } of ENVIRONMENT_CLUSTER_CASES) {
      pricesByEnvironment.push(await fetchPricesIn(environment, env, ["MintA"]));
    }

    expect(pricesByEnvironment).toEqual([new Map([["MintA", 2]]), new Map([["MintA", 3]])]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
