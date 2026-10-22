import { runInClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import { type SolanaCluster, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachTokenSymbolsToBalances,
  attachUsdValuesToBalances,
  clearHeliusDasCachesForTests,
} from "@/services/helius-das.service";
import { clearJupiterPriceCacheForTests } from "@/services/jupiter-price.service";
import { ENVIRONMENT_CLUSTER_CASES } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";

const TEST_DAS_MINT = "DasC1usterMint11111111111111111111111111111";
const TEST_LOOKALIKE_USDC_MINT = "FakeUsdcMint1111111111111111111111111111111";
const HELIUS_DAS_URL_BY_CLUSTER = {
  devnet: "https://devnet.helius-das.sdp.test/?api-key=devnet",
  "mainnet-beta": "https://mainnet.helius-das.sdp.test/?api-key=mainnet",
} as const satisfies Record<SolanaCluster, string>;

function inScope<TResult>(
  environment: SdpEnvironment,
  operation: () => Promise<TResult>
): Promise<TResult> {
  return runInClusterScope({ projectId: null, environment }, operation);
}

describe("helius-das service", () => {
  beforeEach(() => {
    vi.stubEnv("SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL", HELIUS_DAS_URL_BY_CLUSTER.devnet);
    vi.stubEnv("SOLANA_RPC_HELIUS_MAINNET_API_KEY_URL", HELIUS_DAS_URL_BY_CLUSTER["mainnet-beta"]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    clearHeliusDasCachesForTests();
    clearJupiterPriceCacheForTests();
    vi.unstubAllEnvs();
  });

  it("prices USDC at Jupiter's quote and leaves a lookalike USDC mint unpriced", async () => {
    const usdcMint = WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"];
    const usdcBalance = {
      token: WELL_KNOWN_TOKENS.USDC.symbol,
      mint: usdcMint.address,
      amount: "12500000",
      uiAmount: "12.5",
      decimals: usdcMint.decimals,
    };
    const lookalikeBalance = {
      token: WELL_KNOWN_TOKENS.USDC.symbol,
      mint: TEST_LOOKALIKE_USDC_MINT,
      amount: "3000000",
      uiAmount: "3",
      decimals: 6,
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ [usdcMint.address]: { usdPrice: 0.9998, decimals: usdcMint.decimals } })
    );

    const balances = await inScope("production", () =>
      attachUsdValuesToBalances(env, [usdcBalance, lookalikeBalance])
    );

    expect(balances).toEqual([
      { ...usdcBalance, usdPrice: 0.9998, usdValue: 12.4975 },
      lookalikeBalance,
    ]);
  });

  it("attaches DAS symbols to unlabeled token balances", async () => {
    const mint = "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        result: [
          {
            id: mint,
            content: { metadata: { symbol: "EURC" } },
            token_info: {
              symbol: "EURC",
            },
          },
        ],
      })
    );

    const balances = await inScope("sandbox", () =>
      attachTokenSymbolsToBalances([
        {
          token: mint,
          mint,
          amount: "20000000",
          uiAmount: "20",
          decimals: 6,
        },
      ])
    );

    expect(balances[0]).toMatchObject({
      token: "EURC",
      mint,
      amount: "20000000",
      uiAmount: "20",
      decimals: 6,
    });
  });

  it("looks a symbol up once an hour, and again after a failed lookup", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const mint = "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr";
    const balance = { token: mint, mint, amount: "20000000", uiAmount: "20", decimals: 6 };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("helius down"))
      .mockImplementation(async () =>
        Response.json({ result: [{ id: mint, token_info: { symbol: "EURC" } }] })
      );

    expect(await inScope("sandbox", () => attachTokenSymbolsToBalances([balance]))).toEqual([
      balance,
    ]);
    expect(await inScope("sandbox", () => attachTokenSymbolsToBalances([balance]))).toEqual([
      { ...balance, token: "EURC" },
    ]);
    vi.advanceTimersByTime(59 * 60_000);
    expect(await inScope("sandbox", () => attachTokenSymbolsToBalances([balance]))).toEqual([
      { ...balance, token: "EURC" },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(60_000);
    await inScope("sandbox", () => attachTokenSymbolsToBalances([balance]));
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("keeps configured token labels even when they are long", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const mint = "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr";

    const balances = await inScope("sandbox", () =>
      attachTokenSymbolsToBalances([
        {
          token: "INSTITUTIONALUSD",
          mint,
          amount: "20000000",
          uiAmount: "20",
          decimals: 6,
        },
      ])
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(balances[0]).toMatchObject({
      token: "INSTITUTIONALUSD",
      mint,
    });
  });

  it("looks a mint's symbol up on each cluster's Helius endpoint instead of reusing one answer", async () => {
    const balance = {
      token: TEST_DAS_MINT,
      mint: TEST_DAS_MINT,
      amount: "20000000",
      uiAmount: "20",
      decimals: 6,
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ result: [{ id: TEST_DAS_MINT, token_info: { symbol: "DEVEUR" } }] })
      )
      .mockResolvedValueOnce(
        Response.json({ result: [{ id: TEST_DAS_MINT, token_info: { symbol: "MAINEUR" } }] })
      );

    const labeledByEnvironment: Awaited<ReturnType<typeof attachTokenSymbolsToBalances>>[] = [];
    for (const { environment } of ENVIRONMENT_CLUSTER_CASES) {
      labeledByEnvironment.push(
        await inScope(environment, () => attachTokenSymbolsToBalances([balance]))
      );
    }

    expect(labeledByEnvironment).toEqual([
      [{ ...balance, token: "DEVEUR" }],
      [{ ...balance, token: "MAINEUR" }],
    ]);
    expect(fetchSpy.mock.calls.map(([input]) => input)).toEqual(
      ENVIRONMENT_CLUSTER_CASES.map(({ cluster }) => HELIUS_DAS_URL_BY_CLUSTER[cluster])
    );
  });
});
