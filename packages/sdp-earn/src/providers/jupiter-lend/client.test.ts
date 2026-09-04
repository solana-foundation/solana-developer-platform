import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { SdpEarnError } from "../../errors";
import type { EarnRuntimeContext } from "../../types";
import { JUPITER_LEND_USDT_MINT, JupiterLendEarnClient, jupiterRateFromBps } from "./client";

const ctx: EarnRuntimeContext = { environment: "production", env: {} };
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => mock.restoreAll());

describe("JupiterLendEarnClient", () => {
  it("catalogues only the exact mainnet USDT earn market", async () => {
    mock.method(globalThis, "fetch", async () =>
      response([
        {
          address: "Cmn4v2wipYV41dkakDvCgFJpxhtaaKt11NyWV8pjSE8A",
          assetAddress: JUPITER_LEND_USDT_MINT,
          decimals: 6,
          totalAssets: "17848613702332",
          totalRate: 418,
        },
        {
          address: "ignored",
          assetAddress: "So11111111111111111111111111111111111111112",
          decimals: 9,
          totalAssets: "1",
          totalRate: 9999,
        },
      ])
    );

    assert.deepEqual(await new JupiterLendEarnClient().listStrategies(ctx), [
      {
        providerReference: JUPITER_LEND_USDT_MINT,
        name: "Jupiter Lend USDT",
        sourceKind: "defi",
        underlyingSource: "Jupiter Lend",
        depositMints: [JUPITER_LEND_USDT_MINT],
        shareMint: "Cmn4v2wipYV41dkakDvCgFJpxhtaaKt11NyWV8pjSE8A",
        hostCluster: "mainnet-beta",
        apyType: "variable",
        currentApy: "0.0418",
        liquidityTerm: "instant",
        riskMetadata: { curator: "jupiter", tvlUsd: 17_848_613.702332 },
      },
    ]);
  });

  it("never calls the mainnet-only API for a sandbox pass", async () => {
    const fetch = mock.method(globalThis, "fetch", async () => response([]));
    assert.deepEqual(
      await new JupiterLendEarnClient().listStrategies({ environment: "sandbox", env: {} }),
      []
    );
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("returns an empty shelf when Jupiter no longer lists USDT", async () => {
    mock.method(globalThis, "fetch", async () => response([]));
    assert.deepEqual(await new JupiterLendEarnClient().listStrategies(ctx), []);
  });

  it("fails closed on a malformed USDT identity", async () => {
    mock.method(globalThis, "fetch", async () =>
      response([{ assetAddress: JUPITER_LEND_USDT_MINT, address: "", decimals: 6 }])
    );
    await assert.rejects(
      new JupiterLendEarnClient().listStrategies(ctx),
      (error) => error instanceof SdpEarnError && error.code === "PROVIDER_UNAVAILABLE"
    );
  });

  it("fails closed when Jupiter reports a different lending-token mint", async () => {
    mock.method(globalThis, "fetch", async () =>
      response([
        {
          assetAddress: JUPITER_LEND_USDT_MINT,
          address: "11111111111111111111111111111111",
          decimals: 6,
        },
      ])
    );
    await assert.rejects(
      new JupiterLendEarnClient().listStrategies(ctx),
      (error) => error instanceof SdpEarnError && error.code === "PROVIDER_UNAVAILABLE"
    );
  });

  it("refreshes only volatile metrics", async () => {
    mock.method(globalThis, "fetch", async () =>
      response([
        {
          address: "Cmn4v2wipYV41dkakDvCgFJpxhtaaKt11NyWV8pjSE8A",
          assetAddress: JUPITER_LEND_USDT_MINT,
          decimals: 6,
          totalAssets: "2000000",
          totalRate: "7",
        },
      ])
    );
    assert.deepEqual(await new JupiterLendEarnClient().listStrategyMetrics(ctx), [
      {
        providerReference: JUPITER_LEND_USDT_MINT,
        currentApy: "0.0007",
        riskMetadata: { tvlUsd: 2 },
      },
    ]);
  });
});

describe("jupiterRateFromBps", () => {
  it("converts basis points exactly", () => {
    assert.equal(jupiterRateFromBps(418), "0.0418");
    assert.equal(jupiterRateFromBps(7), "0.0007");
    assert.equal(jupiterRateFromBps(10_000), "1");
    assert.equal(jupiterRateFromBps(0), "0");
    assert.equal(jupiterRateFromBps(`${"0".repeat(100_000)}418`), "0.0418");
  });

  it("refuses invalid values", () => {
    for (const value of [-1, 1.5, "1.5", "", Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(jupiterRateFromBps(value), undefined);
    }
  });
});
