import { runInClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as moneyPathEvents from "@/runtime/money-path-events";
import * as priceStore from "@/services/display-price-store";
import type { DisplayPrice } from "@/services/tokens-xyz-price-client";
import { tokensPriceRow } from "@/test/helpers/display-prices";
import { required } from "@/test/helpers/required";
import type { Env } from "@/types/env";
import { clearDisplayPriceCacheForTests, fetchDisplayUsdPrices } from "./display-price.service";

const store = {
  lookup: vi.fn<priceStore.DisplayPriceStore["lookup"]>(async (mints, owner) => ({
    prices: new Map<string, DisplayPrice>(),
    claimed: owner ? mints : [],
    pending: [],
  })),
  admitRequest: vi.fn<priceStore.DisplayPriceStore["admitRequest"]>(async () => true),
  backOff: vi.fn<priceStore.DisplayPriceStore["backOff"]>(async () => undefined),
  complete: vi.fn<priceStore.DisplayPriceStore["complete"]>(async () => undefined),
};

beforeEach(() => {
  vi.spyOn(priceStore, "createDisplayPriceStore").mockReturnValue(store);
  store.lookup.mockReset().mockImplementation(async (mints, owner) => ({
    prices: new Map<string, DisplayPrice>(),
    claimed: owner ? mints : [],
    pending: [],
  }));
  store.admitRequest.mockReset().mockResolvedValue(true);
  store.backOff.mockReset().mockResolvedValue(undefined);
  store.complete.mockReset().mockResolvedValue(undefined);
});

const env: Env = {
  ENVIRONMENT: "development",
  API_VERSION: "v1",
  TOKENS_XYZ_API_KEY: "test-tokens-key",
};
const MAX_AGE_MS = 2 * 60 * 60_000;

function prices(mints: string[], priceEnv: Env = env, environment: SdpEnvironment = "production") {
  return runInClusterScope({ projectId: null, environment }, () =>
    fetchDisplayUsdPrices(priceEnv, mints)
  );
}

const mintRequestSchema = z.object({ mints: z.array(z.string()) });

function requestedMints(init: RequestInit | undefined): string[] {
  return mintRequestSchema.parse(JSON.parse(String(required(init).body))).mints;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearDisplayPriceCacheForTests();
});

