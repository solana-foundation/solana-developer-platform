import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import { fetchJupiterUsdPrices } from "./jupiter-price.service";

const env = {} as Env;

function priceResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchJupiterUsdPrices", () => {
  it("reads usdPrice per mint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      priceResponse({
        MintA: { usdPrice: 1.0001, decimals: 6 },
        MintB: { usdPrice: 74.19, decimals: 9 },
      })
    );

    const prices = await fetchJupiterUsdPrices(env, ["MintA", "MintB"]);

    expect(prices.get("MintA")).toBeCloseTo(1.0001);
    expect(prices.get("MintB")).toBeCloseTo(74.19);
  });

  it("omits a mint Jupiter could not price rather than pricing it at zero", async () => {
    // Jupiter drops unreliable mints from the object entirely: no key, no null, no error.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(priceResponse({ MintA: { usdPrice: 2 } }));

    const prices = await fetchJupiterUsdPrices(env, ["MintA", "MintUnknown"]);

    expect(prices.get("MintA")).toBe(2);
    expect(prices.has("MintUnknown")).toBe(false);
  });

  it("returns an empty map instead of throwing when the request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    await expect(fetchJupiterUsdPrices(env, ["MintA"])).resolves.toEqual(new Map());
  });

  it("returns an empty map on a non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(priceResponse({}, 429));

    await expect(fetchJupiterUsdPrices(env, ["MintA"])).resolves.toEqual(new Map());
  });

  it("ignores non-numeric and negative prices", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      priceResponse({
        MintA: { usdPrice: "1.5" },
        MintB: { usdPrice: -3 },
        MintC: { usdPrice: Number.NaN },
        MintD: null,
      })
    );

    await expect(fetchJupiterUsdPrices(env, ["MintA", "MintB", "MintC", "MintD"])).resolves.toEqual(
      new Map()
    );
  });

  it("chunks large mint lists and merges the results", async () => {
    const mints = Array.from({ length: 120 }, (_, index) => `Mint${index}`);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const ids = new URL(url).searchParams.get("ids")?.split(",") ?? [];
      return priceResponse(Object.fromEntries(ids.map((id) => [id, { usdPrice: 1 }])));
    });

    const prices = await fetchJupiterUsdPrices(env, mints);

    // 120 mints at 50 per request.
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
      const url = typeof input === "string" ? input : (input as Request).url;
      const ids = new URL(url).searchParams.get("ids")?.split(",") ?? [];
      return priceResponse(Object.fromEntries(ids.map((id) => [id, { usdPrice: 5 }])));
    });

    const prices = await fetchJupiterUsdPrices(env, mints);

    expect(prices.size).toBe(10);
  });

  it("sends the api key only when one is configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(priceResponse({}));

    await fetchJupiterUsdPrices(env, ["MintA"]);
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toBeUndefined();

    await fetchJupiterUsdPrices(
      { JUPITER_PRICE_API_URL: "https://api.jup.ag/price/v3", JUPITER_PRICE_API_KEY: "k" } as Env,
      ["MintA"]
    );
    const [url, init] = fetchSpy.mock.calls[1] ?? [];
    expect(String(url)).toContain("https://api.jup.ag/price/v3");
    expect(init?.headers).toEqual({ "x-api-key": "k" });
  });

  it("makes no request when there is nothing to price", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(fetchJupiterUsdPrices(env, ["", "   "])).resolves.toEqual(new Map());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
