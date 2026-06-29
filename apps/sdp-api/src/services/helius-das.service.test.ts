import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  attachTokenSymbolsToBalances,
  attachUsdValuesToBalances,
  getTrackedWalletBalancesByOwner,
} from "@/services/helius-das.service";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";

const TEST_ORG_ID = "org_helius_das";
const TEST_USER_ID = "usr_helius_das";
const TEST_PROJECT_ID = "prj_helius_das";
const TEST_STABLE_MINT = "GnaWvQYgS4xypWoqA3xPgHMFxr2iGnWhEEjF6HEdutBa";
const TEST_OWNER = "AENLi9e2XHK7fnMmEqHbPCADPjRPV4n3DxuWbMcBbxK9";

describe("helius-das service", () => {
  const originalHeliusUrl = env.SOLANA_RPC_HELIUS_URL;
  const originalHeliusApiKey = env.SOLANA_RPC_HELIUS_API_KEY;

  beforeEach(async () => {
    await seedTestDatabase(env);
    env.SOLANA_RPC_HELIUS_URL = "https://helius.test/?api-key={API_KEY}";
    env.SOLANA_RPC_HELIUS_API_KEY = "helius_test_key";

    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(TEST_ORG_ID, "Helius DAS Org", "helius-das-org", "individual", "active"),
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
        .bind(TEST_USER_ID, "helius-das@example.com", 1, "active"),
      getDb(env)
        .prepare(
          `INSERT INTO projects
             (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          TEST_PROJECT_ID,
          TEST_ORG_ID,
          "Helius DAS Project",
          "helius-das-project",
          "sandbox",
          "active",
          TEST_USER_ID
        ),
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
    env.SOLANA_RPC_HELIUS_URL = originalHeliusUrl;
    env.SOLANA_RPC_HELIUS_API_KEY = originalHeliusApiKey;
    await clearTestDatabase(env);
  });

  it("prices issued stablecoins at one USD each", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const balances = await attachUsdValuesToBalances(env, [
      {
        token: "TEST",
        mint: TEST_STABLE_MINT,
        amount: "12500000",
        uiAmount: "12.5",
        decimals: 6,
      },
    ]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(balances[0]).toMatchObject({
      token: "TEST",
      mint: TEST_STABLE_MINT,
      usdPrice: 1,
      usdValue: 12.5,
    });
  });

  it("tracks issued stablecoins in Helius owner balance results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: {
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
        },
      }),
    } as Response);

    const balancesByOwner = await getTrackedWalletBalancesByOwner(env, [TEST_OWNER]);

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
    const mint = "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        result: [
          {
            id: mint,
            content: { metadata: { symbol: "EURC" } },
            token_info: {
              symbol: "EURC",
            },
          },
        ],
      }),
    } as Response);

    const balances = await attachTokenSymbolsToBalances(env, [
      {
        token: mint,
        mint,
        amount: "20000000",
        uiAmount: "20",
        decimals: 6,
      },
    ]);

    expect(balances[0]).toMatchObject({
      token: "EURC",
      mint,
      amount: "20000000",
      uiAmount: "20",
      decimals: 6,
    });
  });

  it("keeps configured token labels even when they are long", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const mint = "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr";

    const balances = await attachTokenSymbolsToBalances(env, [
      {
        token: "INSTITUTIONALUSD",
        mint,
        amount: "20000000",
        uiAmount: "20",
        decimals: 6,
      },
    ]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(balances[0]).toMatchObject({
      token: "INSTITUTIONALUSD",
      mint,
    });
  });
});
