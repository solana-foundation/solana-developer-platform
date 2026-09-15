import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { SdpEarnError } from "../../errors";
import { ONDO_ASSETS_API_URL, ondoPercentToDecimalString, readOndoUsdyRate } from "./usdy-rate";

/**
 * No-network harness: `globalThis.fetch` answers the one GET the reader makes.
 * The fixture is the live body of `ondo.finance/api/v1/assets` as read on
 * 2026-09-15 (trimmed), so the expected figure is the one ondo.finance shows.
 */

const LIVE_BODY = {
  timestamp: "2026-09-15T19:01:39Z",
  assets: [
    {
      symbol: "usdy",
      name: "Ondo US Dollar Yield",
      priceUsd: 1.14629994,
      apy: 3.5999629806,
      tvlUsd: { total: 2237610887.16, ethereum: 1199748173.21, solana: 179668490.6 },
    },
    {
      symbol: "ousg",
      name: "Ondo Short-Term US Treasuries Fund",
      priceUsd: 116.561029,
      apy: 3.45,
      tvlUsd: { total: 330669479.55, ethereum: 139521113.2 },
    },
  ],
};

function stubAssets(body: unknown, status = 200) {
  const seen: { url: string; method: string | undefined }[] = [];
  mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), method: init?.method });
    return status === 200
      ? Response.json(body)
      : new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
  });
  return seen;
}

afterEach(() => {
  mock.restoreAll();
});

describe("ondoPercentToDecimalString", () => {
  it("shifts the API's percent two places and truncates to six, never rounding up", () => {
    assert.equal(ondoPercentToDecimalString(3.5999629806), "0.035999");
    assert.equal(ondoPercentToDecimalString(3.45), "0.0345");
    assert.equal(ondoPercentToDecimalString(5), "0.05");
    assert.equal(ondoPercentToDecimalString(0.00001), "0");
    assert.equal(ondoPercentToDecimalString(100), "1");
    assert.equal(ondoPercentToDecimalString(0), "0");
  });

  it("refuses anything that is not a finite non-negative number", () => {
    for (const bad of ["3.6", -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      assert.throws(() => ondoPercentToDecimalString(bad), SdpEarnError);
    }
  });
});

describe("readOndoUsdyRate", () => {
  it("reads the usdy entry with one keyless GET", async () => {
    const seen = stubAssets(LIVE_BODY);
    const rate = await readOndoUsdyRate();

    assert.deepEqual(rate, { currentApy: "0.035999", solanaTvlUsd: 179668490.6 });
    assert.deepEqual(seen, [{ url: ONDO_ASSETS_API_URL, method: "GET" }]);
  });

  it("omits the TVL when the API does not report a Solana figure", async () => {
    stubAssets({
      assets: [{ symbol: "USDY", apy: 3.6, tvlUsd: { total: 1 } }],
    });
    assert.deepEqual(await readOndoUsdyRate(), { currentApy: "0.036" });
  });

  it("fails when usdy is missing from the listing (never a fabricated rate)", async () => {
    stubAssets({ assets: [{ symbol: "ousg", apy: 3.45 }] });
    await assert.rejects(
      readOndoUsdyRate(),
      (error: unknown) => error instanceof SdpEarnError && error.code === "INTERNAL_ERROR"
    );
  });

  it("fails when the apy field is malformed", async () => {
    stubAssets({ assets: [{ symbol: "usdy", apy: "3.6" }] });
    await assert.rejects(
      readOndoUsdyRate(),
      (error: unknown) => error instanceof SdpEarnError && error.code === "INTERNAL_ERROR"
    );
  });

  it("surfaces a rate limit as RATE_LIMITED so the pass fails and the next hour retries", async () => {
    stubAssets({ error: "too many requests" }, 429);
    await assert.rejects(
      readOndoUsdyRate(),
      (error: unknown) => error instanceof SdpEarnError && error.code === "RATE_LIMITED"
    );
  });

  it("surfaces an HTTP failure as a provider error", async () => {
    stubAssets({ error: "upstream" }, 502);
    await assert.rejects(readOndoUsdyRate(), (error: unknown) => error instanceof SdpEarnError);
  });
});
