import { runInClusterScope } from "@sdp/rpc/scope";
import {
  CLUSTER_BY_SDP_ENVIRONMENT,
  type SdpEnvironment,
  type SolanaCluster,
  WELL_KNOWN_TOKENS,
} from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import {
  attachTokenSymbolsToBalances,
  attachUsdValuesToBalances,
  clearHeliusDasCachesForTests,
} from "@/services/helius-das.service";
import { clearJupiterPriceCacheForTests } from "@/services/jupiter-price.service";
import { ENVIRONMENT_CLUSTER_CASES } from "@/test/helpers/cluster-rpc";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const TEST_ORG_ID = "org_helius_das";
const TEST_USER_ID = "usr_helius_das";
const TEST_PROJECT_ID = "prj_helius_das";
const TEST_STABLE_MINT = "GnaWvQYgS4xypWoqA3xPgHMFxr2iGnWhEEjF6HEdutBa";
const TEST_DAS_MINT = "DasC1usterMint11111111111111111111111111111";
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
  beforeEach(async () => {
    await seedTestDatabase(env);
    vi.stubEnv("SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL", HELIUS_DAS_URL_BY_CLUSTER.devnet);
    vi.stubEnv("SOLANA_RPC_HELIUS_MAINNET_API_KEY_URL", HELIUS_DAS_URL_BY_CLUSTER["mainnet-beta"]);

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
      ids: { sandbox: TEST_PROJECT_ID, production: `${TEST_PROJECT_ID}_production` },
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
    vi.unstubAllEnvs();
  });

  it("prices a Sandbox-issued stablecoin at one USD under the sandbox scope only", async () => {
    const balance = {
      token: "TEST",
      mint: TEST_STABLE_MINT,
      amount: "12500000",
      uiAmount: "12.5",
      decimals: 6,
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({}));

    const sandboxBalances = await inScope("sandbox", () =>
      attachUsdValuesToBalances(env, [balance])
    );

    expect(sandboxBalances).toEqual([{ ...balance, usdPrice: 1, usdValue: 12.5 }]);
    expect(fetchSpy).not.toHaveBeenCalled();

    const productionBalances = await inScope("production", () =>
      attachUsdValuesToBalances(env, [balance])
    );

    expect(productionBalances).toEqual([balance]);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("prices the built-in USDC when the issued stablecoin lookup fails", async () => {
    const usdcMint = WELL_KNOWN_TOKENS.USDC.mints[CLUSTER_BY_SDP_ENVIRONMENT.sandbox];
    const usdcBalance = {
      token: WELL_KNOWN_TOKENS.USDC.symbol,
      mint: usdcMint.address,
      amount: "3000000",
      uiAmount: "3",
      decimals: usdcMint.decimals,
    };
    const issuedBalance = {
      token: "TEST",
      mint: TEST_STABLE_MINT,
      amount: "12500000",
      uiAmount: "12.5",
      decimals: 6,
    };
    const db = getDb(env);
    const statement = db.prepare("SELECT 1");
    vi.spyOn(statement, "bind").mockReturnValue(statement);
    vi.spyOn(statement, "all").mockRejectedValue(new Error("database unavailable"));
    vi.spyOn(db, "prepare").mockReturnValue(statement);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}));

    const balances = await inScope("sandbox", () =>
      attachUsdValuesToBalances(env, [usdcBalance, issuedBalance])
    );

    expect(balances).toEqual([{ ...usdcBalance, usdPrice: 1, usdValue: 3 }, issuedBalance]);
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
