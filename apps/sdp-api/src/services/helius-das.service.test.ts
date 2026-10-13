import { runInClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  attachTokenSymbolsToBalances,
  attachUsdValuesToBalances,
  clearHeliusDasCachesForTests,
  getTrackedWalletBalancesByOwner,
} from "@/services/helius-das.service";
import { clearJupiterPriceCacheForTests } from "@/services/jupiter-price.service";
import { CLUSTER_RPC_URLS, installClusterRpcStub } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const TEST_ORG_ID = "org_helius_das";
const TEST_USER_ID = "usr_helius_das";
const TEST_PROJECT_ID = "prj_helius_das";
const TEST_STABLE_MINT = "GnaWvQYgS4xypWoqA3xPgHMFxr2iGnWhEEjF6HEdutBa";
const TEST_OWNER = "AENLi9e2XHK7fnMmEqHbPCADPjRPV4n3DxuWbMcBbxK9";
const TEST_UNLABELED_MINT = "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr";

const PROJECT_ID_BY_ENVIRONMENT = {
  sandbox: TEST_PROJECT_ID,
  production: `${TEST_PROJECT_ID}_production`,
} as const satisfies Record<SdpEnvironment, string>;

function inScope<TResult>(environment: SdpEnvironment, operation: () => Promise<TResult>) {
  return runInClusterScope(
    { projectId: PROJECT_ID_BY_ENVIRONMENT[environment], environment },
    operation
  );
}

function onDevnet<TResult>(operation: () => Promise<TResult>) {
  return inScope("sandbox", operation);
}

describe("helius-das service", () => {
  const rpc = installClusterRpcStub();

  function getAssetBatchCalls() {
    return rpc.calls.filter((call) => call.method === "getAssetBatch");
  }

  beforeEach(async () => {
    vi.stubEnv("SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL", CLUSTER_RPC_URLS.devnet);
    await seedTestDatabase(env);

    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(TEST_ORG_ID, "Helius DAS Org", "helius-das-org", "individual", "active"),
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
        .bind(TEST_USER_ID, "helius-das@example.com", 1, "active"),
    ]);
    await seedDefaultProjects(getDb(env), {
      organizationId: TEST_ORG_ID,
      createdBy: TEST_USER_ID,
      members: [],
      ids: PROJECT_ID_BY_ENVIRONMENT,
    });
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO issued_tokens
             (id, project_id, organization_id, mint_address, name, symbol, decimals, template, status, deployed_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          "tok_helius_das_stable",
          TEST_PROJECT_ID,
          TEST_ORG_ID,
          TEST_STABLE_MINT,
          "Test Stable",
          "TEST",
          6,
          "stablecoin",
          "active",
          "2026-03-19T00:00:00.000Z",
          TEST_USER_ID
        ),
    ]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    clearHeliusDasCachesForTests();
    clearJupiterPriceCacheForTests();
  });

  it("prices issued stablecoins at one USD each", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const balances = await onDevnet(() =>
      attachUsdValuesToBalances(env, [
        {
          token: "TEST",
          mint: TEST_STABLE_MINT,
          amount: "12500000",
          uiAmount: "12.5",
          decimals: 6,
        },
      ])
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(balances[0]).toMatchObject({
      token: "TEST",
      mint: TEST_STABLE_MINT,
      usdPrice: 1,
      usdValue: 12.5,
    });
  });

  it("tracks issued stablecoins in Helius owner balance results", async () => {
    rpc.answer("searchAssets", {
      items: [
        {
          id: TEST_STABLE_MINT,
          content: { metadata: { symbol: "TEST" } },
          token_info: {
            mint: TEST_STABLE_MINT,
            amount: "3000000",
            decimals: 6,
            uiAmountString: "3.0",
          },
        },
      ],
    });

    const balancesByOwner = await onDevnet(() =>
      getTrackedWalletBalancesByOwner(env, [TEST_OWNER])
    );

    expect(balancesByOwner.get(TEST_OWNER)).toEqual([
      {
        token: "TEST",
        mint: TEST_STABLE_MINT,
        amount: "3000000",
        uiAmount: "3.0",
        decimals: 6,
      },
    ]);
  });

  it("attaches DAS symbols to unlabeled token balances", async () => {
    const mint = TEST_UNLABELED_MINT;
    rpc.answer("getAssetBatch", [
      {
        id: mint,
        content: { metadata: { symbol: "EURC" } },
        token_info: {
          symbol: "EURC",
        },
      },
    ]);

    const balances = await onDevnet(() =>
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

  it("passes balances through unchanged when the scope's cluster has no Helius URL", async () => {
    vi.stubEnv("SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL", "");
    const balances = [
      {
        token: TEST_UNLABELED_MINT,
        mint: TEST_UNLABELED_MINT,
        amount: "20000000",
        uiAmount: "20",
        decimals: 6,
      },
    ];

    expect(await onDevnet(() => attachTokenSymbolsToBalances(balances))).toEqual(balances);
    expect(rpc.calls).toEqual([]);
  });

  it("looks a symbol up again on mainnet-beta after learning it on devnet", async () => {
    vi.stubEnv("SOLANA_RPC_HELIUS_MAINNET_API_KEY_URL", CLUSTER_RPC_URLS["mainnet-beta"]);
    const balance = {
      token: TEST_UNLABELED_MINT,
      mint: TEST_UNLABELED_MINT,
      amount: "20000000",
      uiAmount: "20",
      decimals: 6,
    };
    rpc.answer("getAssetBatch", [{ id: TEST_UNLABELED_MINT, token_info: { symbol: "EURC" } }]);

    await onDevnet(() => attachTokenSymbolsToBalances([balance]));
    await inScope("production", () => attachTokenSymbolsToBalances([balance]));

    expect(getAssetBatchCalls().map((call) => call.cluster)).toEqual(["devnet", "mainnet-beta"]);
  });

  it("looks a symbol up once an hour, and again after a failed lookup", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const mint = TEST_UNLABELED_MINT;
    const balance = { token: mint, mint, amount: "20000000", uiAmount: "20", decimals: 6 };
    const labelOnDevnet = () => onDevnet(() => attachTokenSymbolsToBalances([balance]));

    expect((await labelOnDevnet())[0]?.token).toBe(mint);
    rpc.answer("getAssetBatch", [{ id: mint, token_info: { symbol: "EURC" } }]);
    expect((await labelOnDevnet())[0]?.token).toBe("EURC");
    vi.advanceTimersByTime(59 * 60_000);
    expect((await labelOnDevnet())[0]?.token).toBe("EURC");
    expect(getAssetBatchCalls()).toHaveLength(2);

    vi.advanceTimersByTime(60_000);
    await labelOnDevnet();
    expect(getAssetBatchCalls()).toHaveLength(3);
  });

  it("keeps configured token labels even when they are long", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const mint = TEST_UNLABELED_MINT;

    const balances = await onDevnet(() =>
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
});