describe("Tokens display prices", () => {
  it("makes no upstream request when shared coordination is unavailable", async () => {
    store.lookup.mockRejectedValue(new Error("Redis unavailable"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await prices(["A"])).toEqual(new Map());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("waits for a different replica's result without sending a duplicate request", async () => {
    const value: DisplayPrice = {
      kind: "priced",
      usdPrice: 2,
      snapshotFetchedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    store.lookup
      .mockResolvedValueOnce({ prices: new Map(), claimed: [], pending: ["A"] })
      .mockResolvedValueOnce({ prices: new Map([["A", value]]), claimed: [], pending: [] });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await prices(["A"])).toEqual(new Map([["A", 2]]));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.lookup).toHaveBeenLastCalledWith(["A"], null);
  });

  it("uses one fixed authenticated Tokens endpoint and preserves depeg prices", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json([tokensPriceRow("USDC", 0.92), tokensPriceRow("SOL", 101)]));

    expect(await prices(["USDC", "SOL"])).toEqual(
      new Map([
        ["USDC", 0.92],
        ["SOL", 101],
      ])
    );
    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(
      "https://api.tokens.xyz/v1/assets/market-snapshots",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "test-tokens-key" },
        body: JSON.stringify({ mints: ["USDC", "SOL"] }),
        redirect: "error",
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("reports a missing key once per minute without sending anonymous requests", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const log = vi.spyOn(moneyPathEvents, "logEvent").mockImplementation(() => undefined);
    const unconfigured = { ...env, TOKENS_XYZ_API_KEY: "  " };

    expect(await prices(["MintA"], unconfigured)).toEqual(new Map());
    await prices(["MintB"], unconfigured);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith("warn", {
      event: "sdp_price_config_missing",
      vendor: "tokens-xyz",
    });
    vi.advanceTimersByTime(60_000);
    await prices(["MintA"], unconfigured);
    expect(log).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("trims the key and never caches missing configuration", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json([tokensPriceRow("A", 2)]));
    await prices(["A"], { ...env, TOKENS_XYZ_API_KEY: undefined });
    expect(await prices(["A"], { ...env, TOKENS_XYZ_API_KEY: " key " })).toEqual(
      new Map([["A", 2]])
    );
    expect(required(fetchSpy.mock.calls[0])[1]?.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": "key",
    });
  });

  it("caches confirmed absences while retrying omitted mints", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json([tokensPriceRow("A", 2), { address: "B", hasMarket: false, token: null }])
      )
      .mockResolvedValueOnce(Response.json([tokensPriceRow("B", 3), tokensPriceRow("C", 4)]));

    expect(await prices(["A", "B", "C"])).toEqual(new Map([["A", 2]]));
    expect(await prices(["A", "B", "C"])).toEqual(
      new Map([
        ["A", 2],
        ["C", 4],
      ])
    );
    expect(requestedMints(required(fetchSpy.mock.calls[1])[1])).toEqual(["C"]);
  });

  it.each([
    { name: "no market", hasMarket: false, token: tokensPriceRow("A", 2).token },
    { name: "null token", hasMarket: true, token: null },
    { name: "no market and null token", hasMarket: false, token: null },
  ])("caches $name for 60 seconds across repeated wallet reads", async ({ hasMarket, token }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json([{ address: "A", hasMarket, token }]))
      .mockImplementation(async () => Response.json([tokensPriceRow("A", 3)]));
    const log = vi.spyOn(moneyPathEvents, "logEvent").mockImplementation(() => undefined);

    expect(await prices(["A"])).toEqual(new Map());
    const repeated = await Promise.all(Array.from({ length: 100 }, () => prices(["A"])));
    expect(repeated.every((result) => result.size === 0)).toBe(true);
    vi.advanceTimersByTime(59_999);
    expect(await prices(["A"])).toEqual(new Map());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(store.admitRequest).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "info",
      expect.objectContaining({
        event: "sdp_api_vendor_call",
        priced_count: 0,
        unpriced_count: 1,
        confirmed_missing_count: 1,
      })
    );
    vi.advanceTimersByTime(1);
    expect(await prices(["A"])).toEqual(new Map([["A", 3]]));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("preserves a shared confirmed absence's original expiry in the local cache", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    store.lookup.mockResolvedValueOnce({
      prices: new Map([["A", { kind: "missing", expiresAt: Date.now() + 1_000 }]]),
      claimed: [],
      pending: [],
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json([tokensPriceRow("A", 2)]));

    expect(await prices(["A"])).toEqual(new Map());
    vi.advanceTimersByTime(999);
    expect(await prices(["A"])).toEqual(new Map());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.lookup).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(await prices(["A"])).toEqual(new Map([["A", 2]]));
  });

  it.each([0, -1, "1.5", null, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid price (%s) without discarding other mints",
    async (price) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        Response.json([
          {
            address: "A",
            hasMarket: true,
            token: { address: "A", price, lastFetchedAt: Date.now() },
          },
          tokensPriceRow("B", 2),
        ])
      );
      expect(await prices(["A", "B"])).toEqual(new Map([["B", 2]]));
      fetchSpy.mockResolvedValueOnce(Response.json([tokensPriceRow("A", 3)]));
      expect(await prices(["A", "B"])).toEqual(
        new Map([
          ["A", 3],
          ["B", 2],
        ])
      );
    }
  );

  it("rejects mismatched, unexpected and duplicate rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json([
        { ...tokensPriceRow("A", 2), token: tokensPriceRow("B", 2).token },
        tokensPriceRow("Extra", 2),
        tokensPriceRow("C", 2),
        tokensPriceRow("C", 3),
        tokensPriceRow("D", 4),
      ])
    );
    expect(await prices(["A", "C", "D"])).toEqual(new Map([["D", 4]]));
  });

  it.each(["price first", "missing first", "both missing"] as const)(
    "does not cache duplicate confirmed absences (%s)",
    async (order) => {
      const missing = { address: "A", hasMarket: false, token: null };
      const positive = tokensPriceRow("A", 2);
      const rows = {
        "price first": [positive, missing],
        "missing first": [missing, positive],
        "both missing": [missing, missing],
      };
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(Response.json(rows[order]))
        .mockResolvedValueOnce(Response.json([positive]));

      expect(await prices(["A"])).toEqual(new Map());
      expect(await prices(["A"])).toEqual(new Map([["A", 2]]));
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    }
  );

  it("rejects snapshots with missing, old or future timestamps", async () => {
    const now = Date.now();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json([
        { address: "Unknown", hasMarket: true, token: { address: "Unknown", price: 2 } },
        tokensPriceRow("Old", 2, now - MAX_AGE_MS - 1),
        tokensPriceRow("Future", 2, now + 120_000),
        tokensPriceRow("Fresh", 2, now - 60_000),
        { ...tokensPriceRow("NoMarket", 2), hasMarket: false },
      ])
    );
    expect(await prices(["Unknown", "Old", "Future", "Fresh", "NoMarket"])).toEqual(
      new Map([["Fresh", 2]])
    );
  });

  it("never extends snapshot eligibility through the 60 second cache", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json([tokensPriceRow("A", 2, Date.now() - MAX_AGE_MS + 1_000)]));
    expect(await prices(["A"])).toEqual(new Map([["A", 2]]));
    vi.advanceTimersByTime(2_000);
    expect(await prices(["A"])).toEqual(new Map());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("reuses valid snapshots for 60 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json([tokensPriceRow("A", 2)]));
    await prices(["A"]);
    vi.advanceTimersByTime(59_000);
    expect(await prices(["A"])).toEqual(new Map([["A", 2]]));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    await prices(["A"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("batches 250 unique mints per request", async () => {
    const mints = Array.from({ length: 501 }, (_, index) => `Mint${index}`);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) =>
        Response.json(requestedMints(init).map((mint) => tokensPriceRow(mint, 2)))
      );
    expect((await prices([...mints, "Mint0", "", "  Mint1  "])).size).toBe(501);
    expect(fetchSpy.mock.calls.map(([, init]) => requestedMints(init).length)).toEqual([
      250, 250, 1,
    ]);
  });

  it("shares overlapping mint requests without exposing unrequested results", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) =>
        Response.json(requestedMints(init).map((mint) => tokensPriceRow(mint, 2)))
      );
    const [first, second] = await Promise.all([prices(["A", "B"]), prices(["B", "C"])]);
    expect(first).toEqual(
      new Map([
        ["A", 2],
        ["B", 2],
      ])
    );
    expect(second).toEqual(
      new Map([
        ["B", 2],
        ["C", 2],
      ])
    );
    expect(fetchSpy.mock.calls.map(([, init]) => requestedMints(init))).toEqual([
      ["A", "B"],
      ["C"],
    ]);
  });

  it("bounds disjoint wallet requests to two active requests per process", async () => {
    let active = 0;
    let peak = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return Response.json(requestedMints(init).map((mint) => tokensPriceRow(mint, 2)));
    });
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => prices([`Mint${index}`]))
    );
    expect(results.every((result) => result.size === 1)).toBe(true);
    expect(peak).toBe(2);
  });

  it.each([401, 403, 429])(
    "backs off across lookups after HTTP %i without caching failures",
    async (status) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.spyOn(Math, "random").mockReturnValue(0);
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(null, { status }));
      expect(await prices(["A"])).toEqual(new Map());
      expect(store.backOff).toHaveBeenCalled();
      expect(store.complete.mock.calls[0]?.[2].size).toBe(0);
      store.admitRequest.mockResolvedValue(false);
      expect(await prices(["A"])).toEqual(new Map());
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      store.admitRequest.mockResolvedValue(true);
      fetchSpy.mockResolvedValue(Response.json([tokensPriceRow("A", 2)]));
      expect(await prices(["A"])).toEqual(new Map([["A", 2]]));
    }
  );

  function cacheLaterBatch() {
    const cachedMint = "Mint1000";
    const value: DisplayPrice = {
      kind: "priced",
      usdPrice: 7,
      snapshotFetchedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    store.lookup.mockImplementation(async (mints, owner) => ({
      prices: new Map(mints.includes(cachedMint) ? [[cachedMint, value]] : []),
      claimed: owner ? mints.filter((mint) => mint !== cachedMint) : [],
      pending: [],
    }));
    return Array.from({ length: 1_001 }, (_, index) => `Mint${index}`);
  }

  it("reads later shared prices after quota refusal without claiming or fetching misses", async () => {
    const mints = cacheLaterBatch();
    store.admitRequest.mockResolvedValue(false);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    expect(await prices(mints)).toEqual(new Map([["Mint1000", 7]]));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.lookup).toHaveBeenLastCalledWith(["Mint1000"], null);
    expect(store.admitRequest).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 429])(
    "reads later shared prices without upstream work after HTTP %i",
    async (status) => {
      const mints = cacheLaterBatch();
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => new Response(null, { status }));
      expect(await prices(mints)).toEqual(new Map([["Mint1000", 7]]));
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(store.lookup).toHaveBeenLastCalledWith(["Mint1000"], null);
    }
  );

  it("keeps successful independent batches when another fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockImplementation(async (_input, init) =>
        Response.json(requestedMints(init).map((mint) => tokensPriceRow(mint, 2)))
      );
    const mints = Array.from({ length: 251 }, (_, index) => `Mint${index}`);
    expect(await prices(mints)).toEqual(new Map([["Mint250", 2]]));
    expect((await prices(mints)).size).toBe(251);
  });

  it.each([
    ["invalid JSON", "{broken"],
    ["wrong envelope", JSON.stringify({ prices: [] })],
    ["too many rows", JSON.stringify(Array.from({ length: 251 }, () => tokensPriceRow("A", 2)))],
    ["oversized body", "x".repeat(1024 * 1024 + 1)],
  ])("rejects %s without breaking balances", async (_name, body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
    expect(await prices(["A"])).toEqual(new Map());
  });

  it("applies one deadline to active requests and queued wallets, then releases capacity", async () => {
    const abort = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(abort.signal);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = required(required(init).signal);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
    );
    const pending = Promise.all([prices(["A"]), prices(["B"]), prices(["C"])]);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    abort.abort(new DOMException("deadline", "TimeoutError"));
    expect(await pending).toEqual([new Map(), new Map(), new Map()]);
    expect(timeoutSpy).toHaveBeenCalledWith(4_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    timeoutSpy.mockRestore();
    fetchSpy.mockResolvedValue(Response.json([tokensPriceRow("A", 2)]));
    expect(await prices(["A"])).toEqual(new Map([["A", 2]]));
  });

  it("does not price devnet or empty input, including warm mainnet mints", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json([tokensPriceRow("A", 2)]));
    expect(await prices(["A"], env, "sandbox")).toEqual(new Map());
    expect(await prices(["", " "])).toEqual(new Map());
    expect(fetchSpy).not.toHaveBeenCalled();
    await prices(["A"]);
    expect(await prices(["A"], env, "sandbox")).toEqual(new Map());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("logs aggregate coverage without the credential, mint IDs or price values", async () => {
    const log = vi.spyOn(moneyPathEvents, "logEvent").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json([tokensPriceRow("PrivateMint", 1.234567)])
    );
    await prices(["PrivateMint"]);
    expect(log).toHaveBeenCalledWith(
      "info",
      expect.objectContaining({
        event: "sdp_api_vendor_call",
        vendor: "tokens-xyz",
        outcome: "succeeded",
        boundary: "upstream_http",
        requested_count: 1,
        priced_count: 1,
      })
    );
    const logged = JSON.stringify(log.mock.calls);
    for (const value of ["PrivateMint", "test-tokens-key", "1.234567"])
      expect(logged).not.toContain(value);
  });
});
